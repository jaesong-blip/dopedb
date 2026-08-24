import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { ProviderImportPostgresHarness } from "./fixture";
export async function runConnectionVersioningScenarios(fixture: ProviderImportPostgresHarness) {
  const { authority, memberId, organizationId, sql, userId } = fixture;
  const [versioning, store] = await Promise.all([import("../workspace-versioning"), import("../workspace-versioning-store")]);
  const connectionId = randomUUID();
  const current = versioning.connectionVersionPayload({ name: "Versioning harness", engine: "postgres", provider: "generic",
    driverId: null, host: "versioning-harness.invalid", port: 5432, database: "app", sslmode: "verify-full",
    readonlyDefault: true, allowWrites: false, env: "test", schemaGroup: "public" });
  await sql`
    WITH inserted AS (
      INSERT INTO "workspace_control"."workspace_connection" ("id", "organization_id", "name", "engine",
        "provider", "host", "port", "database_name", "sslmode", "readonly_default", "allow_writes",
        "credential_mode", "environment", "schema_group", "content_revision", "revision", "created_by_user_id")
      VALUES (${connectionId}::uuid, ${organizationId}, ${current.name}, ${current.engine}, ${current.provider},
        ${current.host}, ${current.port}, ${current.database}, ${current.sslmode}, TRUE, FALSE, 'managed',
        ${current.env}, ${current.schemaGroup}, 1, 1, ${userId}) RETURNING "id"
    ), granted AS (
      INSERT INTO "workspace_control"."workspace_connection_grant"
        ("organization_id", "connection_id", "member_id", "capability")
      SELECT ${organizationId}, inserted."id", ${memberId}, 'manage' FROM inserted RETURNING "connection_id"
    ) INSERT INTO "workspace_control"."workspace_resource_version" ("organization_id", "resource_type",
      "resource_id", "revision", "base_revision", "branch", "operation", "payload", "payload_hash", "created_by_user_id")
    SELECT ${organizationId}, 'connection', granted."connection_id", 1, 0, 'main', 'create',
      ${JSON.stringify(current)}::jsonb, ${versioning.canonicalHash(current)}, ${userId} FROM granted
  `;
  const claimId = randomUUID();
  const claimed = await sql<{ revision: number }[]>`
    UPDATE "workspace_control"."workspace_connection" SET "revision" = "revision" + 1,
      "revocation_pending_at" = now(), "revocation_claimed_at" = now(), "revocation_claim_id" = ${claimId}::uuid
    WHERE "organization_id" = ${organizationId} AND "id" = ${connectionId}::uuid RETURNING "revision"::int AS "revision"`;
  if (!claimed[0]) throw new Error("Connection mutation gate was not seeded");
  const next = { ...current, allowWrites: true };
  const updated = await store.commitConnectionMutation({ organizationId, connectionId,
    expectedContentRevision: 1, expectedAuthorityRevision: claimed[0].revision,
    claimId, authority, requireWorkspaceManager: true,
    mutation: { kind: "update", payload: next, name: next.name, engine: next.engine,
      provider: next.provider, driverId: next.driverId, host: next.host, port: next.port,
      databaseName: next.database, sslmode: next.sslmode, readonlyDefault: next.readonlyDefault,
      allowWrites: next.allowWrites, environment: next.env, schemaGroup: next.schemaGroup } });
  expect(updated).toMatchObject({ id: connectionId, allowWrites: true, contentRevision: 2 });
  const durable = await sql<{ allowWrites: boolean; versions: number; audits: number }[]>`
    SELECT connection."allow_writes" AS "allowWrites",
      (SELECT count(*)::int FROM "workspace_control"."workspace_resource_version" WHERE "resource_id" = connection."id") AS "versions",
      (SELECT count(*)::int FROM "workspace_control"."workspace_audit_event" WHERE "resource_id" = connection."id"::text
        AND "action" = 'connection.write_policy.update') AS "audits"
    FROM "workspace_control"."workspace_connection" connection WHERE connection."id" = ${connectionId}::uuid`;
  expect(durable[0]).toEqual({ allowWrites: true, versions: 2, audits: 1 });
}
