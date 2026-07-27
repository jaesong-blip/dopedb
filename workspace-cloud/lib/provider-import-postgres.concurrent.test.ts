// Opt-in proof against a dedicated, migrated Postgres/Neon test database. The
// harness deliberately has no DATABASE_URL fallback and never logs its isolated
// URL, credentials, provider material, or one-time lease values.
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
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

describe.runIf(enabled)("provider import PostgreSQL production CTE harness", () => {
  it("consumes one receipt once, replays idempotently, and rejects stale generation/session/tenant authority", async () => {
    const sql = neon(dedicatedDatabaseUrl);
    // Independently provisioned test databases carry this out-of-band marker.
    // Missing sentinel or 0010 schema state fails before production modules load
    // and before the harness creates any workspace rows.
    const sentinel = await sql`
      SELECT EXISTS (
        SELECT 1
        FROM "provider_harness"."isolated_database_sentinel"
        WHERE "marker" = ${dedicatedDatabaseSentinel}
      ) AS "confirmed"
    `;
    if (sentinel[0]?.confirmed !== true) {
      throw new Error("Dedicated PostgreSQL harness sentinel was not confirmed");
    }
    const migrationState = await sql`
      SELECT (
        to_regclass(
          'workspace_control.workspace_provider_discovery_receipt'
        ) IS NOT NULL
        AND to_regclass(
          'workspace_control.workspace_provider_import_request'
        ) IS NOT NULL
        AND to_regclass(
          'workspace_control.workspace_provider_resource'
        ) IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'workspace_control'
            AND table_name = 'workspace_provider_integration'
            AND column_name = 'disconnect_generation'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'workspace_control'
            AND table_name = 'workspace_provider_integration'
            AND column_name = 'refresh_remote_started_at'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'workspace_control'
            AND table_name = 'workspace_connection'
            AND column_name = 'provider_resource_id'
        )
      ) AS "ready"
    `;
    if (migrationState[0]?.ready !== true) {
      throw new Error("Dedicated PostgreSQL harness database is not pre-migrated");
    }

    // Production modules read DATABASE_URL lazily during this dynamic import.
    // Assign only after sentinel/schema proof; there is no app DB fallback.
    process.env.DATABASE_URL = dedicatedDatabaseUrl;
    const { importProviderReceipt } = await import("./provider-import-store");
    const {
      recordProviderDiscoveryReceipt,
      revokeActiveLeases,
    } = await import("./provider-integrations");
    const {
      finalizeManagedLeaseIfUnblocked,
      managedLeaseStillDeliverable,
      reserveManagedLeaseIfUnblocked,
    } = await import("./revocation-gates");
    const suffix = randomUUID();
    const organizationId = `harness-org-${suffix}`;
    const userId = `harness-user-${suffix}`;
    const memberId = `harness-member-${suffix}`;
    const sessionId = `harness-session-${suffix}`;
    const integrationId = randomUUID();
    const resourceId = randomUUID();
    const receiptId = randomUUID();
    const authority = { sessionId, userId, membershipId: memberId, role: "admin" as const };
    const cleanup = async () => {
      await sql`DELETE FROM "workspace_control"."organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "workspace_control"."user" WHERE "id" = ${userId}`;
    };
    try {
      await sql.transaction((tx) => [
        tx`INSERT INTO "workspace_control"."organization" ("id", "name", "slug") VALUES (${organizationId}, 'Harness', ${`harness-${suffix}`})`,
        tx`INSERT INTO "workspace_control"."user" ("id", "name", "email", "email_verified") VALUES (${userId}, 'Harness', ${`harness-${suffix}@invalid.test`}, TRUE)`,
        tx`INSERT INTO "workspace_control"."member" ("id", "organization_id", "user_id", "role") VALUES (${memberId}, ${organizationId}, ${userId}, 'admin')`,
        tx`INSERT INTO "workspace_control"."session" ("id", "expires_at", "token", "user_id") VALUES (${sessionId}, now() + interval '10 minutes', ${`harness-token-${suffix}`}, ${userId})`,
        tx`INSERT INTO "workspace_control"."workspace_provider_integration" ("id", "organization_id", "provider", "status", "external_account_id", "display_name", "encrypted_credential", "generation") VALUES (${integrationId}::uuid, ${organizationId}, 'neon', ${'active'}, ${`harness-account-${suffix}`}, 'Harness', 'redacted-envelope', 1)`,
        tx`INSERT INTO "workspace_control"."workspace_provider_resource" ("id", "organization_id", "provider", "resource_fingerprint", "resource", "redacted_metadata", "capability_manifest") VALUES (${resourceId}::uuid, ${organizationId}, 'neon', ${`f${suffix.replace(/-/g, "").slice(0, 63)}`}, ${JSON.stringify({ project: "project", branch: "branch", database: "app", engine: "postgres", schemas: ["public"] })}::jsonb, '{"production":false}'::jsonb, '{"importReadOnly":true,"managedLease":true,"write":false,"discover":true}'::jsonb)`,
        tx`INSERT INTO "workspace_control"."workspace_provider_discovery_receipt" ("id", "organization_id", "resource_id", "integration_id", "integration_generation", "member_id", "user_id", "session_id", "expires_at") VALUES (${receiptId}::uuid, ${organizationId}, ${resourceId}::uuid, ${integrationId}::uuid, 1, ${memberId}, ${userId}, ${sessionId}, now() + interval '5 minutes')`,
      ]);

      // Two identical proof-finalization statements may overlap before either
      // statement can see the other's READ COMMITTED snapshot. The receipt PK
      // conflict path must still return the exact same durable receipt to both.
      const concurrentProofReceiptId = randomUUID();
      const concurrentProofExpiresAt = new Date(Date.now() + 4 * 60_000);
      const concurrentProofInput = {
        organizationId,
        integrationId,
        memberId,
        userId,
        sessionId,
        role: "admin",
        provider: "neon",
        integrationGeneration: 1n,
        receiptId: concurrentProofReceiptId,
        expiresAt: concurrentProofExpiresAt,
        projection: {
          fingerprint: "b".repeat(64),
          resource: {
            project: "project",
            branch: "branch",
            database: "proof_app",
            engine: "postgres",
            schemas: ["public"],
          },
          metadata: {
            project: "project",
            branch: "branch",
            database: "proof_app",
            engine: "postgres",
          },
          capabilities: {
            discover: true as const,
            importReadOnly: true as const,
            managedLease: true,
            write: false as const,
          },
          host: "neon.managed.invalid",
          port: 5432,
          database: "proof_app",
          engine: "postgres" as const,
          sslmode: "verify-full" as const,
        },
      };
      const [firstFinalization, secondFinalization] = await Promise.all([
        recordProviderDiscoveryReceipt(concurrentProofInput),
        recordProviderDiscoveryReceipt(concurrentProofInput),
      ]);
      expect(firstFinalization?.id).toBe(concurrentProofReceiptId);
      expect(secondFinalization?.id).toBe(concurrentProofReceiptId);
      expect(firstFinalization!.expiresAt.toISOString()).toBe(
        concurrentProofExpiresAt.toISOString(),
      );
      expect(secondFinalization!.expiresAt.toISOString()).toBe(
        concurrentProofExpiresAt.toISOString(),
      );
      const finalizedReceiptCount = await sql`
        SELECT count(*)::int AS "count"
        FROM "workspace_control"."workspace_provider_discovery_receipt"
        WHERE "id" = ${concurrentProofReceiptId}::uuid
      `;
      expect(finalizedReceiptCount[0]?.count).toBe(1);
      await expect(recordProviderDiscoveryReceipt({
        ...concurrentProofInput,
        expiresAt: new Date(concurrentProofExpiresAt.valueOf() + 1),
      })).resolves.toBeNull();

      const input = {
        organizationId, integrationId, receiptId,
        idempotencyKey: `harness-key-${suffix}`,
        name: "Harness Neon",
        authority,
      };
      const [left, right] = await Promise.all([
        importProviderReceipt(input),
        importProviderReceipt(input),
      ]);
      expect(left.kind).toBe("imported");
      expect(right.kind).toBe("imported");
      expect(right).toEqual(left);
      if (left.kind !== "imported") {
        throw new Error("Concurrent import did not return its durable connection");
      }
      const receipt = await sql`
        SELECT "consumed_at" AS "consumedAt" FROM "workspace_control"."workspace_provider_discovery_receipt"
        WHERE "id" = ${receiptId}::uuid
      `;
      const imports = await sql`
        SELECT count(*)::int AS "count" FROM "workspace_control"."workspace_provider_import_request"
        WHERE "organization_id" = ${organizationId} AND "idempotency_key" = ${input.idempotencyKey}
      `;
      expect(receipt[0]?.consumedAt).toBeTruthy();
      expect(imports[0]?.count).toBe(1);

      // Canonical provider policy is re-read at the final claim/write boundary.
      // Each malformed or unsafe current projection leaves its new receipt and
      // every import side effect untouched, even though the same resource was
      // previously imported successfully.
      const sideEffectCounts = async () => sql`
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
            WHERE "organization_id" = ${organizationId}) AS "requests"
      `;
      const beforeUnsafePolicy = await sideEffectCounts();
      const unsafePolicies = [
        { metadata: { production: true }, capabilities: { importReadOnly: true, managedLease: true, write: false, discover: true } },
        { metadata: { production: "unknown" }, capabilities: { importReadOnly: true, managedLease: true, write: false, discover: true } },
        { metadata: {}, capabilities: { importReadOnly: true, managedLease: true, write: false, discover: true } },
        { metadata: { production: false }, capabilities: { importReadOnly: true, managedLease: true, write: true, discover: true } },
        { metadata: { production: false }, capabilities: { managedLease: true, write: false, discover: true } },
        { metadata: { production: false }, capabilities: { importReadOnly: true, write: false, discover: true } },
      ];
      for (const [index, policy] of unsafePolicies.entries()) {
        const policyReceiptId = randomUUID();
        await sql`
          UPDATE "workspace_control"."workspace_provider_resource"
          SET "redacted_metadata" = ${JSON.stringify(policy.metadata)}::jsonb,
              "capability_manifest" = ${JSON.stringify(policy.capabilities)}::jsonb
          WHERE "id" = ${resourceId}::uuid
        `;
        await sql`
          INSERT INTO "workspace_control"."workspace_provider_discovery_receipt"
            ("id", "organization_id", "resource_id", "integration_id", "integration_generation", "member_id", "user_id", "session_id", "expires_at")
          VALUES (${policyReceiptId}::uuid, ${organizationId}, ${resourceId}::uuid,
                  ${integrationId}::uuid, 1, ${memberId}, ${userId}, ${sessionId}, now() + interval '5 minutes')
        `;
        await expect(importProviderReceipt({
          ...input, receiptId: policyReceiptId, idempotencyKey: `unsafe-policy-${index}-${suffix}`,
        })).resolves.toEqual({ kind: "invalid_receipt" });
        const policyReceipt = await sql`
          SELECT "consumed_at" AS "consumedAt"
          FROM "workspace_control"."workspace_provider_discovery_receipt"
          WHERE "id" = ${policyReceiptId}::uuid
        `;
        expect(policyReceipt[0]?.consumedAt).toBeNull();
        expect(await sideEffectCounts()).toEqual(beforeUnsafePolicy);
      }
      await sql`
        UPDATE "workspace_control"."workspace_provider_resource"
        SET "redacted_metadata" = '{"production":false}'::jsonb,
            "capability_manifest" = '{"importReadOnly":true,"managedLease":true,"write":false,"discover":true}'::jsonb
        WHERE "id" = ${resourceId}::uuid
      `;

      // Access conversion retains canonical links. A lost response can replay
      // the original idempotency key without recreating a target, but the
      // returned projection must never revive managed access after it was
      // converted to member-local credentials.
      await sql`
        UPDATE "workspace_control"."workspace_connection"
        SET "credential_mode" = 'member_local'
        WHERE "id" = ${left.connection.id}::uuid
      `;
      await expect(importProviderReceipt(input)).resolves.toMatchObject({
        kind: "imported",
        connection: {
          id: left.connection.id,
          credentialMode: "member_local",
        },
      });
      await sql`
        UPDATE "workspace_control"."workspace_connection"
        SET "credential_mode" = 'managed'
        WHERE "id" = ${left.connection.id}::uuid
      `;

      // The same tenant/resource/name/key under another integration is a
      // different request identity and must never replay the first connection.
      const crossIntegrationId = randomUUID();
      const crossIntegrationReceiptId = randomUUID();
      await sql.transaction((tx) => [
        tx`INSERT INTO "workspace_control"."workspace_provider_integration" ("id", "organization_id", "provider", "status", "external_account_id", "display_name", "encrypted_credential", "generation") VALUES (${crossIntegrationId}::uuid, ${organizationId}, 'neon', 'active', ${`harness-cross-account-${suffix}`}, 'Harness cross integration', 'redacted-envelope', 1)`,
        tx`INSERT INTO "workspace_control"."workspace_provider_discovery_receipt" ("id", "organization_id", "resource_id", "integration_id", "integration_generation", "member_id", "user_id", "session_id", "expires_at") VALUES (${crossIntegrationReceiptId}::uuid, ${organizationId}, ${resourceId}::uuid, ${crossIntegrationId}::uuid, 1, ${memberId}, ${userId}, ${sessionId}, now() + interval '5 minutes')`,
      ]);
      await expect(importProviderReceipt({
        ...input,
        integrationId: crossIntegrationId,
        receiptId: crossIntegrationReceiptId,
      })).resolves.toEqual({ kind: "idempotency_conflict" });

      const importedConnection = await sql`
        SELECT "revision", "provider_resource_id"::text AS "providerResourceId"
        FROM "workspace_control"."workspace_connection"
        WHERE "organization_id" = ${organizationId}
          AND "id" = ${left.connection.id}::uuid
      `;
      const connectionRevision = Number(importedConnection[0]?.revision);
      const providerResourceId = String(
        importedConnection[0]?.providerResourceId ?? "",
      );
      expect(Number.isSafeInteger(connectionRevision)).toBe(true);
      expect(providerResourceId).toBe(resourceId);

      const leaseAuthority = (
        leaseId: string,
        integrationGeneration: bigint,
      ) => ({
        leaseId,
        organizationId,
        memberId,
        userId,
        sessionId,
        role: "admin" as const,
        connectionId: left.connection.id,
        connectionRevision,
        providerResourceId,
        engine: "postgres" as const,
        integrationId,
        integrationGeneration,
        provider: "neon",
        accessMode: "read" as const,
      });
      const providerLease = (externalCredentialId: string) => ({
        host: "harness.invalid",
        port: 5432,
        database: "app",
        username: "harness_role",
        password: "not-serialized",
        sslmode: "verify-full" as const,
        accessMode: "read" as const,
        externalCredentialId,
        externalCredentialKind: "role" as const,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      const retireHarnessLease = (leaseId: string) => sql`
        UPDATE "workspace_control"."workspace_credential_lease"
        SET "revoked_at" = now()
        WHERE "id" = ${leaseId}::uuid
      `;

      // Session deletion between reservation and finalization must withhold the
      // one-time provider credential even when all other authority is unchanged.
      const deletedSessionLeaseId = randomUUID();
      const deletedSessionAuthority = leaseAuthority(deletedSessionLeaseId, 1n);
      await expect(reserveManagedLeaseIfUnblocked(deletedSessionAuthority))
        .resolves.toBe("reserved");
      await sql`
        DELETE FROM "workspace_control"."session" WHERE "id" = ${sessionId}
      `;
      await expect(finalizeManagedLeaseIfUnblocked(
        deletedSessionAuthority,
        providerLease(randomUUID()),
      )).resolves.toBe(false);
      await retireHarnessLease(deletedSessionLeaseId);
      await sql`
        INSERT INTO "workspace_control"."session"
          ("id", "expires_at", "token", "user_id")
        VALUES (
          ${sessionId}, now() + interval '10 minutes',
          ${`harness-token-restored-${suffix}`}, ${userId}
        )
      `;

      // An expiry after finalization is re-read at the final durable delivery
      // boundary; a prior route authorization result is not accepted.
      const expiredSessionLeaseId = randomUUID();
      const expiredSessionAuthority = leaseAuthority(expiredSessionLeaseId, 1n);
      const expiredSessionProviderLease = providerLease(randomUUID());
      await expect(reserveManagedLeaseIfUnblocked(expiredSessionAuthority))
        .resolves.toBe("reserved");
      await expect(finalizeManagedLeaseIfUnblocked(
        expiredSessionAuthority,
        expiredSessionProviderLease,
      )).resolves.toBe(true);
      await sql`
        UPDATE "workspace_control"."session"
        SET "expires_at" = now() - interval '1 minute'
        WHERE "id" = ${sessionId}
      `;
      await expect(managedLeaseStillDeliverable(
        expiredSessionAuthority,
        expiredSessionProviderLease,
      )).resolves.toBe(false);
      await retireHarnessLease(expiredSessionLeaseId);
      await sql`
        UPDATE "workspace_control"."session"
        SET "expires_at" = now() + interval '10 minutes'
        WHERE "id" = ${sessionId}
      `;

      // Exact integration generation is checked at both finalization and final
      // delivery. These races model reconnect/revoke after provider I/O.
      const staleFinalizeLeaseId = randomUUID();
      const staleFinalizeAuthority = leaseAuthority(staleFinalizeLeaseId, 1n);
      await expect(reserveManagedLeaseIfUnblocked(staleFinalizeAuthority))
        .resolves.toBe("reserved");
      await sql`
        UPDATE "workspace_control"."workspace_provider_integration"
        SET "generation" = 2 WHERE "id" = ${integrationId}::uuid
      `;
      await expect(finalizeManagedLeaseIfUnblocked(
        staleFinalizeAuthority,
        providerLease(randomUUID()),
      )).resolves.toBe(false);
      await retireHarnessLease(staleFinalizeLeaseId);

      const staleDeliveryLeaseId = randomUUID();
      const staleDeliveryAuthority = leaseAuthority(staleDeliveryLeaseId, 2n);
      const staleDeliveryProviderLease = providerLease(randomUUID());
      await expect(reserveManagedLeaseIfUnblocked(staleDeliveryAuthority))
        .resolves.toBe("reserved");
      await expect(finalizeManagedLeaseIfUnblocked(
        staleDeliveryAuthority,
        staleDeliveryProviderLease,
      )).resolves.toBe(true);
      await sql`
        UPDATE "workspace_control"."workspace_provider_integration"
        SET "generation" = 3 WHERE "id" = ${integrationId}::uuid
      `;
      await expect(managedLeaseStillDeliverable(
        staleDeliveryAuthority,
        staleDeliveryProviderLease,
      )).resolves.toBe(false);
      await retireHarnessLease(staleDeliveryLeaseId);

      // This invokes the production cleanup path against a real Postgres
      // snapshot. GCP has no revoke endpoint and the token is already expired,
      // so no provider credential is opened. Two workers clean the final two
      // leases concurrently; the connection lock must leave no JSON-only managed
      // binding behind.
      const legacyConnectionId = randomUUID();
      const legacyLeaseIds = [randomUUID(), randomUUID()];
      const cleanupIntegrationId = randomUUID();
      await sql.transaction((tx) => [
        tx`INSERT INTO "workspace_control"."workspace_provider_integration" ("id", "organization_id", "provider", "status", "external_account_id", "display_name", "encrypted_credential", "generation", "local_verification_target") VALUES (${cleanupIntegrationId}::uuid, ${organizationId}, 'gcpCloudSql', 'active', ${`cleanup-account-${suffix}`}, 'Cleanup', 'redacted-envelope', 1, ${JSON.stringify({ kind: "gcpCloudSql", projectId: "sample-project-123", instanceId: "cleanup-instance" })}::jsonb)`,
        tx`INSERT INTO "workspace_control"."workspace_connection" ("id", "organization_id", "name", "engine", "provider", "host", "port", "database_name", "sslmode", "readonly_default", "allow_writes", "credential_mode", "provider_integration_id", "provider_resource") VALUES (${legacyConnectionId}::uuid, ${organizationId}, 'legacy', 'postgres', 'gcpCloudSql', 'gcp.managed.invalid', 5432, 'app', 'verify-full', TRUE, FALSE, 'managed', ${cleanupIntegrationId}::uuid, ${JSON.stringify({ project: "project", instance: "instance", database: "app", engine: "postgres", networkMode: "PRIVATE_SERVICES_ACCESS" })}::jsonb)`,
        tx`INSERT INTO "workspace_control"."workspace_credential_lease" ("id", "organization_id", "connection_id", "integration_id", "user_id", "provider", "access_mode", "external_credential_id", "external_credential_kind", "active_slot", "expires_at") VALUES (${legacyLeaseIds[0]}::uuid, ${organizationId}, ${legacyConnectionId}::uuid, ${cleanupIntegrationId}::uuid, ${userId}, 'gcpCloudSql', 'read', ${legacyLeaseIds[0]}, 'iamToken', 1, now() - interval '1 minute')`,
        tx`INSERT INTO "workspace_control"."workspace_credential_lease" ("id", "organization_id", "connection_id", "integration_id", "user_id", "provider", "access_mode", "external_credential_id", "external_credential_kind", "active_slot", "expires_at") VALUES (${legacyLeaseIds[1]}::uuid, ${organizationId}, ${legacyConnectionId}::uuid, ${cleanupIntegrationId}::uuid, ${userId}, 'gcpCloudSql', 'read', ${legacyLeaseIds[1]}, 'iamToken', 2, now() - interval '1 minute')`,
      ]);
      const cleanupResults = await Promise.all(legacyLeaseIds.map((leaseId) => (
        revokeActiveLeases({
          organizationId,
          integrationId: cleanupIntegrationId,
          connectionId: legacyConnectionId,
          leaseId,
        })
      )));
      expect(cleanupResults).toEqual([
        { revoked: 1, deferred: 0 },
        { revoked: 1, deferred: 0 },
      ]);
      const demoted = await sql`
        SELECT "credential_mode" AS "credentialMode", "provider_integration_id" AS "integrationId",
               "provider_resource_id" AS "resourceId", "provider_resource" AS "resource",
               "readonly_default" AS "readonlyDefault", "allow_writes" AS "allowWrites"
        FROM "workspace_control"."workspace_connection" WHERE "id" = ${legacyConnectionId}::uuid
      `;
      expect(demoted[0]).toMatchObject({
        credentialMode: "member_local", integrationId: null, resourceId: null,
        resource: null, readonlyDefault: true, allowWrites: false,
      });

      const staleReceiptId = randomUUID();
      await sql`INSERT INTO "workspace_control"."workspace_provider_discovery_receipt" ("id", "organization_id", "resource_id", "integration_id", "integration_generation", "member_id", "user_id", "session_id", "expires_at") VALUES (${staleReceiptId}::uuid, ${organizationId}, ${resourceId}::uuid, ${integrationId}::uuid, 1, ${memberId}, ${userId}, ${sessionId}, now() + interval '5 minutes')`;
      await sql`UPDATE "workspace_control"."workspace_provider_integration" SET "generation" = 4 WHERE "id" = ${integrationId}::uuid`;
      await expect(importProviderReceipt({ ...input, receiptId: staleReceiptId, idempotencyKey: `stale-${suffix}` }))
        .resolves.toEqual({ kind: "invalid_receipt" });
      const expiredReceiptId = randomUUID();
      await sql`INSERT INTO "workspace_control"."workspace_provider_discovery_receipt" ("id", "organization_id", "resource_id", "integration_id", "integration_generation", "member_id", "user_id", "session_id", "expires_at") VALUES (${expiredReceiptId}::uuid, ${organizationId}, ${resourceId}::uuid, ${integrationId}::uuid, 4, ${memberId}, ${userId}, ${sessionId}, now() + interval '5 minutes')`;
      await sql`UPDATE "workspace_control"."session" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${sessionId}`;
      await expect(importProviderReceipt({ ...input, receiptId: expiredReceiptId, idempotencyKey: `expired-${suffix}` }))
        .resolves.toEqual({ kind: "invalid_receipt" });
      await sql`UPDATE "workspace_control"."session" SET "expires_at" = now() + interval '10 minutes' WHERE "id" = ${sessionId}`;
      const tenantReceiptId = randomUUID();
      await sql`INSERT INTO "workspace_control"."workspace_provider_discovery_receipt" ("id", "organization_id", "resource_id", "integration_id", "integration_generation", "member_id", "user_id", "session_id", "expires_at") VALUES (${tenantReceiptId}::uuid, ${organizationId}, ${resourceId}::uuid, ${integrationId}::uuid, 4, ${memberId}, ${userId}, ${sessionId}, now() + interval '5 minutes')`;
      await expect(importProviderReceipt({ ...input, receiptId: tenantReceiptId, organizationId: `other-${suffix}`, idempotencyKey: `tenant-${suffix}` }))
        .resolves.toEqual({ kind: "invalid_receipt" });
    } finally {
      await cleanup().catch(() => undefined);
    }
  }, 60_000);
});
