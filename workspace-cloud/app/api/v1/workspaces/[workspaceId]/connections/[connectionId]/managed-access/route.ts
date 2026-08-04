// Existing managed templates may only be returned to member-local credentials here;
// new managed templates are created by the receipt-bound import route.
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import {
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../lib/http";
import { revokeActiveLeases } from "../../../../../../../../lib/provider-integrations";
import {
  claimRevocationGate,
  clearRevocationGate,
  releaseRevocationGateClaim,
  revocationGateLockKey,
} from "../../../../../../../../lib/revocation-gates";
import {
  member,
  session,
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceProviderImportRequest,
  workspaceProviderIntegration,
  workspaceProviderResource,
} from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import { publicConnection } from "../../../../../../../../lib/workspace-connections";

type RouteContext = {
  params: Promise<{ workspaceId: string; connectionId: string }>;
};

export async function PUT(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, connectionId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(connectionId)) {
    return jsonError("Invalid workspace or connection id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const connection = await db.query.workspaceConnection.findFirst({
    where: and(
      eq(workspaceConnection.id, connectionId),
      eq(workspaceConnection.organizationId, workspaceId),
      isNull(workspaceConnection.deletedAt),
    ),
  });
  if (!connection) return jsonError("Connection not found", 404);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    !body
    || Object.keys(body).length !== 1
    || body.mode !== "managed"
    && body.mode !== "member_local"
  ) {
    return jsonError("Invalid credential mode", 400);
  }
  // New managed templates are imported only through a single-use discovery
  // receipt. Accepting raw provider selectors here would recreate an external-id
  // bypass around the receipt/session/tenant binding.
  if (body.mode === "managed") {
    return jsonError("Managed provider access must be imported from a discovery receipt", 409);
  }
  // This is intentionally only a cheap preflight. The same predicates (plus
  // session/member/grant state) are repeated inside the final locked mutation.
  // A browser can never supply a provider integration, resource, or metadata.
  if (
    !connection.providerIntegrationId
    || !connection.providerResourceId
    || !connection.providerResource
    || connection.readonlyDefault !== true
    || connection.allowWrites !== false
    || (connection.credentialMode !== "managed" && connection.credentialMode !== "member_local")
  ) {
    return jsonError("Disable managed writes before switching this provider target to member-local", 409);
  }

  const claim = await claimRevocationGate({
    kind: "connection",
    organizationId: workspaceId,
    connectionId,
  });
  if (!claim) {
    return jsonError("Another connection access change is already in progress", 409);
  }
  const expectedClaimRevision = connection.revision + (claim.firstPending ? 1 : 0);
  if (claim.connectionRevision !== expectedClaimRevision) {
    await (
      claim.firstPending
        ? clearRevocationGate(claim)
        : releaseRevocationGateClaim(claim)
    ).catch(() => false);
    return jsonError(
      "Connection changed concurrently. Retry the access update.",
      409,
    );
  }
  let revocation;
  try {
    revocation = await revokeActiveLeases({
      organizationId: workspaceId,
      connectionId,
    });
  } catch (error) {
    await releaseRevocationGateClaim(claim).catch(() => false);
    throw error;
  }
  if (revocation.deferred > 0) {
    await releaseRevocationGateClaim(claim).catch(() => false);
    return jsonError(
      "Active database access could not be revoked yet. Retry before changing access.",
      409,
    );
  }
  const updatedAt = new Date();
  const lockTarget = { kind: "connection" as const, organizationId: workspaceId, connectionId };
  const memberLockTarget = {
    kind: "member" as const,
    organizationId: workspaceId,
    memberId: authorization.membership.id,
    userId: authorization.session.user.id,
  };
  const result = await db.execute<{
    id: string;
    name: string;
    engine: string;
    provider: string;
    driverId: string | null;
    host: string;
    port: number;
    databaseName: string;
    sslmode: string;
    readonlyDefault: boolean;
    allowWrites: boolean;
    environment: string | null;
    schemaGroup: string | null;
    credentialMode: string;
    contentRevision: number;
    updatedAt: Date;
  }>(sql`
    WITH connection_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${revocationGateLockKey(lockTarget)}, 0)
      )
    ), member_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${revocationGateLockKey(memberLockTarget)}, 0)
      ) FROM connection_lock
    ), authority AS MATERIALIZED (
      SELECT member."id"
      FROM ${session} AS session
      JOIN ${member} AS member
        ON member."id" = ${authorization.membership.id}
       AND member."organization_id" = ${workspaceId}
       AND member."user_id" = ${authorization.session.user.id}
      JOIN member_lock ON TRUE
      WHERE session."id" = ${authorization.session.session.id}
        AND session."user_id" = ${authorization.session.user.id}
        AND session."expires_at" > now()
        AND member."role" = ${authorization.role}
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), granted_target AS MATERIALIZED (
      SELECT manager_grant."connection_id"
      FROM ${workspaceConnectionGrant} AS manager_grant
      JOIN authority ON authority."id" = manager_grant."member_id"
      WHERE manager_grant."organization_id" = ${workspaceId}
        AND manager_grant."connection_id" = ${connectionId}::uuid
        AND manager_grant."capability" = 'manage'
      FOR UPDATE OF manager_grant
    ), canonical_target AS MATERIALIZED (
      SELECT connection."id"
      FROM ${workspaceConnection} AS connection
      JOIN ${workspaceProviderIntegration} AS integration
        ON integration."organization_id" = connection."organization_id"
       AND integration."id" = connection."provider_integration_id"
      JOIN ${workspaceProviderResource} AS resource
        ON resource."organization_id" = connection."organization_id"
       AND resource."id" = connection."provider_resource_id"
      JOIN ${workspaceProviderImportRequest} AS imported
        ON imported."organization_id" = connection."organization_id"
       AND imported."connection_id" = connection."id"
       AND imported."resource_id" = resource."id"
      JOIN granted_target ON granted_target."connection_id" = connection."id"
      WHERE connection."id" = ${connectionId}::uuid
        AND connection."organization_id" = ${workspaceId}
        AND connection."deleted_at" IS NULL
        AND connection."credential_mode" IN ('managed', 'member_local')
        AND connection."readonly_default" = TRUE
        AND connection."allow_writes" = FALSE
        AND connection."provider" = integration."provider"
        AND connection."provider" = resource."provider"
        AND connection."provider_resource" = resource."resource"
        -- The import row is the receipt-derived immutable witness. Production
        -- approval is durable policy, while OAuth generation is revalidated by
        -- the active integration and must not erase approval on token refresh.
        AND (
          resource."redacted_metadata" -> 'production' = 'false'::jsonb
          OR imported."production_approved" = TRUE
        )
        AND integration."status" = 'active'
        AND integration."refresh_phase" = 'idle'
        AND integration."revoked_at" IS NULL
        AND integration."revocation_pending_at" IS NULL
        AND integration."revocation_claim_id" IS NULL
        AND (
          resource."redacted_metadata" -> 'production' = 'false'::jsonb
          OR (
            resource."provider" IN ('gcpCloudSql', 'planetScale')
            AND resource."redacted_metadata" -> 'production' = 'true'::jsonb
            AND (
              resource."provider" <> 'planetScale'
              OR resource."resource" ->> 'engine' = 'postgres'
              OR resource."redacted_metadata" -> 'safeMigrations' = 'true'::jsonb
            )
          )
        )
        AND resource."capability_manifest" -> 'importReadOnly' = 'true'::jsonb
        AND jsonb_typeof(resource."capability_manifest" -> 'write') = 'boolean'
        AND resource."capability_manifest" -> 'managedLease' = 'true'::jsonb
      FOR UPDATE OF connection, integration, resource, imported
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceConnection} AS connection
      SET "credential_mode" = 'member_local',
          "revocation_pending_at" = NULL,
          "revocation_claimed_at" = NULL,
          "revocation_claim_id" = NULL,
          "revision" = connection."revision" + 1,
          "updated_at" = ${updatedAt}
      FROM canonical_target
      WHERE connection."id" = canonical_target."id"
        AND connection."organization_id" = ${workspaceId}
        AND connection."revocation_claim_id" = ${claim.claimId}::uuid
        AND connection."revision" = ${expectedClaimRevision}
        AND connection."deleted_at" IS NULL
      RETURNING connection."id"::text AS "id", connection."name" AS "name",
        connection."engine" AS "engine", connection."provider" AS "provider",
        connection."driver_id" AS "driverId", connection."host" AS "host",
        connection."port" AS "port", connection."database_name" AS "databaseName",
        connection."sslmode" AS "sslmode", connection."readonly_default" AS "readonlyDefault",
        connection."allow_writes" AS "allowWrites", connection."environment" AS "environment",
        connection."schema_group" AS "schemaGroup", connection."credential_mode" AS "credentialMode",
        connection."content_revision" AS "contentRevision", connection."updated_at" AS "updatedAt"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${workspaceId}, ${authorization.session.user.id},
             'connection.credential_mode.update', 'connection', updated."id",
             jsonb_build_object(
               'mode', 'member_local',
               'providerLinkPreserved', TRUE,
               'revokedLeases', ${revocation.revoked}
             ), ${crypto.randomUUID()}::uuid
      FROM updated
      RETURNING "resource_id"
    ) SELECT updated.* FROM updated JOIN audit ON TRUE
  `).catch(async (error) => {
    await releaseRevocationGateClaim(claim).catch(() => false);
    throw error;
  });
  const updated = result.rows[0];
  if (!updated) {
    await releaseRevocationGateClaim(claim).catch(() => false);
    return jsonError(
      "Connection or provider access changed concurrently. Retry the update.",
      409,
    );
  }
  return privateJson({
    connection: publicConnection(updated, authorization.role, authorization.accessMode),
  });
}
