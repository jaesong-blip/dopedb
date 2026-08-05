import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dedicatedDatabaseUrl =
  process.env.PROVIDER_IMPORT_TEST_DATABASE_URL?.trim() ?? "";
const dedicatedDatabaseSentinel =
  process.env.PROVIDER_IMPORT_TEST_DATABASE_SENTINEL?.trim() ?? "";
const requested =
  process.env.WORKSPACE_CLOUD_RUN_POSTGRES_IMPORT_HARNESS === "1";
const enabled = requested
  && process.env.PROVIDER_IMPORT_TEST_DATABASE_ISOLATED === "1"
  && dedicatedDatabaseUrl.length > 0
  && dedicatedDatabaseSentinel.length >= 16;

if (requested && !enabled) {
  throw new Error(
    "PostgreSQL harness requires an explicitly confirmed dedicated test database",
  );
}

describe.runIf(enabled)("provider import PostgreSQL concurrency harness", () => {
  it("imports once, replays exactly, and rejects stale authority without leaking credentials", async () => {
    const sql = postgres(dedicatedDatabaseUrl, {
      max: 8,
      onnotice: () => undefined,
      prepare: false,
    });
    const sentinel = await sql<{ confirmed: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM "provider_harness"."isolated_database_sentinel"
        WHERE "marker" = ${dedicatedDatabaseSentinel}
      ) AS "confirmed"
    `;
    if (sentinel[0]?.confirmed !== true) {
      await sql.end();
      throw new Error("Dedicated PostgreSQL harness sentinel was not confirmed");
    }
    const migrationState = await sql<{ ready: boolean }[]>`
      SELECT (
        to_regclass('workspace_control.workspace_provider_discovery_receipt') IS NOT NULL
        AND to_regclass('workspace_control.workspace_provider_import_request') IS NOT NULL
        AND to_regclass('workspace_control.workspace_provider_resource') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'workspace_control'
            AND table_name = 'workspace_provider_integration'
            AND column_name = 'local_verification_target'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'workspace_control'
            AND table_name = 'workspace_credential_lease'
            AND column_name = 'provider_audit_id'
        )
      ) AS "ready"
    `;
    if (migrationState[0]?.ready !== true) {
      await sql.end();
      throw new Error("Dedicated PostgreSQL harness database is not pre-migrated");
    }

    const neonSql = {
      transaction: async (factory: (tx: unknown) => Promise<unknown>[]) => (
        sql.begin(async (tx) => {
          const queries = factory(tx);
          const results: unknown[] = [];
          for (const query of queries) results.push(await query);
          return results;
        })
      ),
    };
    vi.doMock("./db", () => ({ db: {}, neonSql }));
    const { importProviderReceipt } = await import("./provider-import-store");

    const suffix = randomUUID();
    const organizationId = `harness-org-${suffix}`;
    const otherOrganizationId = `harness-other-${suffix}`;
    const userId = `harness-user-${suffix}`;
    const memberId = `harness-member-${suffix}`;
    const sessionId = `harness-session-${suffix}`;
    const integrationId = randomUUID();
    const resourceId = randomUUID();
    const receiptId = randomUUID();
    const providerSecret = `never-copy-this-${suffix}`;
    const authority = {
      sessionId,
      userId,
      membershipId: memberId,
      role: "admin" as const,
    };
    const insertReceipt = async (id: string, generation = 1) => {
      await sql`
        INSERT INTO "workspace_control"."workspace_provider_discovery_receipt"
          ("id", "organization_id", "resource_id", "integration_id",
           "integration_generation", "member_id", "user_id", "session_id", "expires_at")
        VALUES
          (${id}::uuid, ${organizationId}, ${resourceId}::uuid, ${integrationId}::uuid,
           ${generation}, ${memberId}, ${userId}, ${sessionId}, now() + interval '5 minutes')
      `;
    };
    try {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO "workspace_control"."organization" ("id", "name", "slug")
          VALUES (${organizationId}, 'Harness', ${`harness-${suffix}`}),
                 (${otherOrganizationId}, 'Other', ${`harness-other-${suffix}`})
        `;
        await tx`
          INSERT INTO "workspace_control"."user"
            ("id", "name", "email", "email_verified")
          VALUES (${userId}, 'Harness', ${`harness-${suffix}@invalid.test`}, TRUE)
        `;
        await tx`
          INSERT INTO "workspace_control"."member"
            ("id", "organization_id", "user_id", "role")
          VALUES (${memberId}, ${organizationId}, ${userId}, 'admin')
        `;
        await tx`
          INSERT INTO "workspace_control"."session"
            ("id", "expires_at", "token", "user_id")
          VALUES (${sessionId}, now() + interval '10 minutes',
                  ${`harness-token-${suffix}`}, ${userId})
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_provider_integration"
            ("id", "organization_id", "provider", "status", "external_account_id",
             "display_name", "encrypted_credential", "generation")
          VALUES (${integrationId}::uuid, ${organizationId}, 'neon', 'active',
                  ${`harness-account-${suffix}`}, 'Harness Neon', ${providerSecret}, 1)
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_provider_resource"
            ("id", "organization_id", "provider", "resource_fingerprint",
             "resource", "redacted_metadata", "capability_manifest")
          VALUES (
            ${resourceId}::uuid, ${organizationId}, 'neon', ${"f".repeat(64)},
            ${sql.json({
              project: "harness-project",
              branch: "harness-branch",
              database: "app",
              engine: "postgres",
              schemas: ["public"],
            })},
            ${sql.json({ production: false })},
            ${sql.json({
              discover: true,
              importReadOnly: true,
              managedLease: true,
              write: false,
            })}
          )
        `;
      });
      await insertReceipt(receiptId);

      const input = {
        organizationId,
        integrationId,
        receiptId,
        idempotencyKey: `harness-key-${suffix}`,
        connectionId: null,
        name: "Harness Neon",
        productionApproved: false,
        authority,
      };
      const [left, right] = await Promise.all([
        importProviderReceipt(input),
        importProviderReceipt(input),
      ]);
      expect(left.kind).toBe("imported");
      expect(right).toEqual(left);
      if (left.kind !== "imported") {
        throw new Error("Concurrent import did not return its durable connection");
      }
      await expect(importProviderReceipt(input)).resolves.toEqual(left);

      const durable = await sql<{
        connections: number;
        grants: number;
        versions: number;
        audits: number;
        requests: number;
        consumedReceipts: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM "workspace_control"."workspace_connection"
            WHERE "organization_id" = ${organizationId}) AS "connections",
          (SELECT count(*)::int FROM "workspace_control"."workspace_connection_grant"
            WHERE "organization_id" = ${organizationId}) AS "grants",
          (SELECT count(*)::int FROM "workspace_control"."workspace_resource_version"
            WHERE "organization_id" = ${organizationId}) AS "versions",
          (SELECT count(*)::int FROM "workspace_control"."workspace_audit_event"
            WHERE "organization_id" = ${organizationId}) AS "audits",
          (SELECT count(*)::int FROM "workspace_control"."workspace_provider_import_request"
            WHERE "organization_id" = ${organizationId}) AS "requests",
          (SELECT count(*)::int FROM "workspace_control"."workspace_provider_discovery_receipt"
            WHERE "organization_id" = ${organizationId} AND "consumed_at" IS NOT NULL)
            AS "consumedReceipts"
      `;
      expect(durable[0]).toEqual({
        connections: 1,
        grants: 1,
        versions: 1,
        audits: 1,
        requests: 1,
        consumedReceipts: 1,
      });

      const secondKeyReceipt = randomUUID();
      await insertReceipt(secondKeyReceipt);
      await expect(importProviderReceipt({
        ...input,
        receiptId: secondKeyReceipt,
        idempotencyKey: `second-key-${suffix}`,
      })).resolves.toEqual({ kind: "resource_conflict" });

      const staleReceipt = randomUUID();
      await insertReceipt(staleReceipt);
      await sql`
        UPDATE "workspace_control"."workspace_provider_integration"
        SET "generation" = 2 WHERE "id" = ${integrationId}::uuid
      `;
      await expect(importProviderReceipt({
        ...input,
        receiptId: staleReceipt,
        idempotencyKey: `stale-${suffix}`,
      })).resolves.toEqual({ kind: "invalid_receipt" });

      const crossTenantReceipt = randomUUID();
      await insertReceipt(crossTenantReceipt, 2);
      await expect(importProviderReceipt({
        ...input,
        organizationId: otherOrganizationId,
        receiptId: crossTenantReceipt,
        idempotencyKey: `cross-tenant-${suffix}`,
      })).resolves.toEqual({ kind: "invalid_receipt" });

      const leaked = await sql<{ leaked: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM (
            SELECT to_jsonb(connection)::text AS value
            FROM "workspace_control"."workspace_connection" connection
            WHERE connection."organization_id" = ${organizationId}
            UNION ALL
            SELECT to_jsonb(request)::text
            FROM "workspace_control"."workspace_provider_import_request" request
            WHERE request."organization_id" = ${organizationId}
            UNION ALL
            SELECT to_jsonb(event)::text
            FROM "workspace_control"."workspace_audit_event" event
            WHERE event."organization_id" = ${organizationId}
            UNION ALL
            SELECT to_jsonb(version)::text
            FROM "workspace_control"."workspace_resource_version" version
            WHERE version."organization_id" = ${organizationId}
          ) durable_record
          WHERE durable_record.value LIKE ${`%${providerSecret}%`}
        ) AS "leaked"
      `;
      expect(leaked[0]?.leaked).toBe(false);
    } finally {
      await sql`
        DELETE FROM "workspace_control"."organization"
        WHERE "id" IN (${organizationId}, ${otherOrganizationId})
      `.catch(() => undefined);
      await sql`
        DELETE FROM "workspace_control"."user" WHERE "id" = ${userId}
      `.catch(() => undefined);
      await sql.end({ timeout: 5 });
      vi.doUnmock("./db");
    }
  }, 60_000);
});
