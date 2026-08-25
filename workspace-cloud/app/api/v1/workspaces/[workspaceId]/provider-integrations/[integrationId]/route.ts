// Provider disconnection revokes live database credentials first, then the OAuth
// grant, and finally returns affected connections to member-local credential mode.
import { sql } from "drizzle-orm";
import { db } from "../../../../../../../lib/db";
import { env } from "../../../../../../../lib/env";
import { isUuid, jsonError, mutationAllowed } from "../../../../../../../lib/http";
import {
  providerIntegrationForRevocation,
  providerMutationAuthoritySql,
  revokeActiveLeases,
  revokeProviderAuthorization,
} from "../../../../../../../lib/provider-integrations";
import {
  claimProviderIntegrationDisconnect,
  markProviderIntegrationLeaseCleanupPending,
  markProviderIntegrationDisconnectLeasesRevoked,
  markProviderIntegrationProviderRevokeAmbiguous,
  markProviderIntegrationProviderRevokeStarted,
  markProviderIntegrationProviderRevoked,
  releaseProviderIntegrationDisconnectClaim,
  resumeProviderIntegrationDisconnect,
} from "../../../../../../../lib/provider-integration-mutation-store";
import { sealProviderCredential } from "../../../../../../../lib/secret-envelope";
import {
  workspaceAuditEvent,
  workspaceConnection,
  workspaceProviderIntegration,
  workspaceProviderPrincipalClaim,
} from "../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";

type RouteContext = {
  params: Promise<{ workspaceId: string; integrationId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, integrationId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(integrationId)) {
    return jsonError("Invalid workspace or integration id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const authority = {
    organizationId: workspaceId,
    membershipId: authorization.membership.id,
    userId: authorization.session.user.id,
    sessionId: authorization.session.session.id,
    role: authorization.role,
  };
  const claimId = crypto.randomUUID();
  const claimed = await claimProviderIntegrationDisconnect({
    authority,
    integrationId, claimId, now: new Date(),
  });
  const resumed = claimed ? null : await resumeProviderIntegrationDisconnect({ authority, integrationId });
  if (!claimed && !resumed) {
    const existing = await providerIntegrationForRevocation(workspaceId, integrationId);
    return existing
      ? jsonError("Another provider access change is already in progress", 409)
      : jsonError("Provider integration not found", 404);
  }
  const activeClaimId = claimed ? claimId : resumed!.claimId;
  const disconnectGeneration = claimed ? claimed.generation : resumed!.generation;
  let phase = claimed ? "claimed" : resumed!.phase;
  const integration = await providerIntegrationForRevocation(workspaceId, integrationId);
  if (!integration) {
    if (claimed) await releaseProviderIntegrationDisconnectClaim({
      organizationId: workspaceId, integrationId, claimId: activeClaimId,
    }).catch(() => undefined);
    return jsonError("Provider integration not found", 404);
  }

  let revocation = { revoked: 0, deferred: 0 };
  if (phase === "claimed" || phase === "lease_cleanup_pending") {
    try {
      // Provider lease cleanup is idempotent: PlanetScale deletion treats 404 as
      // success, Neon first sets NOLOGIN/missing-role success, and Vault uses its
      // synchronous lease-revoke endpoint. It is safe to resume this exact claim
      // after a worker crash.
      revocation = await revokeActiveLeases({ organizationId: workspaceId, integrationId });
    } catch {
      await markProviderIntegrationLeaseCleanupPending({
        organizationId: workspaceId, integrationId, generation: disconnectGeneration,
        claimId: activeClaimId, now: new Date(),
      }).catch(() => undefined);
      return jsonError("Provider lease cleanup is pending durable reconciliation.", 409);
    }
    if (revocation.deferred > 0) {
      await markProviderIntegrationLeaseCleanupPending({
        organizationId: workspaceId, integrationId, generation: disconnectGeneration,
        claimId: activeClaimId, now: new Date(),
      }).catch(() => undefined);
      return jsonError("Provider lease cleanup is pending durable reconciliation.", 409);
    }
    if (!await markProviderIntegrationDisconnectLeasesRevoked({
      organizationId: workspaceId, integrationId, generation: disconnectGeneration,
      claimId: activeClaimId, now: new Date(),
    })) return jsonError("Provider disconnect requires reconciliation", 409);
    phase = "leases_revoked";
  }
  if (phase === "provider_revoke_ambiguous") {
    return jsonError("Provider disconnect is ambiguous; explicit reconnect is required.", 409);
  }
  if (phase === "provider_revoke_started") {
    if (integration.provider === "planetScale") {
      await markProviderIntegrationProviderRevokeAmbiguous({
        organizationId: workspaceId, integrationId, generation: disconnectGeneration,
        claimId: activeClaimId, now: new Date(),
      }).catch(() => undefined);
      return jsonError("Provider disconnect is ambiguous; explicit reconnect is required.", 409);
    }
    if (!await markProviderIntegrationProviderRevoked({
      organizationId: workspaceId, integrationId, generation: disconnectGeneration,
      claimId: activeClaimId, now: new Date(),
    })) return jsonError("Provider disconnect requires reconciliation", 409);
    phase = "provider_revoked";
  }
  if (phase === "leases_revoked") {
    if (!await markProviderIntegrationProviderRevokeStarted({
      organizationId: workspaceId, integrationId, generation: disconnectGeneration,
      claimId: activeClaimId, now: new Date(),
    })) return jsonError("Provider disconnect requires reconciliation", 409);
    try {
      await revokeProviderAuthorization(integration);
    } catch {
      await markProviderIntegrationProviderRevokeAmbiguous({
        organizationId: workspaceId, integrationId, generation: disconnectGeneration,
        claimId: activeClaimId, now: new Date(),
      }).catch(() => undefined);
      return jsonError("Provider authorization outcome is ambiguous; explicit reconnect is required.", 502);
    }
    if (!await markProviderIntegrationProviderRevoked({
      organizationId: workspaceId, integrationId, generation: disconnectGeneration,
      claimId: activeClaimId, now: new Date(),
    })) return jsonError("Provider disconnect requires reconciliation", 409);
  }
  const disconnectedAt = new Date();
  const scrubbedCredential = sealProviderCredential(integrationId, {
    revokedAt: disconnectedAt.toISOString(),
  });
  const result = await db.execute<{ id: string }>(sql`
    WITH revoked_integration AS (
      UPDATE ${workspaceProviderIntegration} AS integration
      SET "status" = 'revoked',
          "encrypted_credential" = ${scrubbedCredential},
          "credential_expires_at" = NULL,
          "granted_scope" = NULL,
          "revoked_at" = ${disconnectedAt},
          "generation" = integration."generation" + 1,
          "updated_at" = ${disconnectedAt},
          "revocation_pending_at" = NULL,
          "revocation_claimed_at" = NULL,
          "revocation_claim_id" = NULL,
          "disconnect_phase" = 'finalized'
      WHERE integration."id" = ${integrationId}::uuid
        AND integration."organization_id" = ${workspaceId}
        AND integration."status" IN ('active', 'reconnect_required')
        AND integration."revoked_at" IS NULL
        AND integration."revocation_claim_id" = ${activeClaimId}::uuid
        AND integration."generation" = ${disconnectGeneration}
        AND integration."disconnect_generation" = ${disconnectGeneration}
        AND integration."disconnect_phase" = 'provider_revoked'
        -- The original claim remains the durable fence, but finalizing a
        -- user-initiated disconnect after lease/provider I/O still requires a
        -- current exact manager.  A fresh manager can resume this claim.
        AND ${providerMutationAuthoritySql({
          ...authority,
          integration: {
            id: integrationId,
            provider: integration.provider,
            generation: disconnectGeneration,
            claimId: activeClaimId,
          },
        })}
      RETURNING integration."id", integration."organization_id"
    ),
    detached_connections AS (
      UPDATE ${workspaceConnection} AS connection
      SET "credential_mode" = 'member_local',
          "provider_integration_id" = NULL,
          "provider_resource" = NULL,
          "provider_resource_id" = NULL,
          "revision" = connection."revision" + 1,
          "updated_at" = ${disconnectedAt}
      FROM revoked_integration
      WHERE connection."organization_id" = revoked_integration."organization_id"
        AND connection."provider_integration_id" = revoked_integration."id"
        AND connection."deleted_at" IS NULL
      RETURNING connection."id"
    ),
    deleted_principal_claims AS (
      DELETE FROM ${workspaceProviderPrincipalClaim} AS claim
      USING revoked_integration
      WHERE claim."integration_id" = revoked_integration."id"
      RETURNING claim."principal_fingerprint"
    ),
    audit_event AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT revoked_integration."organization_id",
             ${authorization.session.user.id}, 'provider.disconnect',
             'provider_integration', revoked_integration."id"::text,
             jsonb_build_object(
               'provider', ${integration.provider},
               'revokedLeases', ${revocation.revoked}
             ),
             ${crypto.randomUUID()}::uuid
      FROM revoked_integration
      RETURNING "resource_id"
    )
    SELECT "id"::text AS "id" FROM revoked_integration
  `);
  if (result.rows.length !== 1) {
    return jsonError("Provider disconnect requires reconciliation", 409);
  }
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "private, no-store" },
  });
}
