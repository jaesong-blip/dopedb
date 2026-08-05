import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import * as workspaceSchema from "./schema";

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
        AND to_regclass('workspace_control.workspace_resource_conflict_resolution') IS NOT NULL
        AND to_regclass('workspace_control.workspace_data_key') IS NOT NULL
        AND to_regclass('workspace_control.workspace_data_key_rotation') IS NOT NULL
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
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'workspace_control'
            AND table_name = 'workspace_metadata_backup'
            AND column_name = 'reencrypted_by_rotation_id'
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'workspace_control.workspace_metadata_backup'::regclass
            AND tgname = 'workspace_metadata_backup_payload_immutable'
            AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'workspace_control.workspace_provider_operation'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%neon.branch.switch%'
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
    const postgresDb = drizzle(sql, { schema: workspaceSchema });
    const harnessDb = new Proxy(postgresDb, {
      get(target, property, receiver) {
        if (property === "execute") {
          return async (query: Parameters<typeof postgresDb.execute>[0]) => ({
            rows: await postgresDb.execute(query),
          });
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    vi.doMock("./db", () => ({ db: harnessDb, neonSql }));
    const serverLog = await import("./workspace-server-log");
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      serverLog.logProviderConnectionFailure({
        provider: "secret-provider-token",
        stage: "password-stage",
        postgresCode: "credential-value",
      });
      serverLog.logGcpManagedAccessUpstreamRejection({
        stage: "authorization-token",
        upstreamStatus: 999,
        googleStatus: "SECRET_TOKEN_VALUE",
        googleReason: "PASSWORD_VALUE",
      });
      serverLog.logGcpCloudSetupCallbackFailure({
        stage: "credential-value",
        providerRequest: true,
        status: 999,
      });
      serverLog.logManagedDatabaseAccessFailure({
        provider: "secret-provider-token",
        providerRequest: false,
        status: 999,
        databaseCode: "42703",
      });
      serverLog.logManagedDatabaseAccessFailure({
        provider: "gcpCloudSql",
        providerRequest: false,
        status: 999,
        databaseCode: "password-value",
      });
      serverLog.logWorkspaceKmsFailure({
        operation: "credential-value",
        kind: "secret-value",
        status: 999,
      });
      expect(logSpy.mock.calls).toEqual([
        ["provider_connection_failed", {
          provider: "other",
          stage: "other",
          databaseKind: null,
        }],
        ["gcp_managed_access_upstream_rejection", {
          stage: "other",
          upstreamStatus: 0,
          googleStatus: null,
          googleReason: null,
        }],
        ["gcp_cloud_setup_callback_failed", {
          stage: "other",
          kind: "provider_request",
          status: 0,
        }],
        ["managed_database_access_failed", {
          provider: "other",
          kind: "database_schema",
          status: 0,
        }],
        ["managed_database_access_failed", {
          provider: "gcpCloudSql",
          kind: "unexpected",
          status: 0,
        }],
        ["workspace_kms_failed", {
          operation: "other",
          kind: "other",
          status: 0,
        }],
      ]);
    } finally {
      logSpy.mockRestore();
    }
    const kmsCore = await import("./workspace-kms-core");
    expect(kmsCore.crc32c(Buffer.from("123456789", "utf8"))).toBe(0xe3069283);
    const kmsKeyName = "projects/dopedb-harness/locations/global/keyRings/workspace/cryptoKeys/backup";
    expect(kmsCore.parseWorkspaceKmsConfiguration({
      keyName: kmsKeyName,
      workloadIdentityAudience: "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel/providers/workspace",
      serviceAccountEmail: "workspace-kms@dopedb-harness.iam.gserviceaccount.com",
    })).toMatchObject({ keyName: kmsKeyName });
    expect(() => kmsCore.parseWorkspaceKmsConfiguration({
      keyName: "credential-value",
      workloadIdentityAudience: "secret-value",
      serviceAccountEmail: "password-value",
    })).toThrow("Workspace KMS configuration failed");
    const syntheticWrapped = Buffer.from("synthetic wrapped data key", "utf8");
    const parsedWrapped = kmsCore.parseKmsEncryptResponse({
      name: `${kmsKeyName}/cryptoKeyVersions/7`,
      ciphertext: syntheticWrapped.toString("base64"),
      ciphertextCrc32c: String(kmsCore.crc32c(syntheticWrapped)),
      verifiedPlaintextCrc32c: true,
      verifiedAdditionalAuthenticatedDataCrc32c: true,
    }, kmsKeyName);
    expect(parsedWrapped.kmsKeyVersion).toBe(`${kmsKeyName}/cryptoKeyVersions/7`);
    const syntheticPlaintext = Buffer.alloc(32, 23);
    const parsedPlaintext = kmsCore.parseKmsDecryptResponse({
      plaintext: syntheticPlaintext.toString("base64"),
      plaintextCrc32c: String(kmsCore.crc32c(syntheticPlaintext)),
    });
    expect(parsedPlaintext).toEqual(syntheticPlaintext);
    parsedPlaintext.fill(0);
    syntheticPlaintext.fill(0);
    syntheticWrapped.fill(0);
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
    const kmsOrganizationId = randomUUID();
    const kmsUserId = `harness-kms-user-${suffix}`;
    const kmsMemberId = `harness-kms-member-${suffix}`;
    const kmsSessionId = `harness-kms-session-${suffix}`;
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
                 (${otherOrganizationId}, 'Other', ${`harness-other-${suffix}`}),
                 (${kmsOrganizationId}, 'KMS Harness', ${`harness-kms-${suffix}`})
        `;
        await tx`
          INSERT INTO "workspace_control"."user"
            ("id", "name", "email", "email_verified")
          VALUES (${userId}, 'Harness', ${`harness-${suffix}@invalid.test`}, TRUE),
                 (${kmsUserId}, 'KMS Harness', ${`harness-kms-${suffix}@invalid.test`}, TRUE)
        `;
        await tx`
          INSERT INTO "workspace_control"."member"
            ("id", "organization_id", "user_id", "role")
          VALUES (${memberId}, ${organizationId}, ${userId}, 'admin'),
                 (${kmsMemberId}, ${kmsOrganizationId}, ${kmsUserId}, 'owner')
        `;
        await tx`
          INSERT INTO "workspace_control"."session"
            ("id", "expires_at", "token", "user_id")
          VALUES (${sessionId}, now() + interval '10 minutes',
                  ${`harness-token-${suffix}`}, ${userId}),
                 (${kmsSessionId}, now() + interval '10 minutes',
                  ${`harness-kms-token-${suffix}`}, ${kmsUserId})
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_profile"
            ("organization_id", "encryption_key_ref")
          VALUES (${kmsOrganizationId}, ${`pending://${kmsOrganizationId}`})
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
            ${JSON.stringify({
              project: "harness-project",
              branch: "harness-branch",
              database: "app",
              engine: "postgres",
              schemas: ["public"],
            })}::jsonb,
            ${JSON.stringify({ production: false })}::jsonb,
            ${JSON.stringify({
              discover: true,
              importReadOnly: true,
              managedLease: true,
              write: false,
            })}::jsonb
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

      const [{ commitReportCreate, commitReportMutation }, reportContract] = await Promise.all([
        import("./workspace-report-store"),
        import("./workspace-reports"),
      ]);
      const reportId = randomUUID();
      const firstEvidenceId = randomUUID();
      const firstQueryRunId = randomUUID();
      const firstClaimId = randomUUID();
      const firstExecutedAt = new Date().toISOString();
      const reportInput = reportContract.parseSharedReportCreate({
        id: reportId,
        connectionId: left.connection.id,
        title: "Harness analysis",
        question: "How many active rows exist?",
        conclusion: "The durable read observed one bounded aggregate.",
        preflightWarnings: ["Harness evidence only"],
        claims: [{
          id: firstClaimId,
          statement: "The aggregate read completed successfully.",
          evidenceIds: [firstEvidenceId],
        }],
        evidence: [{
          id: firstEvidenceId,
          queryRunId: firstQueryRunId,
          sql: "SELECT count(*) AS active_rows FROM users WHERE active = TRUE",
          executedAt: firstExecutedAt,
        }],
      });
      const createdReport = await commitReportCreate({
        organizationId,
        report: reportInput,
        source: "agent_proposal",
        authority,
      });
      expect(createdReport).toMatchObject({
        id: reportId,
        connectionId: left.connection.id,
        state: "draft",
        source: "agent_proposal",
        revision: 1,
        evidenceCount: 1,
      });

      const secondEvidenceId = randomUUID();
      const secondQueryRunId = randomUUID();
      const secondClaimId = randomUUID();
      const secondEvidence = reportContract.parseSharedReportEvidenceList([{
        id: secondEvidenceId,
        queryRunId: secondQueryRunId,
        sql: "SELECT count(*) AS active_rows FROM users WHERE active = TRUE AND deleted_at IS NULL",
        executedAt: new Date().toISOString(),
      }]);
      const rerunDefinition = reportContract.parseSharedReportDefinition({
        title: reportInput.title,
        question: reportInput.question,
        conclusion: "Two immutable reads support the reviewed aggregate.",
        preflightWarnings: reportInput.preflightWarnings,
        claims: [
          ...reportInput.claims,
          {
            id: secondClaimId,
            statement: "The rerun excluded deleted rows.",
            evidenceIds: [secondEvidenceId],
          },
        ],
      });
      const rerunReport = await commitReportMutation({
        organizationId,
        reportId,
        connectionId: left.connection.id,
        expectedRevision: 1,
        definition: rerunDefinition,
        state: "draft",
        source: "agent_proposal",
        ownerMemberId: memberId,
        authority,
        operation: "append_evidence",
        evidence: secondEvidence,
      });
      expect(rerunReport).toMatchObject({ revision: 2, evidenceCount: 2, state: "draft" });
      await expect(commitReportMutation({
        organizationId,
        reportId,
        connectionId: left.connection.id,
        expectedRevision: 1,
        definition: reportInput,
        state: "draft",
        source: "agent_proposal",
        ownerMemberId: memberId,
        authority,
        operation: "update",
      })).resolves.toBeNull();
      const reviewReport = await commitReportMutation({
        organizationId,
        reportId,
        connectionId: left.connection.id,
        expectedRevision: 2,
        definition: rerunDefinition,
        state: "review",
        source: "agent_proposal",
        ownerMemberId: memberId,
        authority,
        operation: "submit_review",
      });
      expect(reviewReport).toMatchObject({ revision: 3, evidenceCount: 2, state: "review" });
      const publishedReport = await commitReportMutation({
        organizationId,
        reportId,
        connectionId: left.connection.id,
        expectedRevision: 3,
        definition: rerunDefinition,
        state: "published",
        source: "agent_proposal",
        ownerMemberId: memberId,
        authority,
        operation: "publish",
      });
      expect(publishedReport).toMatchObject({
        revision: 4,
        evidenceCount: 2,
        state: "published",
      });
      await expect(sql`
        UPDATE "workspace_control"."workspace_report_evidence"
        SET "sql" = 'SELECT 0'
        WHERE "organization_id" = ${organizationId}
          AND "report_id" = ${reportId}::uuid
          AND "id" = ${firstEvidenceId}::uuid
      `).rejects.toThrow(/immutable/);
      const reportDurability = await sql<{
        evidence: number;
        revisions: number;
        resultColumns: number;
      }[]>`
        SELECT
          (SELECT count(*)::int
           FROM "workspace_control"."workspace_report_evidence"
           WHERE "organization_id" = ${organizationId}
             AND "report_id" = ${reportId}::uuid) AS "evidence",
          (SELECT count(*)::int
           FROM "workspace_control"."workspace_report_revision"
           WHERE "organization_id" = ${organizationId}
             AND "report_id" = ${reportId}::uuid) AS "revisions",
          (SELECT count(*)::int
           FROM information_schema.columns
           WHERE table_schema = 'workspace_control'
             AND table_name IN (
               'workspace_report',
               'workspace_report_evidence',
               'workspace_report_revision'
             )
             AND column_name ~ '(result|artifact|credential|transcript)') AS "resultColumns"
      `;
      expect(reportDurability[0]).toEqual({ evidence: 2, revisions: 4, resultColumns: 0 });

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

      const previousCredentialKey = process.env.WORKSPACE_CREDENTIAL_KEY;
      process.env.WORKSPACE_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64url");
      try {
        const [{ canonicalHash }, { providerOperationOwnershipMarker }, switchPlanModule,
          { providerImportProjection }, { completeNeonBranchSwitch }] = await Promise.all([
          import("./workspace-versioning"),
          import("./provider-operation-marker"),
          import("./providers/neon-branch-switch-plan"),
          import("./providers/import-projection"),
          import("./provider-operation-store"),
        ]);
        const sourceResource = {
          project: "harness-project",
          branch: "harness-branch",
          databaseId: "123456789",
          database: "app",
          engine: "postgres" as const,
          schemas: ["public"],
        };
        const targetResource = {
          ...sourceResource,
          branch: "harness-target",
          databaseId: "987654321",
        };
        const sourceProjection = providerImportProjection("neon", sourceResource, {
          production: false,
          writeAvailable: true,
        });
        const targetProjection = providerImportProjection("neon", targetResource, {
          production: false,
          writeAvailable: true,
        });
        const operationId = randomUUID();
        const operationClaimId = randomUUID();
        const connectionClaimId = randomUUID();
        const plannedAt = new Date();
        const inventory = {
          projectId: sourceResource.project,
          rootIds: [sourceResource.branch],
          branches: [
            {
              id: sourceResource.branch,
              projectId: sourceResource.project,
              parentId: null,
              treeParentId: null,
              name: "Harness source",
              currentState: "ready" as const,
              pendingState: null,
              stateChangedAt: plannedAt.toISOString(),
              createdAt: plannedAt.toISOString(),
              updatedAt: plannedAt.toISOString(),
              creationSource: "primary",
              initSource: "parent-data" as const,
              sourceLsn: null,
              sourceTimestamp: null,
              default: true,
              protected: false,
              expiresAt: null,
              restrictedActions: [],
              production: false as const,
              ready: true,
              depth: 0,
            },
            {
              id: targetResource.branch,
              projectId: targetResource.project,
              parentId: sourceResource.branch,
              treeParentId: sourceResource.branch,
              name: "Harness target",
              currentState: "ready" as const,
              pendingState: null,
              stateChangedAt: plannedAt.toISOString(),
              createdAt: plannedAt.toISOString(),
              updatedAt: plannedAt.toISOString(),
              creationSource: "branch",
              initSource: "parent-data" as const,
              sourceLsn: null,
              sourceTimestamp: null,
              default: false,
              protected: false,
              expiresAt: null,
              restrictedActions: [],
              production: false as const,
              ready: true,
              depth: 1,
            },
          ],
        };
        const plan = switchPlanModule.buildNeonBranchSwitchPlan({
          request: switchPlanModule.parseNeonBranchSwitchPlanRequest({
            idempotencyKey: randomUUID(),
            projectId: sourceResource.project,
            connectionId: left.connection.id,
            targetBranchId: targetResource.branch,
            targetEnvironment: "development",
          }),
          inventory,
          connection: {
            connectionId: left.connection.id,
            connectionName: left.connection.name,
            providerResourceId: resourceId,
            projectId: sourceResource.project,
            sourceBranchId: sourceResource.branch,
            databaseId: sourceResource.databaseId,
            database: sourceResource.database,
            schemas: sourceResource.schemas,
            environment: "development",
            readonlyDefault: left.connection.readonlyDefault,
            allowWrites: left.connection.allowWrites,
            schemaGroup: left.connection.schemaGroup,
            contentRevision: 1,
            authorityRevision: 1,
            activeLeaseCount: 0,
          },
          target: {
            branch: inventory.branches[1],
            databaseId: targetResource.databaseId,
            database: targetResource.database,
            endpointId: "ep-harness-target",
            databaseFingerprint: "e".repeat(64),
            resourceFingerprint: targetProjection.fingerprint,
            managedAccessOperationId: null,
          },
          operationId,
          integrationId,
          integrationGeneration: 2n,
          now: plannedAt,
        });
        const planHash = canonicalHash(plan);
        const ownershipMarker = providerOperationOwnershipMarker({
          organizationId,
          integrationId,
          integrationGeneration: 2n,
          operationId,
          planHash,
        });
        await sql.begin(async (tx) => {
          await tx`
            UPDATE "workspace_control"."workspace_provider_resource"
            SET "resource_fingerprint" = ${sourceProjection.fingerprint},
                "resource" = ${JSON.stringify(sourceProjection.resource)}::jsonb,
                "redacted_metadata" = ${JSON.stringify(sourceProjection.metadata)}::jsonb,
                "capability_manifest" = ${JSON.stringify(sourceProjection.capabilities)}::jsonb
            WHERE "organization_id" = ${organizationId}
              AND "id" = ${resourceId}::uuid
          `;
          await tx`
            UPDATE "workspace_control"."workspace_connection"
            SET "provider_resource" = ${JSON.stringify(sourceProjection.resource)}::jsonb,
                "environment" = 'development',
                "revision" = 2,
                "revocation_pending_at" = ${plannedAt.toISOString()}::timestamptz,
                "revocation_claimed_at" = ${plannedAt.toISOString()}::timestamptz,
                "revocation_claim_id" = ${connectionClaimId}::uuid
            WHERE "organization_id" = ${organizationId}
              AND "id" = ${left.connection.id}::uuid
          `;
          await tx`
            INSERT INTO "workspace_control"."workspace_provider_operation"
              ("id", "organization_id", "integration_id", "provider",
               "integration_generation", "kind", "state", "idempotency_key",
               "request_hash", "plan_hash", "plan_expires_at", "risk",
               "approval_policy", "requested_by_member_id", "requested_by_user_id",
               "requested_by_session_id", "requested_by_role", "resource_scope",
               "source_resource_id", "target_name", "ownership_marker",
               "redacted_plan", "claim_id", "claimed_at", "remote_started_at",
               "created_at", "updated_at")
            VALUES
              (${operationId}::uuid, ${organizationId}, ${integrationId}::uuid, 'neon',
               2, 'neon.branch.switch', 'remote_started', ${randomUUID()}::uuid,
               ${"a".repeat(64)}, ${planHash}, ${plan.expiresAt}, 'standard',
               'single_admin', ${memberId}, ${userId}, ${sessionId}, 'admin',
               ${sourceResource.project}, ${sourceResource.branch}, ${plan.target.name},
               ${ownershipMarker}, ${JSON.stringify(plan)}::jsonb, ${operationClaimId}::uuid,
               ${plannedAt.toISOString()}::timestamptz,
               ${plannedAt.toISOString()}::timestamptz,
               ${plannedAt.toISOString()}::timestamptz,
               ${plannedAt.toISOString()}::timestamptz)
          `;
        });
        const switchPreflight = await sql<{
          operationReady: boolean;
          authorityReady: boolean;
          connectionReady: boolean;
          parentReady: boolean;
          grantReady: boolean;
          leasesEmpty: boolean;
        }[]>`
          SELECT
            EXISTS (
              SELECT 1 FROM "workspace_control"."workspace_provider_operation" operation
              WHERE operation."id" = ${operationId}::uuid
                AND operation."organization_id" = ${organizationId}
                AND operation."integration_id" = ${integrationId}::uuid
                AND operation."integration_generation" = 2
                AND operation."state" = 'remote_started'
                AND operation."claim_id" = ${operationClaimId}::uuid
                AND operation."plan_hash" = ${planHash}
                AND operation."ownership_marker" = ${ownershipMarker}
                AND operation."redacted_plan" = ${JSON.stringify(plan)}::jsonb
            ) AS "operationReady",
            EXISTS (
              SELECT 1
              FROM "workspace_control"."session" live_session
              JOIN "workspace_control"."member" live_member
                ON live_member."id" = ${memberId}
               AND live_member."organization_id" = ${organizationId}
               AND live_member."user_id" = ${userId}
              JOIN "workspace_control"."workspace_provider_integration" integration
                ON integration."id" = ${integrationId}::uuid
               AND integration."organization_id" = ${organizationId}
               AND integration."provider" = 'neon'
               AND integration."generation" = 2
               AND integration."revocation_claim_id" IS NULL
              WHERE live_session."id" = ${sessionId}
                AND live_session."user_id" = ${userId}
                AND live_session."expires_at" > now()
                AND live_member."role" = 'admin'
                AND live_member."revocation_pending_at" IS NULL
                AND live_member."revocation_claim_id" IS NULL
            ) AS "authorityReady",
            EXISTS (
              SELECT 1
              FROM "workspace_control"."workspace_connection" connection
              JOIN "workspace_control"."workspace_provider_resource" source_resource
                ON source_resource."organization_id" = connection."organization_id"
               AND source_resource."id" = connection."provider_resource_id"
               AND source_resource."resource" = connection."provider_resource"
              WHERE connection."id" = ${left.connection.id}::uuid
                AND connection."organization_id" = ${organizationId}
                AND connection."provider_resource_id" = ${resourceId}::uuid
                AND connection."provider_resource"->>'project' = ${sourceResource.project}
                AND connection."provider_resource"->>'branch' = ${sourceResource.branch}
                AND connection."provider_resource"->>'databaseId' = ${sourceResource.databaseId}
                AND connection."provider_resource"->>'database' = ${sourceResource.database}
                AND connection."name" = ${left.connection.name}
                AND connection."readonly_default" = ${left.connection.readonlyDefault}
                AND connection."allow_writes" = ${left.connection.allowWrites}
                AND connection."schema_group" IS NOT DISTINCT FROM ${left.connection.schemaGroup}
                AND connection."environment" = 'development'
                AND connection."content_revision" = 1
                AND connection."revision" = 2
                AND connection."revocation_pending_at" IS NOT NULL
                AND connection."revocation_claim_id" = ${connectionClaimId}::uuid
                AND connection."deleted_at" IS NULL
            ) AS "connectionReady",
            EXISTS (
              SELECT 1 FROM "workspace_control"."workspace_resource_version" version
              WHERE version."organization_id" = ${organizationId}
                AND version."resource_type" = 'connection'
                AND version."resource_id" = ${left.connection.id}::uuid
                AND version."branch" = 'main'
                AND version."revision" = 1
            ) AS "parentReady",
            EXISTS (
              SELECT 1 FROM "workspace_control"."workspace_connection_grant" grant_row
              WHERE grant_row."organization_id" = ${organizationId}
                AND grant_row."connection_id" = ${left.connection.id}::uuid
                AND grant_row."member_id" = ${memberId}
                AND grant_row."capability" = 'manage'
            ) AS "grantReady",
            NOT EXISTS (
              SELECT 1 FROM "workspace_control"."workspace_credential_lease" lease
              WHERE lease."organization_id" = ${organizationId}
                AND lease."connection_id" = ${left.connection.id}::uuid
                AND lease."revoked_at" IS NULL
            ) AS "leasesEmpty"
        `;
        expect(switchPreflight[0]).toEqual({
          operationReady: true,
          authorityReady: true,
          connectionReady: true,
          parentReady: true,
          grantReady: true,
          leasesEmpty: true,
        });
        let completion;
        try {
          completion = await completeNeonBranchSwitch({
            authority: { organizationId, ...authority },
            integrationId,
            integrationGeneration: 2n,
            operationId,
            kind: "neon.branch.switch",
            planHash,
            ownershipMarker,
            claimId: operationClaimId,
            connectionClaimId,
            plan,
            targetProjection,
            now: new Date(plannedAt.valueOf() + 1_000),
          });
        } catch (error) {
          const cause = error && typeof error === "object"
            ? (error as { cause?: unknown }).cause
            : null;
          const causeMessage = cause && typeof cause === "object"
            && typeof (cause as { message?: unknown }).message === "string"
            ? (cause as { message: string }).message
            : null;
          const errorMessage = error && typeof error === "object"
            && typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message
            : null;
          const message = causeMessage
            ?? (errorMessage && !errorMessage.startsWith("Failed query:")
              ? errorMessage
              : "Neon branch switch SQL failed");
          throw new Error(message);
        }
        expect(completion).toMatchObject({
          operationId,
          connectionId: left.connection.id,
          contentRevision: 2,
          authorityRevision: 2,
          targetBranchId: targetResource.branch,
        });
        const switched = await sql<{
          branchId: string;
          databaseId: string;
          contentRevision: number;
          authorityRevision: number;
          pending: boolean;
          operationState: string;
          versions: number;
          switchAudits: number;
        }[]>`
          SELECT connection."provider_resource"->>'branch' AS "branchId",
            connection."provider_resource"->>'databaseId' AS "databaseId",
            connection."content_revision"::int AS "contentRevision",
            connection."revision"::int AS "authorityRevision",
            connection."revocation_pending_at" IS NOT NULL AS "pending",
            operation."state" AS "operationState",
            (SELECT count(*)::int
             FROM "workspace_control"."workspace_resource_version" version
             WHERE version."organization_id" = connection."organization_id"
               AND version."resource_type" = 'connection'
               AND version."resource_id" = connection."id") AS "versions",
            (SELECT count(*)::int
             FROM "workspace_control"."workspace_audit_event" event
             WHERE event."organization_id" = connection."organization_id"
               AND event."action" IN (
                 'connection.provider_target.switch', 'provider.operation.succeeded'
               )) AS "switchAudits"
          FROM "workspace_control"."workspace_connection" connection
          JOIN "workspace_control"."workspace_provider_operation" operation
            ON operation."organization_id" = connection."organization_id"
           AND operation."id" = ${operationId}::uuid
          WHERE connection."organization_id" = ${organizationId}
            AND connection."id" = ${left.connection.id}::uuid
        `;
        expect(switched[0]).toEqual({
          branchId: targetResource.branch,
          databaseId: targetResource.databaseId,
          contentRevision: 2,
          authorityRevision: 2,
          pending: false,
          operationState: "succeeded",
          versions: 2,
          switchAudits: 2,
        });
      } finally {
        if (previousCredentialKey === undefined) {
          delete process.env.WORKSPACE_CREDENTIAL_KEY;
        } else {
          process.env.WORKSPACE_CREDENTIAL_KEY = previousCredentialKey;
        }
      }

      const [versionStore, versionContract] = await Promise.all([
        import("./workspace-versioning-store"),
        import("./workspace-versioning"),
      ]);
      const currentRows = await sql<{
        name: string;
        engine: "postgres";
        provider: "neon";
        driverId: string | null;
        host: string;
        port: number;
        database: string;
        sslmode: string;
        readonlyDefault: boolean;
        allowWrites: boolean;
        env: string | null;
        schemaGroup: string | null;
        contentRevision: number;
      }[]>`
        SELECT "name", "engine", "provider", "driver_id" AS "driverId",
          "host", "port", "database_name" AS "database", "sslmode",
          "readonly_default" AS "readonlyDefault", "allow_writes" AS "allowWrites",
          "environment" AS "env", "schema_group" AS "schemaGroup",
          "content_revision"::int AS "contentRevision"
        FROM "workspace_control"."workspace_connection"
        WHERE "organization_id" = ${organizationId}
          AND "id" = ${left.connection.id}::uuid
      `;
      const currentConnection = currentRows[0];
      if (!currentConnection || currentConnection.contentRevision !== 2) {
        throw new Error("Conflict harness requires the switched connection revision");
      }
      const { contentRevision: _contentRevision, ...currentTemplate } = currentConnection;
      const keptCandidate = versionContract.connectionVersionPayload({
        ...currentTemplate,
        name: "Harness stale candidate",
      });
      const keptConflictId = await versionStore.conflictConnectionCandidate({
        organizationId,
        connectionId: left.connection.id,
        expectedRevision: 1,
        payload: keptCandidate,
        authority,
      });
      const openKept = await versionStore.listConnectionConflicts({
        organizationId,
        membershipId: memberId,
      });
      expect(openKept).toHaveLength(1);
      expect(openKept[0]).toMatchObject({
        id: keptConflictId,
        connectionId: left.connection.id,
        currentMatchesServer: true,
        currentMatchesCandidate: false,
        current: { revision: 2 },
        server: { revision: 2 },
        candidate: { revision: 1, payload: { name: "Harness stale candidate" } },
      });
      await expect(versionStore.listConnectionConflicts({
        organizationId: otherOrganizationId,
        membershipId: memberId,
      })).resolves.toEqual([]);
      await expect(versionStore.resolveConnectionConflict({
        organizationId,
        conflictId: keptConflictId,
        resolution: "server",
        authority,
      })).resolves.toEqual({ resolution: "server", created: true });
      await expect(versionStore.resolveConnectionConflict({
        organizationId,
        conflictId: keptConflictId,
        resolution: "server",
        authority,
      })).resolves.toEqual({ resolution: "server", created: false });

      const appliedCandidate = versionContract.connectionVersionPayload({
        ...currentTemplate,
        name: "Harness applied candidate",
      });
      const appliedConflictId = await versionStore.conflictConnectionCandidate({
        organizationId,
        connectionId: left.connection.id,
        expectedRevision: 1,
        payload: appliedCandidate,
        authority,
      });
      const appliedHash = versionContract.canonicalHash(appliedCandidate);
      await sql.begin(async (tx) => {
        await tx`
          UPDATE "workspace_control"."workspace_connection"
          SET "name" = ${appliedCandidate.name}, "content_revision" = 3,
              "updated_at" = now()
          WHERE "organization_id" = ${organizationId}
            AND "id" = ${left.connection.id}::uuid
            AND "content_revision" = 2
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_resource_version"
            ("organization_id", "resource_type", "resource_id", "revision",
             "base_revision", "parent_version_id", "branch", "operation",
             "payload", "payload_hash", "created_by_user_id")
          SELECT ${organizationId}, 'connection', ${left.connection.id}::uuid, 3, 2,
            parent."id", 'main', 'update', ${JSON.stringify(appliedCandidate)}::jsonb,
            ${appliedHash}, ${userId}
          FROM "workspace_control"."workspace_resource_version" parent
          WHERE parent."organization_id" = ${organizationId}
            AND parent."resource_type" = 'connection'
            AND parent."resource_id" = ${left.connection.id}::uuid
            AND parent."branch" = 'main' AND parent."revision" = 2
        `;
      });
      await expect(versionStore.resolveConnectionConflict({
        organizationId,
        conflictId: appliedConflictId,
        resolution: "candidate",
        authority,
      })).resolves.toEqual({ resolution: "candidate", created: true });
      await expect(versionStore.resolveConnectionConflict({
        organizationId,
        conflictId: appliedConflictId,
        resolution: "server",
        authority,
      })).resolves.toEqual({ resolution: "candidate", created: false });

      const deleteCandidate = versionContract.connectionVersionPayload({
        ...currentTemplate,
        name: "Harness applied candidate",
      }, true);
      const deleteConflictId = await versionStore.conflictConnectionCandidate({
        organizationId,
        connectionId: left.connection.id,
        expectedRevision: 2,
        payload: deleteCandidate,
        authority,
        operation: "delete",
      });
      const deleteHash = versionContract.canonicalHash(deleteCandidate);
      await sql.begin(async (tx) => {
        await tx`
          UPDATE "workspace_control"."workspace_connection"
          SET "deleted_at" = now(), "content_revision" = 4, "updated_at" = now()
          WHERE "organization_id" = ${organizationId}
            AND "id" = ${left.connection.id}::uuid
            AND "content_revision" = 3
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_resource_version"
            ("organization_id", "resource_type", "resource_id", "revision",
             "base_revision", "parent_version_id", "branch", "operation",
             "payload", "payload_hash", "created_by_user_id")
          SELECT ${organizationId}, 'connection', ${left.connection.id}::uuid, 4, 3,
            parent."id", 'main', 'delete', ${JSON.stringify(deleteCandidate)}::jsonb,
            ${deleteHash}, ${userId}
          FROM "workspace_control"."workspace_resource_version" parent
          WHERE parent."organization_id" = ${organizationId}
            AND parent."resource_type" = 'connection'
            AND parent."resource_id" = ${left.connection.id}::uuid
            AND parent."branch" = 'main' AND parent."revision" = 3
        `;
      });
      const deleteReview = await versionStore.listConnectionConflicts({
        organizationId,
        membershipId: memberId,
      });
      expect(deleteReview).toHaveLength(1);
      expect(deleteReview[0]).toMatchObject({
        id: deleteConflictId,
        currentMatchesCandidate: true,
        current: { revision: 4, operation: "delete" },
        candidate: { operation: "delete", payload: { deleted: true } },
      });
      await expect(versionStore.resolveConnectionConflict({
        organizationId,
        conflictId: deleteConflictId,
        resolution: "candidate",
        authority,
      })).resolves.toEqual({ resolution: "candidate", created: true });
      await expect(versionStore.listConnectionConflicts({
        organizationId,
        membershipId: memberId,
      })).resolves.toEqual([]);
      await expect(sql`
        UPDATE "workspace_control"."workspace_resource_conflict_resolution"
        SET "resolution" = 'dismissed'
        WHERE "organization_id" = ${organizationId}
          AND "conflict_id" = ${appliedConflictId}::uuid
      `).rejects.toThrow(/append-only/);

      vi.doMock("./workspace-kms", () => ({
        wrapWorkspaceDataKey: async (wrappedInput: {
          configuration: { keyName: string };
          version: number;
          plaintextKey: Buffer;
        }) => ({
          kmsKeyVersion: `${wrappedInput.configuration.keyName}/cryptoKeyVersions/${wrappedInput.version}`,
          wrappedKey: Buffer.from(wrappedInput.plaintextKey).toString("base64"),
        }),
        unwrapWorkspaceDataKey: async (wrappedInput: { wrappedKey: string }) =>
          Buffer.from(wrappedInput.wrappedKey, "base64"),
        workspaceKmsAccessToken: async () => "unused-harness-access-token",
        workspaceKmsConfiguration: () => { throw new Error("unused harness configuration"); },
        workspaceKmsOidcToken: () => { throw new Error("unused harness OIDC token"); },
      }));
      const [dataKeyStore, dataKeyRotation, workspaceBackup] = await Promise.all([
        import("./workspace-data-key"),
        import("./workspace-data-key-rotation"),
        import("./workspace-backup"),
      ]);
      const kmsSession = {
        configuration: {
          keyName: kmsKeyName,
          workloadIdentityAudience: "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel/providers/workspace",
          serviceAccountEmail: "workspace-kms@dopedb-harness.iam.gserviceaccount.com",
        },
        accessToken: "harness-access-token",
      };
      const kmsAuthority = {
        sessionId: kmsSessionId,
        userId: kmsUserId,
        membershipId: kmsMemberId,
      };
      const firstDataKey = await dataKeyStore.ensureActiveWorkspaceDataKey({
        organizationId: kmsOrganizationId,
        actorUserId: kmsUserId,
        kms: kmsSession,
      });
      expect(firstDataKey.version).toBe(1);
      const backupId = randomUUID();
      const kmsSnapshot = {
        version: 1 as const,
        workspace: {
          organizationId: kmsOrganizationId,
          lifecycleState: "active",
          residencyRegion: null,
          revision: 1,
        },
        connections: [],
      };
      const firstCiphertext = await dataKeyStore.withWorkspaceDataKey(
        kmsSession,
        firstDataKey,
        (key) => workspaceBackup.sealWorkspaceMetadataBackupWithDataKey(
          key,
          firstDataKey,
          backupId,
          kmsSnapshot,
        ),
      );
      await sql`
        INSERT INTO "workspace_control"."workspace_metadata_backup"
          ("id", "organization_id", "source_revision", "key_reference", "key_version",
           "data_key_id", "ciphertext", "snapshot_hash", "created_by_user_id")
        VALUES (${backupId}::uuid, ${kmsOrganizationId}, 1,
          ${workspaceBackup.WORKSPACE_DATA_KEY_REFERENCE},
          ${workspaceBackup.workspaceDataKeyVersion(firstDataKey.version)},
          ${firstDataKey.id}::uuid, ${firstCiphertext},
          ${workspaceBackup.snapshotHash(kmsSnapshot)}, ${kmsUserId})
      `;
      await expect(sql`
        UPDATE "workspace_control"."workspace_metadata_backup"
        SET "ciphertext" = 'unauthorized-rewrite'
        WHERE "id" = ${backupId}::uuid
      `).rejects.toThrow(/immutable outside an active key rotation/);
      const rotationRequestId = randomUUID();
      const startedRotation = await dataKeyRotation.beginOrClaimWorkspaceDataKeyRotation({
        organizationId: kmsOrganizationId,
        authority: kmsAuthority,
        kms: kmsSession,
        idempotencyKey: rotationRequestId,
      });
      expect(startedRotation.replayed).toBe(false);
      expect(startedRotation.claim).not.toBeNull();
      if (!startedRotation.claim) throw new Error("KMS harness rotation was not claimed");
      const advancedRotation = await dataKeyRotation.advanceWorkspaceDataKeyRotation({
        organizationId: kmsOrganizationId,
        authority: kmsAuthority,
        kms: kmsSession,
        claim: startedRotation.claim,
      });
      expect(advancedRotation).toEqual({
        status: "completed",
        processedBackups: 1,
        remaining: 0,
      });
      const rotationStatus = await dataKeyRotation.workspaceDataKeyRotationStatus(
        kmsOrganizationId,
      );
      expect(rotationStatus).toMatchObject({
        activeVersion: 2,
        backupCount: 1,
        rotation: {
          status: "completed",
          fromVersion: 1,
          toVersion: 2,
          processedBackups: 1,
          remainingBackups: 0,
        },
      });
      const replayedRotation = await dataKeyRotation.beginOrClaimWorkspaceDataKeyRotation({
        organizationId: kmsOrganizationId,
        authority: kmsAuthority,
        kms: kmsSession,
        idempotencyKey: rotationRequestId,
      });
      expect(replayedRotation).toEqual({ claim: null, busy: false, replayed: true });
      const rotatedBackup = await sql<{
        ciphertext: string;
        dataKeyId: string;
        keyVersion: string;
        rotationId: string;
      }[]>`
        SELECT "ciphertext" AS "ciphertext", "data_key_id"::text AS "dataKeyId",
          "key_version" AS "keyVersion",
          "reencrypted_by_rotation_id"::text AS "rotationId"
        FROM "workspace_control"."workspace_metadata_backup"
        WHERE "id" = ${backupId}::uuid AND "organization_id" = ${kmsOrganizationId}
      `;
      expect(rotatedBackup[0]).toMatchObject({
        dataKeyId: expect.any(String),
        keyVersion: "v2",
        rotationId: rotationStatus.rotation?.id,
      });
      const secondDataKey = await dataKeyStore.workspaceDataKeyById(
        kmsOrganizationId,
        rotatedBackup[0]!.dataKeyId,
      );
      if (!secondDataKey) throw new Error("KMS harness target key is missing");
      const reopenedSnapshot = await workspaceBackup.openWorkspaceMetadataBackupWithKms(
        kmsSession,
        {
          workspaceId: kmsOrganizationId,
          backupId,
          ciphertext: rotatedBackup[0]!.ciphertext,
          binding: {
            dataKeyId: secondDataKey.id,
            keyReference: workspaceBackup.WORKSPACE_DATA_KEY_REFERENCE,
            keyVersion: workspaceBackup.workspaceDataKeyVersion(secondDataKey.version),
          },
        },
      );
      expect(reopenedSnapshot).toEqual(kmsSnapshot);
      const retiredKeyState = await sql<{ wrappedKey: string | null; destroyed: boolean }[]>`
        SELECT "wrapped_key" AS "wrappedKey", "destroyed_at" IS NOT NULL AS "destroyed"
        FROM "workspace_control"."workspace_data_key"
        WHERE "id" = ${firstDataKey.id}::uuid
          AND "organization_id" = ${kmsOrganizationId}
      `;
      expect(retiredKeyState[0]).toEqual({ wrappedKey: null, destroyed: true });
      await expect(sql`
        UPDATE "workspace_control"."workspace_metadata_backup"
        SET "ciphertext" = 'post-rotation-rewrite'
        WHERE "id" = ${backupId}::uuid
      `).rejects.toThrow(/immutable outside an active key rotation/);

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
        WHERE "id" IN (${organizationId}, ${otherOrganizationId}, ${kmsOrganizationId})
      `.catch(() => undefined);
      await sql`
        DELETE FROM "workspace_control"."user" WHERE "id" IN (${userId}, ${kmsUserId})
      `.catch(() => undefined);
      await sql.end({ timeout: 5 });
      vi.doUnmock("./db");
      vi.doUnmock("./workspace-kms");
    }
  }, 60_000);
});
