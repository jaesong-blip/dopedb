// Receipt-only managed imports use Neon HTTP's non-interactive transaction: a
// lock/revalidation statement runs before a fresh-snapshot mutation statement.
import "server-only";

import type { NeonQueryFunctionInTransaction } from "@neondatabase/serverless";
import { neonSql } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import { returnedConnection, type MutationAuthority, type StoredConnection } from "./workspace-versioning-store";

type RawConnectionRow = Record<string, unknown>;
type TransactionSql = NeonQueryFunctionInTransaction<false, false>;

export type ProviderImportAuthority = Pick<
  MutationAuthority,
  "sessionId" | "userId" | "membershipId" | "role"
>;

export type ProviderImportResult =
  | { kind: "imported"; connection: StoredConnection }
  | { kind: "invalid_receipt" | "idempotency_conflict" | "resource_conflict" };

function memberLock(input: { organizationId: string; authority: ProviderImportAuthority }) {
  return revocationGateLockKey({
    kind: "member", organizationId: input.organizationId,
    memberId: input.authority.membershipId, userId: input.authority.userId,
  });
}

function importLock(input: { organizationId: string; idempotencyKey: string }) {
  return `provider-import:${input.organizationId}:${input.idempotencyKey}`;
}

function integrationLock(input: { organizationId: string; integrationId: string }) {
  return `provider-import-integration:${input.organizationId}:${input.integrationId}`;
}

/**
 * The first HTTP-transaction statement deliberately acquires locks only.  The
 * following statement therefore receives a new READ COMMITTED snapshot after a
 * concurrent same-key import commits, instead of treating it as a false 409.
 */
function lockAndRevalidate(tx: TransactionSql, input: {
  organizationId: string; integrationId: string; receiptId: string;
  idempotencyKey: string; connectionId: string | null;
  authority: ProviderImportAuthority;
}) {
  const replacing = input.connectionId !== null;
  return tx`
    WITH member_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${memberLock(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN member_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."role" IN ('admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), integration_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${integrationLock(input)}, 0))
      FROM authority
    ), receipt_scope AS MATERIALIZED (
      SELECT receipt."id", receipt."resource_id" AS "resourceId"
      FROM "workspace_control"."workspace_provider_discovery_receipt" receipt
      JOIN "workspace_control"."workspace_provider_integration" integration
        ON integration."organization_id" = receipt."organization_id"
       AND integration."id" = receipt."integration_id"
      JOIN "workspace_control"."workspace_provider_resource" resource
        ON resource."organization_id" = receipt."organization_id"
       AND resource."id" = receipt."resource_id"
      JOIN authority ON authority."id" = receipt."member_id"
      JOIN integration_lock ON TRUE
      WHERE receipt."id" = ${input.receiptId}::uuid
        AND receipt."organization_id" = ${input.organizationId}
        AND receipt."integration_id" = ${input.integrationId}::uuid
        AND receipt."member_id" = ${input.authority.membershipId}
        AND receipt."user_id" = ${input.authority.userId}
        AND receipt."session_id" = ${input.authority.sessionId}
        AND receipt."integration_generation" = integration."generation"
        AND integration."status" = 'active'
        AND integration."refresh_phase" = 'idle'
        AND integration."revoked_at" IS NULL
        AND integration."revocation_pending_at" IS NULL
        AND integration."revocation_claim_id" IS NULL
      FOR UPDATE OF receipt, integration, resource
    ), resource_lock AS MATERIALIZED (
      -- A different idempotency key must not race the partial unique index on
      -- workspace_connection.provider_resource_id.  Lock the durable canonical
      -- resource before the request key so all imports use member → integration
      -- → resource → key ordering.
      SELECT pg_advisory_xact_lock(hashtextextended(
        'provider-import-resource:' || ${input.organizationId} || ':' || "resourceId"::text,
        0
      ))
      FROM receipt_scope
    ), target_scope AS MATERIALIZED (
      -- Replacing a shared template preserves its UUID and every dashboard/grant
      -- reference. The target is locked after the canonical provider resource so
      -- concurrent imports and ordinary connection mutations have one order.
      SELECT connection."id"
      FROM "workspace_control"."workspace_connection" connection
      JOIN "workspace_control"."workspace_connection_grant" grant
        ON grant."organization_id" = connection."organization_id"
       AND grant."connection_id" = connection."id"
       AND grant."member_id" = ${input.authority.membershipId}
       AND grant."capability" = 'manage'
      JOIN receipt_scope ON TRUE
      JOIN resource_lock ON TRUE
      WHERE ${replacing}
        AND connection."organization_id" = ${input.organizationId}
        AND connection."id" = ${input.connectionId}::uuid
        AND connection."credential_mode" = 'member_local'
        AND connection."provider_integration_id" IS NULL
        AND connection."provider_resource_id" IS NULL
        AND connection."provider_resource" IS NULL
        AND connection."readonly_default" = TRUE
        AND connection."allow_writes" = FALSE
        AND connection."engine" = (
          SELECT resource."resource" ->> 'engine'
          FROM "workspace_control"."workspace_provider_resource" resource
          WHERE resource."organization_id" = ${input.organizationId}
            AND resource."id" = receipt_scope."resourceId"
        )
        AND connection."database_name" = (
          SELECT resource."resource" ->> 'database'
          FROM "workspace_control"."workspace_provider_resource" resource
          WHERE resource."organization_id" = ${input.organizationId}
            AND resource."id" = receipt_scope."resourceId"
        )
        AND connection."deleted_at" IS NULL
        AND connection."revocation_pending_at" IS NULL
        AND connection."revocation_claim_id" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "workspace_control"."workspace_credential_lease" lease
          WHERE lease."organization_id" = connection."organization_id"
            AND lease."connection_id" = connection."id"
            AND lease."revoked_at" IS NULL
        )
      FOR UPDATE OF connection, grant
    ), target_gate AS MATERIALIZED (
      SELECT 1 AS "ready" FROM resource_lock WHERE NOT ${replacing}
      UNION ALL
      SELECT 1 AS "ready" FROM target_scope
    ), key_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${importLock(input)}, 0))
      FROM target_gate
    ) SELECT count(*)::int AS "locked" FROM key_lock
  `;
}

function mutateFreshSnapshot(tx: TransactionSql, input: {
  organizationId: string; integrationId: string; receiptId: string;
  idempotencyKey: string; connectionId: string | null;
  name: string; productionApproved: boolean;
  authority: ProviderImportAuthority;
}) {
  const replacing = input.connectionId !== null;
  const connectionId = input.connectionId ?? crypto.randomUUID();
  const requestId = crypto.randomUUID();
  return tx`
    WITH authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."role" IN ('admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), scope AS MATERIALIZED (
      SELECT receipt."id" AS "receiptId", receipt."resource_id" AS "resourceId",
        receipt."integration_generation" AS "integrationGeneration",
        resource."provider", resource."resource",
        resource."capability_manifest",
        encode(digest(
          (
            jsonb_build_object(
            'integrationGeneration', receipt."integration_generation"::text,
            'integrationId', ${input.integrationId}::text,
            'mode', 'managed',
            'name', ${input.name}::text,
            'organizationId', ${input.organizationId}::text,
            'productionApproved', ${input.productionApproved},
            'resourceId', resource."id"::text
            )
            || CASE WHEN ${replacing}
              THEN jsonb_build_object('connectionId', ${input.connectionId}::text)
              ELSE '{}'::jsonb
            END
          )::text,
          'sha256'
        ), 'hex') AS "requestHash"
      FROM "workspace_control"."workspace_provider_discovery_receipt" receipt
      JOIN "workspace_control"."workspace_provider_integration" integration
        ON integration."organization_id" = receipt."organization_id"
       AND integration."id" = receipt."integration_id"
      JOIN "workspace_control"."workspace_provider_resource" resource
        ON resource."organization_id" = receipt."organization_id"
       AND resource."id" = receipt."resource_id"
      JOIN authority ON authority."id" = receipt."member_id"
      WHERE receipt."id" = ${input.receiptId}::uuid
        AND receipt."organization_id" = ${input.organizationId}
        AND receipt."integration_id" = ${input.integrationId}::uuid
        AND receipt."member_id" = ${input.authority.membershipId}
        AND receipt."user_id" = ${input.authority.userId}
        AND receipt."session_id" = ${input.authority.sessionId}
        AND receipt."integration_generation" = integration."generation"
        AND integration."status" = 'active'
        AND integration."refresh_phase" = 'idle'
        AND integration."revoked_at" IS NULL
        AND integration."revocation_pending_at" IS NULL AND integration."revocation_claim_id" IS NULL
        -- Canonical resources are mutable provider facts.  A receipt is not a
        -- permission to outlive a later discovery which classifies the target
        -- as production or removes an import/lease capability.
        AND resource."provider" = integration."provider"
        AND (
          resource."redacted_metadata" -> 'production' = 'false'::jsonb
          OR (
            resource."provider" = 'gcpCloudSql'
            AND resource."redacted_metadata" -> 'production' = 'true'::jsonb
            AND ${input.productionApproved}
          )
        )
        AND resource."capability_manifest" -> 'importReadOnly' = 'true'::jsonb
        AND jsonb_typeof(resource."capability_manifest" -> 'write') = 'boolean'
        AND resource."capability_manifest" -> 'managedLease' = 'true'::jsonb
      FOR UPDATE OF receipt, integration, resource
    ), target AS MATERIALIZED (
      SELECT connection."id", connection."content_revision" AS "contentRevision",
        parent."id" AS "parentVersionId"
      FROM "workspace_control"."workspace_connection" connection
      JOIN "workspace_control"."workspace_connection_grant" grant
        ON grant."organization_id" = connection."organization_id"
       AND grant."connection_id" = connection."id"
       AND grant."member_id" = ${input.authority.membershipId}
       AND grant."capability" = 'manage'
      JOIN scope ON TRUE
      JOIN "workspace_control"."workspace_resource_version" parent
        ON parent."organization_id" = connection."organization_id"
       AND parent."resource_type" = 'connection'
       AND parent."resource_id" = connection."id"
       AND parent."branch" = 'main'
       AND parent."revision" = connection."content_revision"
      WHERE ${replacing}
        AND connection."organization_id" = ${input.organizationId}
        AND connection."id" = ${input.connectionId}::uuid
        AND connection."credential_mode" = 'member_local'
        AND connection."provider_integration_id" IS NULL
        AND connection."provider_resource_id" IS NULL
        AND connection."provider_resource" IS NULL
        AND connection."readonly_default" = TRUE
        AND connection."allow_writes" = FALSE
        AND connection."engine" = scope."resource" ->> 'engine'
        AND connection."database_name" = scope."resource" ->> 'database'
        AND connection."deleted_at" IS NULL
        AND connection."revocation_pending_at" IS NULL
        AND connection."revocation_claim_id" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "workspace_control"."workspace_credential_lease" lease
          WHERE lease."organization_id" = connection."organization_id"
            AND lease."connection_id" = connection."id"
            AND lease."revoked_at" IS NULL
        )
      FOR UPDATE OF connection, grant, parent
    ), prior_key AS MATERIALIZED (
      SELECT "request_hash", "resource_id", "connection_id"
      FROM "workspace_control"."workspace_provider_import_request"
      WHERE "organization_id" = ${input.organizationId} AND "idempotency_key" = ${input.idempotencyKey}
      FOR UPDATE
    ), prior AS MATERIALIZED (
      SELECT connection."id" AS "id", connection."name" AS "name", connection."engine" AS "engine",
        connection."provider" AS "provider", connection."driver_id" AS "driverId", connection."host" AS "host",
        connection."port" AS "port", connection."database_name" AS "databaseName", connection."sslmode" AS "sslmode",
        connection."readonly_default" AS "readonlyDefault", connection."allow_writes" AS "allowWrites",
        connection."environment" AS "environment", connection."schema_group" AS "schemaGroup",
        connection."credential_mode" AS "credentialMode", connection."content_revision" AS "contentRevision",
        connection."updated_at" AS "updatedAt"
      FROM prior_key key JOIN scope
        ON scope."requestHash" = key."request_hash"
       AND scope."resourceId" = key."resource_id"
      JOIN "workspace_control"."workspace_connection" connection
        ON connection."organization_id" = ${input.organizationId} AND connection."id" = key."connection_id"
       AND (NOT ${replacing} OR connection."id" = ${input.connectionId}::uuid)
       AND connection."credential_mode" IN ('managed', 'member_local')
       AND connection."provider_integration_id" = ${input.integrationId}::uuid
       AND connection."provider_resource_id" = scope."resourceId"
       AND connection."provider" = scope."provider"
       AND connection."provider_resource" = scope."resource"
       AND connection."readonly_default" = TRUE
       AND connection."deleted_at" IS NULL
    ), resource_conflict AS MATERIALIZED (
      SELECT connection."id" FROM "workspace_control"."workspace_connection" connection JOIN scope
        ON connection."organization_id" = ${input.organizationId}
       AND connection."provider_resource_id" = scope."resourceId" AND connection."deleted_at" IS NULL
      WHERE NOT EXISTS (SELECT 1 FROM prior_key)
      FOR UPDATE OF connection
    ), fresh AS MATERIALIZED (
      SELECT scope.* FROM scope
      WHERE NOT EXISTS (SELECT 1 FROM prior_key) AND NOT EXISTS (SELECT 1 FROM resource_conflict)
        AND (NOT ${replacing} OR EXISTS (SELECT 1 FROM target))
        AND (SELECT "consumed_at" IS NULL AND "expires_at" > now()
             FROM "workspace_control"."workspace_provider_discovery_receipt" WHERE "id" = scope."receiptId")
        AND (scope."resource" ->> 'engine') IN ('postgres', 'mysql')
    ), claimed AS MATERIALIZED (
      UPDATE "workspace_control"."workspace_provider_discovery_receipt" receipt SET "consumed_at" = now()
      FROM fresh WHERE receipt."id" = fresh."receiptId" AND receipt."consumed_at" IS NULL
      RETURNING receipt."id"
    ), inserted AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_connection"
        ("id", "organization_id", "name", "engine", "provider", "host", "port", "database_name", "sslmode",
         "readonly_default", "allow_writes", "credential_mode", "provider_integration_id", "provider_resource_id",
         "provider_resource", "content_revision", "created_by_user_id")
      SELECT ${connectionId}::uuid, ${input.organizationId}, ${input.name}, source."resource" ->> 'engine',
        source."provider", lower(source."provider") || '.managed.invalid',
        CASE WHEN source."resource" ->> 'engine' = 'postgres' THEN 5432 ELSE 3306 END,
        source."resource" ->> 'database', 'verify-full', TRUE, FALSE, 'managed', ${input.integrationId}::uuid,
        source."resourceId", source."resource", 1, ${input.authority.userId} FROM fresh source
      JOIN claimed ON claimed."id" = source."receiptId"
      WHERE NOT ${replacing}
      RETURNING "id", "name", "engine", "provider", "driver_id" AS "driverId", "host", "port",
        "database_name" AS "databaseName", "sslmode", "readonly_default" AS "readonlyDefault",
        "allow_writes" AS "allowWrites", "environment", "schema_group" AS "schemaGroup",
        "credential_mode" AS "credentialMode", "content_revision" AS "contentRevision", "updated_at" AS "updatedAt"
    ), updated AS MATERIALIZED (
      UPDATE "workspace_control"."workspace_connection" connection
      SET "provider" = source."provider",
        "driver_id" = NULL,
        "host" = lower(source."provider") || '.managed.invalid',
        "port" = CASE WHEN source."resource" ->> 'engine' = 'postgres' THEN 5432 ELSE 3306 END,
        "database_name" = source."resource" ->> 'database',
        "sslmode" = 'verify-full',
        "readonly_default" = TRUE,
        "allow_writes" = FALSE,
        "credential_mode" = 'managed',
        "provider_integration_id" = ${input.integrationId}::uuid,
        "provider_resource_id" = source."resourceId",
        "provider_resource" = source."resource",
        "content_revision" = connection."content_revision" + 1,
        "revision" = connection."revision" + 1,
        "revocation_pending_at" = NULL,
        "revocation_claimed_at" = NULL,
        "revocation_claim_id" = NULL,
        "updated_at" = now()
      FROM fresh source
      JOIN claimed ON claimed."id" = source."receiptId"
      JOIN target ON TRUE
      WHERE ${replacing}
        AND connection."organization_id" = ${input.organizationId}
        AND connection."id" = target."id"
        AND connection."content_revision" = target."contentRevision"
        AND connection."content_revision" < 9007199254740991
        AND connection."revision" < 9007199254740991
      RETURNING connection."id" AS "id", connection."name" AS "name",
        connection."engine" AS "engine", connection."provider" AS "provider",
        connection."driver_id" AS "driverId", connection."host" AS "host",
        connection."port" AS "port", connection."database_name" AS "databaseName",
        connection."sslmode" AS "sslmode",
        connection."readonly_default" AS "readonlyDefault",
        connection."allow_writes" AS "allowWrites",
        connection."environment" AS "environment",
        connection."schema_group" AS "schemaGroup",
        connection."credential_mode" AS "credentialMode",
        connection."content_revision" AS "contentRevision",
        connection."updated_at" AS "updatedAt"
    ), changed AS MATERIALIZED (
      SELECT inserted.* FROM inserted
      UNION ALL
      SELECT updated.* FROM updated
    ), connection_grant AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_connection_grant" ("organization_id", "connection_id", "member_id", "capability")
      SELECT ${input.organizationId}, inserted."id", ${input.authority.membershipId}, 'manage' FROM inserted
      ON CONFLICT ("organization_id", "connection_id", "member_id") DO UPDATE SET "capability" = 'manage'
      RETURNING "connection_id"
    ), change_gate AS MATERIALIZED (
      SELECT inserted."id" FROM inserted
      JOIN connection_grant ON connection_grant."connection_id" = inserted."id"
      UNION ALL
      SELECT updated."id" FROM updated
    ), payload AS MATERIALIZED (
      SELECT changed."id", fresh."resourceId", fresh."requestHash",
        '{"allowWrites":false,"database":' || to_json(changed."databaseName")::text
        || ',"deleted":false,"driverId":null,"engine":' || to_json(changed."engine")::text
        || ',"env":' || COALESCE(to_json(changed."environment")::text, 'null')
        || ',"host":' || to_json(changed."host")::text
        || ',"name":' || to_json(changed."name")::text
        || ',"port":' || changed."port"::text
        || ',"provider":' || to_json(changed."provider")::text
        || ',"readonlyDefault":true,"schemaGroup":'
        || COALESCE(to_json(changed."schemaGroup")::text, 'null')
        || ',"sslmode":"verify-full"}' AS "text"
      FROM changed JOIN fresh ON TRUE
      JOIN change_gate ON change_gate."id" = changed."id"
    ), version AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_resource_version"
        ("id", "organization_id", "resource_type", "resource_id", "revision", "base_revision", "parent_version_id", "branch", "operation", "payload", "payload_hash", "created_by_user_id")
      SELECT gen_random_uuid(), ${input.organizationId}, 'connection', payload."id",
        CASE WHEN target."id" IS NULL THEN 1 ELSE target."contentRevision" + 1 END,
        CASE WHEN target."id" IS NULL THEN 0 ELSE target."contentRevision" END,
        target."parentVersionId", 'main',
        CASE WHEN target."id" IS NULL THEN 'create' ELSE 'update' END,
        payload."text"::jsonb, encode(digest(payload."text", 'sha256'), 'hex'),
        ${input.authority.userId}
      FROM payload LEFT JOIN target ON target."id" = payload."id"
      RETURNING "resource_id"
    ), audit AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_audit_event" ("organization_id", "actor_user_id", "action", "resource_type", "resource_id", "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        CASE WHEN ${replacing}
          THEN 'connection.provider_migrate'
          ELSE 'connection.provider_import'
        END,
        'connection', changed."id"::text,
        jsonb_build_object(
          'provider', changed."provider",
          'mode', 'managed',
          'production', fresh."resource" -> 'production',
          'productionApproved', ${input.productionApproved},
          'preservedConnectionId', ${replacing}
        ),
        ${requestId}::uuid
      FROM changed JOIN version ON version."resource_id" = changed."id"
      RETURNING "id"
    ), recorded AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_provider_import_request" ("organization_id", "idempotency_key", "request_hash", "resource_id", "connection_id")
      SELECT ${input.organizationId}, ${input.idempotencyKey}, payload."requestHash", payload."resourceId", payload."id"
      FROM payload JOIN audit ON TRUE RETURNING "connection_id"
    ), outcome AS (
      SELECT 'imported'::text AS "kind", prior.* FROM prior
      UNION ALL SELECT 'imported'::text, inserted.* FROM inserted JOIN recorded ON recorded."connection_id" = inserted."id"
      UNION ALL SELECT 'imported'::text, updated.* FROM updated JOIN recorded ON recorded."connection_id" = updated."id"
      UNION ALL SELECT 'idempotency_conflict'::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM prior_key) AND EXISTS (SELECT 1 FROM scope)
          AND NOT EXISTS (SELECT 1 FROM prior)
      UNION ALL SELECT 'resource_conflict'::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM resource_conflict)
      UNION ALL SELECT 'invalid_receipt'::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        WHERE NOT EXISTS (SELECT 1 FROM scope)
          OR (NOT EXISTS (SELECT 1 FROM prior) AND NOT EXISTS (SELECT 1 FROM prior_key)
            AND NOT EXISTS (SELECT 1 FROM resource_conflict))
    ) SELECT * FROM outcome LIMIT 1
  `;
}

export async function importProviderReceipt(input: {
  organizationId: string; integrationId: string; receiptId: string; idempotencyKey: string;
  connectionId: string | null; name: string; productionApproved: boolean;
  authority: ProviderImportAuthority;
}): Promise<ProviderImportResult> {
  const [, mutation] = await neonSql.transaction((tx) => [
    lockAndRevalidate(tx, input),
    mutateFreshSnapshot(tx, input),
  ]);
  const row = mutation?.[0] as RawConnectionRow | undefined;
  if (row?.kind === "imported") {
    const connection = returnedConnection(row);
    if (!connection) throw new Error("Provider import returned an invalid projection");
    return { kind: "imported", connection };
  }
  if (row?.kind === "idempotency_conflict" || row?.kind === "resource_conflict") return { kind: row.kind };
  return { kind: "invalid_receipt" };
}
