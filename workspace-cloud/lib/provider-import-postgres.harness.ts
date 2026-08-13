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
        AND to_regclass('workspace_control.workspace_deletion_receipt') IS NOT NULL
        AND to_regclass('workspace_control.workspace_sync_head') IS NOT NULL
        AND to_regclass('workspace_control.workspace_sync_event') IS NOT NULL
        AND to_regclass('workspace_control.knowledge_project') IS NOT NULL
        AND to_regclass('workspace_control.knowledge_project_environment') IS NOT NULL
        AND to_regclass('workspace_control.workspace_analysis_article') IS NOT NULL
        AND to_regclass('workspace_control.workspace_analysis_article_revision') IS NOT NULL
        AND to_regclass('workspace_control.workspace_analysis_article_run') IS NOT NULL
        AND to_regclass('workspace_control.workspace_analysis_result_fragment') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'workspace_control'
            AND table_name = 'workspace_provider_integration'
            AND column_name = 'local_verification_target'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'workspace_control'
            AND table_name = 'workspace_analysis_runner'
            AND column_name = 'runner_capability_generation'
            AND is_nullable = 'YES'
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
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'workspace_control'
            AND table_name = 'workspace_metadata_backup'
            AND column_name = 'purge_after'
        )
        AND to_regprocedure('workspace_control.purge_due_workspace(text,uuid)') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'workspace_control.workspace_metadata_backup'::regclass
            AND tgname = 'workspace_metadata_backup_payload_immutable'
            AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'workspace_control.workspace_audit_event'::regclass
            AND tgname = 'workspace_audit_append_sync_event'
            AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'workspace_control.workspace_analysis_article_revision'::regclass
            AND tgname = 'workspace_analysis_article_revision_immutable_update'
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
      query: async (
        query: string,
        parameters: Parameters<typeof sql.unsafe>[1] = [],
      ) => (
        sql.unsafe(query, parameters)
      ),
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
    let authoritativeFixture: Record<string, unknown> | null = null;
    let authoritativeBearer = "";
    let authoritativeCookie = "";
    const getSession = vi.fn(async ({ headers }: { headers: Headers }) => (
      authoritativeFixture
      && (
        headers.get("authorization") === authoritativeBearer
        || headers.get("cookie") === authoritativeCookie
      )
        ? authoritativeFixture
        : null
    ));
    vi.doMock("./auth", () => ({ auth: { api: { getSession } } }));
    const serverLog = await import("./workspace-server-log");
    const { boundedJsonBody, privateJsonStream } = await import("./http");
    const streamedFixture = {
      nested: [{ value: "한글🙂".repeat(20_000), omitted: undefined }, Number.NaN],
      date: new Date("2026-08-14T00:00:00.000Z"),
    };
    const streamedResponse = privateJsonStream(streamedFixture);
    expect(await streamedResponse.text()).toBe(JSON.stringify(streamedFixture));
    expect(streamedResponse.headers.get("cache-control")).toBe("private, no-store");
    const boundedFixture = JSON.stringify({ label: "한글🙂" });
    const boundedBytes = new TextEncoder().encode(boundedFixture).byteLength;
    await expect(boundedJsonBody(new Request("https://dopedb.invalid", {
      method: "POST",
      body: boundedFixture,
    }), boundedBytes)).resolves.toEqual({
      ok: true,
      value: { label: "한글🙂" },
    });
    await expect(boundedJsonBody(new Request("https://dopedb.invalid", {
      method: "POST",
      body: boundedFixture,
    }), boundedBytes - 1)).resolves.toEqual({
      ok: false,
      reason: "too_large",
    });
    await expect(boundedJsonBody(new Request("https://dopedb.invalid", {
      method: "POST",
      body: new Uint8Array([0xff]),
    }), 1)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      serverLog.logProviderConnectionFailure({
        provider: "secret-provider-token",
        stage: "password-stage",
        postgresCode: "credential-value",
        providerStatus: 999,
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
      serverLog.logKnowledgeMutationFailure({
        operation: "credential-value",
        databaseCode: "password-value",
      });
      expect(serverLog.databaseErrorCode({ cause: { code: "23505" } })).toBe("23505");
      expect(serverLog.databaseErrorCode({ cause: { code: "password-value" } })).toBeNull();
      expect(logSpy.mock.calls).toEqual([
        ["provider_connection_failed", {
          provider: "other",
          stage: "other",
          databaseKind: null,
          providerStatus: 0,
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
        ["knowledge_mutation_failed", {
          operation: "other",
          databaseKind: null,
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
    const [{ importProviderReceipt }, projectStore, { revocationGateLockKey }] = await Promise.all([
      import("./provider-import-store"),
      import("./knowledge/project-store"),
      import("./revocation-gates"),
    ]);

    const suffix = randomUUID();
    const organizationId = `harness-org-${suffix}`;
    const otherOrganizationId = `harness-other-${suffix}`;
      const userId = `harness-user-${suffix}`;
      const memberId = `harness-member-${suffix}`;
      const sessionId = `harness-session-${suffix}`;
      const removableUserId = `harness-removable-user-${suffix}`;
      const removableMemberId = `harness-removable-member-${suffix}`;
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
    const knowledgeAuthority = {
      ...authority,
      organizationId,
      capability: "manage" as const,
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
                 (${removableUserId}, 'Removable Harness',
                  ${`harness-removable-${suffix}@invalid.test`}, TRUE),
                 (${kmsUserId}, 'KMS Harness', ${`harness-kms-${suffix}@invalid.test`}, TRUE)
        `;
        await tx`
          INSERT INTO "workspace_control"."member"
            ("id", "organization_id", "user_id", "role")
          VALUES (${memberId}, ${organizationId}, ${userId}, 'admin'),
                 (${removableMemberId}, ${organizationId}, ${removableUserId}, 'viewer'),
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
          VALUES (${organizationId}, ${`pending://${organizationId}`}),
                 (${otherOrganizationId}, ${`pending://${otherOrganizationId}`})
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

      // Authorization and browser cookies are mutually exclusive authority
      // sources. A syntactically valid but unverifiable Bearer value must not
      // fall through to an otherwise valid browser session, including on the
      // route that issues the clear runner capability.
      const sessionToken = `harness-token-${suffix}`;
      authoritativeBearer = `Bearer ${sessionToken}`;
      authoritativeCookie = `better-auth.session_token=harness-cookie-${suffix}`;
      authoritativeFixture = {
        session: { id: sessionId, token: sessionToken, userId },
        user: { id: userId },
      };
      const { authoritativeSession, authoritativeSessionHeaders } = await import(
        "./authoritative-session"
      );
      const cookieOnlyRequest = new Request("https://dopedb.invalid", {
        headers: { cookie: authoritativeCookie },
      });
      expect(await authoritativeSession(cookieOnlyRequest)).toMatchObject({
        user: { id: userId },
      });
      const invalidBearerWithCookie = new Request("https://dopedb.invalid", {
        headers: {
          authorization: "Bearer invalid-native-session",
          cookie: authoritativeCookie,
        },
      });
      const isolatedHeaders = authoritativeSessionHeaders(invalidBearerWithCookie);
      expect(isolatedHeaders.get("authorization")).toBe("Bearer invalid-native-session");
      expect(isolatedHeaders.get("cookie")).toBeNull();
      await expect(authoritativeSession(invalidBearerWithCookie)).resolves.toBeNull();
      await expect(authoritativeSession(new Request("https://dopedb.invalid", {
        headers: { authorization: authoritativeBearer, cookie: "ambient=ignored" },
      }))).resolves.toMatchObject({ user: { id: userId } });

      const previousAuthOrigin = process.env.BETTER_AUTH_URL;
      process.env.BETTER_AUTH_URL = "https://dopedb.invalid";
      try {
        const rejectedWorkspaceId = randomUUID();
        const [runnerRoute, leaseRoute] = await Promise.all([
          import("../app/api/v1/workspaces/[workspaceId]/analyses/runners/route"),
          import("../app/api/v1/workspaces/[workspaceId]/analyses/leases/route"),
        ]);
        const rejectedRegistration = await runnerRoute.POST(new Request(
          `https://dopedb.invalid/api/v1/workspaces/${rejectedWorkspaceId}/analyses/runners`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer invalid-native-session",
              cookie: authoritativeCookie,
              "content-type": "application/json",
              "x-dopedb-analysis-runner-capability-version": "1",
            },
            body: JSON.stringify({
              deviceId: randomUUID(),
              displayName: "Cookie fallback attempt",
              backgroundAllowed: false,
            }),
          },
        ), { params: Promise.resolve({ workspaceId: rejectedWorkspaceId }) });
        expect(rejectedRegistration.status).toBe(401);
        expect(await rejectedRegistration.text()).not.toContain("runnerCapability");

        const rejectedClaim = await leaseRoute.POST(new Request(
          `https://dopedb.invalid/api/v1/workspaces/${rejectedWorkspaceId}/analyses/leases`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer invalid-native-session",
              cookie: authoritativeCookie,
              "content-type": "application/json",
              "x-dopedb-analysis-runner-capability": "a".repeat(64),
            },
            body: JSON.stringify({
              runnerId: randomUUID(),
              deviceId: randomUUID(),
              background: false,
            }),
          },
        ), { params: Promise.resolve({ workspaceId: rejectedWorkspaceId }) });
        expect(rejectedClaim.status).toBe(401);
      } finally {
        if (previousAuthOrigin === undefined) delete process.env.BETTER_AUTH_URL;
        else process.env.BETTER_AUTH_URL = previousAuthOrigin;
      }
      const projectName = `Harness Project ${suffix}`;
      const createdProject = await projectStore.insertKnowledgeProject({
        organizationId,
        name: projectName,
        environments: [
          { name: "Prod", riskClass: "production" },
          { name: "Dev", riskClass: "development" },
        ],
        authority: knowledgeAuthority,
      });
      expect(createdProject).toMatchObject({
        name: projectName,
        revision: 1,
        environments: [
          { name: "Dev", riskClass: "development", revision: 1 },
          { name: "Prod", riskClass: "production", revision: 1 },
        ],
      });
      if (!createdProject) throw new Error("Project Knowledge creation failed");
      await expect(projectStore.insertKnowledgeProject({
        organizationId,
        name: projectName,
        environments: [{ name: "Main", riskClass: "custom" }],
        authority: knowledgeAuthority,
      })).resolves.toBeNull();
      const appendedProject = await projectStore.appendKnowledgeEnvironment({
        organizationId,
        projectId: createdProject.id,
        expectedProjectRevision: 1,
        name: "Stage",
        riskClass: "staging",
        authority: knowledgeAuthority,
      });
      expect(appendedProject).toMatchObject({
        id: createdProject.id,
        revision: 2,
        environments: [
          { name: "Dev", riskClass: "development", revision: 1 },
          { name: "Prod", riskClass: "production", revision: 1 },
          { name: "Stage", riskClass: "staging", revision: 1 },
        ],
      });
      await expect(projectStore.appendKnowledgeEnvironment({
        organizationId,
        projectId: createdProject.id,
        expectedProjectRevision: 1,
        name: "Test",
        riskClass: "test",
        authority: knowledgeAuthority,
      })).resolves.toBeNull();
      await expect(projectStore.appendKnowledgeEnvironment({
        organizationId,
        projectId: createdProject.id,
        expectedProjectRevision: 2,
        name: "Prod",
        riskClass: "production",
        authority: knowledgeAuthority,
      })).resolves.toBeNull();
      await expect(projectStore.insertKnowledgeProject({
        organizationId,
        name: `Invalid subject ${suffix}`,
        environments: [{ name: "Main", riskClass: "custom" }],
        authority: {
          ...knowledgeAuthority,
          subject: { membershipId: memberId, userId: `not-${userId}` },
        },
      })).resolves.toBeNull();

      const memberGateKey = revocationGateLockKey({
        kind: "member",
        organizationId,
        memberId,
        userId,
      });
      let releaseMemberRevocation!: () => void;
      let memberRevocationReady!: () => void;
      const memberRevocationRelease = new Promise<void>((resolve) => {
        releaseMemberRevocation = resolve;
      });
      const memberRevocationStarted = new Promise<void>((resolve) => {
        memberRevocationReady = resolve;
      });
      const memberRevocation = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${memberGateKey}, 0))`;
        await tx`
          UPDATE "workspace_control"."member"
          SET "revocation_pending_at" = now()
          WHERE "id" = ${memberId} AND "organization_id" = ${organizationId}
        `;
        memberRevocationReady();
        await memberRevocationRelease;
      });
      await memberRevocationStarted;
      const revokedMemberWrite = projectStore.insertKnowledgeProject({
        organizationId,
        name: `Revoked race ${suffix}`,
        environments: [{ name: "Main", riskClass: "custom" }],
        authority: knowledgeAuthority,
      });
      releaseMemberRevocation();
      await memberRevocation;
      await expect(revokedMemberWrite).resolves.toBeNull();
      await sql`
        UPDATE "workspace_control"."member"
        SET "revocation_pending_at" = NULL
        WHERE "id" = ${memberId} AND "organization_id" = ${organizationId}
      `;

      const deletionRaceReceiptId = randomUUID();
      await sql`
        INSERT INTO "workspace_control"."workspace_deletion_receipt"
          ("id", "organization_id", "requested_by_user_id", "requested_at", "purge_after")
        VALUES (${deletionRaceReceiptId}::uuid, ${organizationId}, ${userId}, now(),
                now() + interval '7 days')
      `;
      let releaseDeletionPending!: () => void;
      let deletionPendingReady!: () => void;
      const deletionPendingRelease = new Promise<void>((resolve) => {
        releaseDeletionPending = resolve;
      });
      const deletionPendingStarted = new Promise<void>((resolve) => {
        deletionPendingReady = resolve;
      });
      const deletionPending = sql.begin(async (tx) => {
        await tx`
          UPDATE "workspace_control"."workspace_profile"
          SET "lifecycle_state" = 'deletion_pending',
              "deletion_receipt_id" = ${deletionRaceReceiptId}::uuid,
              "deletion_requested_at" = now(),
              "purge_after" = now() + interval '7 days'
          WHERE "organization_id" = ${organizationId}
        `;
        await tx`
          UPDATE "workspace_control"."member" member
          SET "revocation_pending_at" = profile."deletion_requested_at"
          FROM "workspace_control"."workspace_profile" profile
          WHERE member."id" = ${memberId}
            AND member."organization_id" = ${organizationId}
            AND profile."organization_id" = member."organization_id"
        `;
        deletionPendingReady();
        await deletionPendingRelease;
      });
      await deletionPendingStarted;
      const deletingWorkspaceWrite = projectStore.insertKnowledgeProject({
        organizationId,
        name: `Deletion race ${suffix}`,
        environments: [{ name: "Main", riskClass: "custom" }],
        authority: knowledgeAuthority,
      });
      releaseDeletionPending();
      await deletionPending;
      await expect(deletingWorkspaceWrite).resolves.toBeNull();
      await sql.begin(async (tx) => {
        await tx`
          UPDATE "workspace_control"."workspace_profile"
          SET "lifecycle_state" = 'active', "deletion_receipt_id" = NULL,
              "deletion_requested_at" = NULL, "purge_after" = NULL
          WHERE "organization_id" = ${organizationId}
        `;
        await tx`
          UPDATE "workspace_control"."member"
          SET "revocation_pending_at" = NULL
          WHERE "id" = ${memberId} AND "organization_id" = ${organizationId}
        `;
        await tx`
          UPDATE "workspace_control"."workspace_deletion_receipt"
          SET "status" = 'cancelled', "cancelled_at" = now()
          WHERE "id" = ${deletionRaceReceiptId}::uuid
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

      const developmentEnvironment = createdProject.environments.find(
        (environment) => environment.name === "Dev",
      );
      if (!developmentEnvironment) throw new Error("Development Environment is missing");
      await sql`
        INSERT INTO "workspace_control"."knowledge_environment_connection"
          ("organization_id", "project_environment_id", "environment_revision",
           "connection_id", "connection_revision", "role", "alias")
        VALUES (${organizationId}, ${developmentEnvironment.id}::uuid,
          ${developmentEnvironment.revision}, ${left.connection.id}::uuid,
          ${left.connection.contentRevision}, 'primary', 'Harness')
      `;

      const [{ commitAnalysisArticleCreate, commitAnalysisArticleMutation }, articleContract]
        = await Promise.all([
          import("./workspace-analysis-article-store"),
          import("./workspace-analysis-articles"),
        ]);
      const articleId = randomUUID();
      const articleInput = articleContract.parseSharedAnalysisArticleCreate({
        id: articleId,
        projectEnvironmentId: developmentEnvironment.id,
        environmentRevision: developmentEnvironment.revision,
        sourceKnowledgeGrantId: null,
        graphRevisionIds: [],
        connections: [{
          connectionId: left.connection.id,
          connectionRevision: left.connection.contentRevision,
          role: "primary",
          alias: "Harness",
        }],
        definition: {
          version: 1,
          source: "human",
          title: "Harness analysis",
          question: "How many active rows exist?",
          summary: "A bounded aggregate with an exact result contract.",
          timezone: "UTC",
          parameters: [],
          queries: [{
            id: "active_rows",
            title: "Active rows",
            connectionRole: "primary",
            sql: "SELECT count(*) AS active_rows FROM users WHERE active = TRUE",
            parameterIds: [],
            maxRows: 5,
            maxBytes: 16_384,
            cacheTtlSeconds: 0,
            columns: [{
              name: "active_rows",
              type: "number",
              nullable: false,
              role: "measure",
              sensitivity: "internal",
              masking: "none",
            }],
          }],
          transforms: [],
          metrics: [{
            id: "active_rows",
            label: "Active rows",
            description: "Current active row count",
            sourceNodeId: "active_rows",
            valueColumn: "active_rows",
            unit: "rows",
            lowerIsBetter: null,
            format: { style: "number", decimals: 0, currency: null },
          }],
          blocks: [{
            id: "active_rows_metric",
            kind: "metric",
            title: "Active rows",
            sourceNodeId: "active_rows",
            width: 4,
            config: {
              metricId: "active_rows",
              comparisonColumn: null,
              sparklineColumn: null,
              sampleCountColumn: null,
            },
          }, {
            id: "active_rows_detail",
            kind: "table",
            title: "Active rows detail",
            sourceNodeId: "active_rows",
            width: 8,
            config: {
              columns: ["active_rows"],
              pageSize: 10,
            },
          }],
          claims: [],
          refresh: {
            mode: "manual",
            cron: null,
            timezone: "UTC",
            runnerId: null,
            maxStalenessSeconds: 86_400,
            resultRetentionDays: 30,
            shareReviewedResults: true,
          },
          warnings: ["Harness definition only"],
        },
      });
      const createdArticle = await commitAnalysisArticleCreate({
        organizationId,
        article: articleInput,
        authority,
      });
      expect(createdArticle).toMatchObject({
        id: articleId,
        projectEnvironmentId: developmentEnvironment.id,
        state: "draft",
        revision: 1,
      });

      const revisedArticle = articleContract.parseSharedAnalysisArticleCreate({
        ...articleInput,
        definition: {
          ...articleInput.definition,
          summary: "A reviewed bounded aggregate with an exact result contract.",
        },
      });
      const updatedArticle = await commitAnalysisArticleMutation({
        organizationId,
        article: revisedArticle,
        expectedRevision: 1,
        state: "draft",
        ownerMemberId: memberId,
        authority,
        operation: "update",
      });
      expect(updatedArticle).toMatchObject({ revision: 2, state: "draft" });
      await expect(commitAnalysisArticleMutation({
        organizationId,
        article: revisedArticle,
        expectedRevision: 1,
        state: "draft",
        ownerMemberId: memberId,
        authority,
        operation: "update",
      })).resolves.toBeNull();
      const reviewArticle = await commitAnalysisArticleMutation({
        organizationId,
        article: revisedArticle,
        expectedRevision: 2,
        state: "review",
        ownerMemberId: memberId,
        authority,
        operation: "submit_review",
      });
      expect(reviewArticle).toMatchObject({ revision: 3, state: "review" });
      await expect(sql`
        UPDATE "workspace_control"."workspace_analysis_article_revision"
        SET "payload_hash" = ${"0".repeat(64)}
        WHERE "organization_id" = ${organizationId}
          AND "article_id" = ${articleId}::uuid
          AND "revision" = 1
      `).rejects.toThrow(/immutable/);
      const articleDurability = await sql<{
        revisions: number;
        plainResultColumns: number;
      }[]>`
        SELECT
          (SELECT count(*)::int
           FROM "workspace_control"."workspace_analysis_article_revision"
           WHERE "organization_id" = ${organizationId}
             AND "article_id" = ${articleId}::uuid) AS "revisions",
          (SELECT count(*)::int
           FROM information_schema.columns
           WHERE table_schema = 'workspace_control'
             AND table_name IN (
               'workspace_analysis_article',
               'workspace_analysis_article_revision',
               'workspace_analysis_result_fragment'
             )
             AND column_name ~ '(^result$|rows_json|plaintext_payload|credential|transcript)')
            AS "plainResultColumns"
      `;
      expect(articleDurability[0]).toEqual({ revisions: 3, plainResultColumns: 0 });

      // Exercise the staged Analysis result transaction against real PostgreSQL:
      // one exact runner may stage each immutable fragment once, atomically
      // complete it, replay that completion, and never expose a partial retained
      // manifest. Cancellation and share-off changes must close staging in SQL,
      // not merely in the route's earlier read-only checks.
      const [runStore, runnerStore, runContract, versioning, runnerCapabilityContract] =
        await Promise.all([
          import("./workspace-analysis-run-store"),
          import("./workspace-analysis-runner-store"),
          import("./workspace-analysis-runs"),
          import("./workspace-versioning"),
          import("./workspace-analysis-runner-capability"),
        ]);
      expect(runnerCapabilityContract.parseAnalysisRunnerCapabilityVersion(new Request(
        "https://dopedb.invalid",
      ))).toBeNull();
      expect(runnerCapabilityContract.parseAnalysisRunnerCapabilityVersion(new Request(
        "https://dopedb.invalid",
        { headers: { "x-dopedb-analysis-runner-capability-version": "2" } },
      ))).toBeNull();
      expect(runnerCapabilityContract.parseAnalysisRunnerCapabilityVersion(new Request(
        "https://dopedb.invalid",
        { headers: { "x-dopedb-analysis-runner-capability-version": "1" } },
      ))).toBe(1);
      expect(() => runnerCapabilityContract.hashAnalysisRunnerCapability(
        ` ${"a".repeat(64)}`,
      )).toThrow("Invalid Analysis runner capability");
      expect(runnerCapabilityContract.parseAnalysisRunnerCapability(new Request(
        "https://dopedb.invalid",
        { headers: { "x-dopedb-analysis-runner-capability": "A".repeat(64) } },
      ))).toBeNull();
      const registeredDeviceId = `analysis-capability-${suffix}`;
      await expect(runnerStore.registerAnalysisRunner({
        organizationId,
        registration: {
          deviceId: registeredDeviceId,
          displayName: "Old Desktop runner",
          backgroundAllowed: false,
        },
        runnerCapability: null,
        capabilityVersion: null,
        authority,
      })).resolves.toMatchObject({ status: "unsupported" });
      await expect(runnerStore.registerAnalysisRunner({
        organizationId,
        registration: {
          deviceId: registeredDeviceId,
          displayName: "Unsupported Desktop runner",
          backgroundAllowed: false,
        },
        runnerCapability: "f".repeat(64),
        capabilityVersion: 2,
        authority,
      })).resolves.toMatchObject({ status: "unsupported" });
      const unboundRegistrationCount = await sql<{ count: number }[]>`
        SELECT count(*)::int AS "count"
        FROM "workspace_control"."workspace_analysis_runner"
        WHERE "organization_id" = ${organizationId}
          AND "device_id" = ${registeredDeviceId}
      `;
      expect(unboundRegistrationCount[0]?.count).toBe(0);
      const registeredRunner = await runnerStore.registerAnalysisRunner({
        organizationId,
        registration: {
          deviceId: registeredDeviceId,
          displayName: "Capability harness runner",
          backgroundAllowed: false,
        },
        runnerCapability: null,
        capabilityVersion: 1,
        authority,
      });
      expect(registeredRunner).toMatchObject({
        status: "created",
        deviceId: registeredDeviceId,
        runnerCapabilityGeneration: 1,
      });
      expect(registeredRunner?.status === "created"
        ? registeredRunner.runnerCapability : null).toMatch(/^[0-9a-f]{64}$/);
      await expect(runnerStore.registerAnalysisRunner({
        organizationId,
        registration: {
          deviceId: registeredDeviceId,
          displayName: "Mismatched heartbeat",
          backgroundAllowed: true,
        },
        runnerCapability: "f".repeat(64),
        capabilityVersion: 1,
        authority,
      })).resolves.toMatchObject({ status: "invalid" });
      await expect(runnerStore.registerAnalysisRunner({
        organizationId,
        registration: {
          deviceId: registeredDeviceId,
          displayName: "Unproved heartbeat",
          backgroundAllowed: false,
        },
        runnerCapability: null,
        capabilityVersion: 1,
        authority,
      })).resolves.toMatchObject({ status: "missing" });
      const verifiedRunner = registeredRunner?.status === "created"
        ? await runnerStore.registerAnalysisRunner({
          organizationId,
          registration: {
            deviceId: registeredDeviceId,
            displayName: "Verified heartbeat",
            backgroundAllowed: false,
          },
          runnerCapability: registeredRunner.runnerCapability,
          capabilityVersion: 1,
          authority,
        })
        : null;
      expect(verifiedRunner).toMatchObject({ status: "verified", runnerCapability: null });
      const verifiedHeartbeatState = await sql<{
        displayName: string;
        backgroundAllowed: boolean;
        audits: number;
      }[]>`
        SELECT runner."display_name" AS "displayName",
          runner."background_allowed" AS "backgroundAllowed",
          (SELECT count(*)::int FROM "workspace_control"."workspace_audit_event" audit
           WHERE audit."organization_id" = ${organizationId}
             AND audit."action" = 'analysis_runner.register'
             AND audit."resource_id" = runner."id"::text) AS "audits"
        FROM "workspace_control"."workspace_analysis_runner" runner
        WHERE runner."organization_id" = ${organizationId}
          AND runner."device_id" = ${registeredDeviceId}
      `;
      expect(verifiedHeartbeatState[0]).toEqual({
        displayName: "Verified heartbeat",
        backgroundAllowed: false,
        audits: 2,
      });
      await expect(runnerStore.registerAnalysisRunner({
        organizationId,
        registration: {
          deviceId: registeredDeviceId,
          displayName: "Old Desktop conflict",
          backgroundAllowed: false,
        },
        runnerCapability: registeredRunner?.status === "created"
          ? registeredRunner.runnerCapability : null,
        capabilityVersion: null,
        authority,
      })).resolves.toMatchObject({ status: "unsupported" });
      await sql`
        UPDATE "workspace_control"."workspace_analysis_runner"
        SET "revoked_at" = now()
        WHERE "organization_id" = ${organizationId}
          AND "device_id" = ${registeredDeviceId}
      `;
      await expect(runnerStore.registerAnalysisRunner({
        organizationId,
        registration: {
          deviceId: registeredDeviceId,
          displayName: "Forbidden same-row bootstrap",
          backgroundAllowed: false,
        },
        runnerCapability: null,
        capabilityVersion: 1,
        authority,
      })).resolves.toMatchObject({ status: "replacement_required" });
      const replacementRunner = await runnerStore.registerAnalysisRunner({
        organizationId,
        registration: {
          deviceId: `${registeredDeviceId}-replacement`,
          displayName: "Fresh replacement runner",
          backgroundAllowed: false,
        },
        runnerCapability: null,
        capabilityVersion: 1,
        authority,
      });
      expect(replacementRunner).toMatchObject({ status: "created", runnerCapabilityGeneration: 1 });
      const analysisRunnerId = randomUUID();
      const analysisRunnerCapability = "7".repeat(64);
      const invalidAnalysisRunnerCapability = "8".repeat(64);
      const analysisRunnerCapabilityHash = runnerCapabilityContract
        .hashAnalysisRunnerCapability(analysisRunnerCapability);
      const analysisDataKeyId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO "workspace_control"."workspace_analysis_runner"
            ("id", "organization_id", "member_id", "device_id", "display_name",
             "runner_capability_hash", "runner_capability_generation")
          VALUES (${analysisRunnerId}::uuid, ${organizationId}, ${memberId},
                  ${`analysis-harness-${suffix}`}, 'Analysis harness runner',
                  ${analysisRunnerCapabilityHash}, 1)
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_data_key"
            ("id", "organization_id", "version", "key_reference", "kms_key_version",
             "wrapped_key", "created_by_user_id")
          VALUES (${analysisDataKeyId}::uuid, ${organizationId}, 1,
                  'dopedb-workspace-data-key',
                  'projects/dopedb-harness/locations/global/keyRings/workspace/cryptoKeys/analysis/cryptoKeyVersions/1',
                  ${Buffer.alloc(32, 17).toString("base64")}, ${userId})
        `;
      });
      const createAnalysisRun = async (revision: number) => {
        const id = randomUUID();
        const run = await runStore.commitAnalysisRunCreate({
          organizationId,
          articleId,
          run: {
            id,
            articleRevision: revision,
            runnerId: analysisRunnerId,
            trigger: "manual",
            parameterValues: {},
          },
          parameterHash: versioning.canonicalHash({}),
          definitionHash: versioning.canonicalHash(revisedArticle.definition),
          runnerCapabilityHash: analysisRunnerCapabilityHash,
          authority,
        });
        expect(run).toMatchObject({ id, state: "running", runnerId: analysisRunnerId });
        return id;
      };
      await expect(runStore.commitAnalysisRunCreate({
        organizationId,
        articleId,
        run: {
          id: randomUUID(),
          articleRevision: 3,
          runnerId: analysisRunnerId,
          trigger: "manual",
          parameterValues: {},
        },
        parameterHash: versioning.canonicalHash({}),
        definitionHash: versioning.canonicalHash(revisedArticle.definition),
        runnerCapabilityHash: runnerCapabilityContract
          .hashAnalysisRunnerCapability(invalidAnalysisRunnerCapability),
        authority,
      })).resolves.toBeNull();
      const stagedFragment = (
        ordinal: number,
        blockId = "active_rows_metric",
      ) => ({
        blockId,
        ordinal,
        dataKeyId: analysisDataKeyId,
        keyReference: "dopedb-workspace-data-key",
        keyVersion: "v1",
        ciphertext: Buffer.from(`sealed-analysis-${blockId}-${ordinal}`).toString("base64"),
        payloadHash: versioning.canonicalHash({ blockId, ordinal }),
        rowCount: 1,
        plaintextBytes: 128 + ordinal,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const stageFragment = (runId: string, fragment: ReturnType<typeof stagedFragment>) => (
        runStore.stageAnalysisRunFragment({
          organizationId,
          articleId,
          runId,
          runnerId: analysisRunnerId,
          runnerCapabilityHash: analysisRunnerCapabilityHash,
          fragment,
          authority,
        })
      );
      const analysisRunId = await createAnalysisRun(3);
      const invalidAnalysisRunnerCapabilityHash = runnerCapabilityContract
        .hashAnalysisRunnerCapability(invalidAnalysisRunnerCapability);
      expect(await runStore.canStageAnalysisRunFragment({
        organizationId,
        articleId,
        runId: analysisRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: invalidAnalysisRunnerCapabilityHash,
        authority,
      })).toBe(false);
      expect(await runStore.canStageAnalysisRunFragment({
        organizationId,
        articleId,
        runId: analysisRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: analysisRunnerCapabilityHash,
        authority,
      })).toBe(true);
      const firstFragment = stagedFragment(0);
      const secondFragment = stagedFragment(1);
      const detailFragment = stagedFragment(0, "active_rows_detail");
      await expect(runStore.stageAnalysisRunFragment({
        organizationId,
        articleId,
        runId: analysisRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: invalidAnalysisRunnerCapabilityHash,
        fragment: firstFragment,
        authority,
      })).resolves.toBeNull();
      await expect(stageFragment(analysisRunId, firstFragment)).resolves.toMatchObject({
        blockId: firstFragment.blockId,
        ordinal: 0,
        payloadHash: firstFragment.payloadHash,
      });
      await expect(stageFragment(analysisRunId, secondFragment)).resolves.toMatchObject({
        blockId: secondFragment.blockId,
        ordinal: 1,
        payloadHash: secondFragment.payloadHash,
      });
      await expect(stageFragment(analysisRunId, detailFragment)).resolves.toMatchObject({
        blockId: detailFragment.blockId,
        ordinal: 0,
        payloadHash: detailFragment.payloadHash,
      });
      // A retry is a read of the same immutable row, not another staged audit.
      await expect(stageFragment(analysisRunId, firstFragment)).resolves.toMatchObject({
        payloadHash: firstFragment.payloadHash,
      });
      const stagedAudits = await sql<{ count: number }[]>`
        SELECT count(*)::int AS "count"
        FROM "workspace_control"."workspace_audit_event"
        WHERE "organization_id" = ${organizationId}
          AND "action" = 'analysis_article.result_fragment_staged'
          AND "resource_id" = ${analysisRunId}
      `;
      expect(stagedAudits[0]?.count).toBe(3);
      const queryReceipt = {
        queryNodeId: "active_rows",
        connectionId: left.connection.id,
        connectionRevision: left.connection.contentRevision,
        queryRunId: randomUUID(),
        queryHash: versioning.canonicalHash({
          sql: revisedArticle.definition.queries[0]!.sql,
          parameterValues: {},
        }),
        schemaFingerprint: versioning.canonicalHash(
          revisedArticle.definition.queries[0]!.columns,
        ),
        state: "succeeded" as const,
        rowCount: 2,
        byteCount: 257,
        durationMs: 9,
      };
      const fragmentManifest = [firstFragment, secondFragment, detailFragment].map((fragment) => ({
        blockId: fragment.blockId,
        ordinal: fragment.ordinal,
        payloadHash: fragment.payloadHash,
      }));
      const missingBlockManifest = fragmentManifest.filter(
        (fragment) => fragment.blockId !== "active_rows_detail",
      );
      const gapManifest = fragmentManifest.map((fragment) => fragment.ordinal === 1
        ? { ...fragment, ordinal: 2 }
        : fragment);
      const duplicateManifest = [...fragmentManifest, fragmentManifest[0]!];
      const unknownBlockManifest = [
        { ...fragmentManifest[0]!, blockId: "unknown_block" },
        ...fragmentManifest,
      ];
      const inlineFragment = (blockId: string, ordinal: number) => ({
        version: 1 as const,
        blockId,
        ordinal,
        columns: revisedArticle.definition.queries[0]!.columns,
        rows: [[2]],
        truncated: false,
      });
      expect(runContract.parseAnalysisRunCompletion({
        state: "succeeded",
        queryReceipts: [queryReceipt],
        fragmentManifest,
        error: null,
      }, revisedArticle.definition).fragmentManifest).toHaveLength(3);
      expect(runContract.parseAnalysisRunCompletion({
        state: "succeeded",
        queryReceipts: [queryReceipt],
        fragments: [
          inlineFragment("active_rows_metric", 0),
          inlineFragment("active_rows_metric", 1),
          inlineFragment("active_rows_detail", 0),
        ],
        error: null,
      }, revisedArticle.definition).inlineFragments).toHaveLength(3);
      for (const invalidManifest of [
        missingBlockManifest,
        gapManifest,
        duplicateManifest,
        unknownBlockManifest,
      ]) {
        expect(() => runContract.parseAnalysisRunCompletion({
          state: "succeeded",
          queryReceipts: [queryReceipt],
          fragmentManifest: invalidManifest,
          error: null,
        }, revisedArticle.definition)).toThrow();
      }
      for (const invalidInlineFragments of [
        [
          inlineFragment("active_rows_metric", 0),
          inlineFragment("active_rows_metric", 1),
        ],
        [
          inlineFragment("active_rows_metric", 0),
          inlineFragment("active_rows_metric", 2),
          inlineFragment("active_rows_detail", 0),
        ],
      ]) {
        expect(() => runContract.parseAnalysisRunCompletion({
          state: "succeeded",
          queryReceipts: [queryReceipt],
          fragments: invalidInlineFragments,
          error: null,
        }, revisedArticle.definition)).toThrow();
      }
      const completion = {
        state: "succeeded" as const,
        queryReceipts: [queryReceipt],
        fragmentManifest,
        inlineFragments: [],
        error: null,
      };
      const sqlBoundaryCases = [
        missingBlockManifest,
        gapManifest,
        unknownBlockManifest,
        duplicateManifest,
      ];
      for (const invalidManifest of sqlBoundaryCases) {
        const invalidRunId = await createAnalysisRun(3);
        for (const fragment of [firstFragment, secondFragment, detailFragment]) {
          await stageFragment(invalidRunId, fragment);
        }
        const invalidReceipt = { ...queryReceipt, queryRunId: randomUUID() };
        await expect(runStore.commitAnalysisRunCompletion({
          organizationId,
          articleId,
          runId: invalidRunId,
          runnerId: analysisRunnerId,
          runnerCapabilityHash: analysisRunnerCapabilityHash,
          completion: {
            ...completion,
            queryReceipts: [invalidReceipt],
            fragmentManifest: invalidManifest,
          },
          fragmentManifest: invalidManifest,
          authority,
        })).resolves.toBeNull();
        const invalidRun = await sql<{ state: string }[]>`
          SELECT "state"
          FROM "workspace_control"."workspace_analysis_article_run"
          WHERE "organization_id" = ${organizationId}
            AND "id" = ${invalidRunId}::uuid
        `;
        expect(invalidRun[0]?.state).toBe("running");
      }
      const completedRun = await runStore.commitAnalysisRunCompletion({
        organizationId,
        articleId,
        runId: analysisRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: analysisRunnerCapabilityHash,
        completion,
        fragmentManifest,
        authority,
      });
      expect(completedRun).toMatchObject({
        id: analysisRunId,
        articleRevision: 3,
        state: "succeeded",
        rowCount: 2,
        byteCount: 385,
        resultHash: runContract.analysisRunResultHash([queryReceipt], fragmentManifest),
      });
      // A response-loss retry recovers the exact durable terminal run without
      // duplicating receipts or terminal audit events.
      await expect(runStore.commitAnalysisRunCompletion({
        organizationId,
        articleId,
        runId: analysisRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: analysisRunnerCapabilityHash,
        completion,
        fragmentManifest,
        authority,
      })).resolves.toMatchObject({ id: analysisRunId, state: "succeeded" });
      await expect(runStore.commitAnalysisRunCompletion({
        organizationId,
        articleId,
        runId: analysisRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: invalidAnalysisRunnerCapabilityHash,
        completion,
        fragmentManifest,
        authority,
      })).resolves.toBeNull();
      const completionDurability = await sql<{
        receipts: number;
        completionAudits: number;
      }[]>`
        SELECT
          (SELECT count(*)::int
           FROM "workspace_control"."workspace_analysis_article_query_receipt"
           WHERE "organization_id" = ${organizationId}
             AND "run_id" = ${analysisRunId}::uuid) AS "receipts",
          (SELECT count(*)::int
           FROM "workspace_control"."workspace_audit_event"
           WHERE "organization_id" = ${organizationId}
             AND "action" = 'analysis_article.run_complete'
             AND "resource_id" = ${analysisRunId}) AS "completionAudits"
      `;
      expect(completionDurability[0]).toEqual({ receipts: 1, completionAudits: 1 });
      // Retention can remove one row before another cleanup batch. The committed
      // manifest hash must then fail closed instead of treating the remainder as
      // a smaller valid result.
      await sql`
        DELETE FROM "workspace_control"."workspace_analysis_result_fragment"
        WHERE "organization_id" = ${organizationId}
          AND "run_id" = ${analysisRunId}::uuid
          AND "ordinal" = 1
      `;
      const retainedFragments = await sql<{
        blockId: string;
        ordinal: number;
        payloadHash: string;
        plaintextBytes: number;
      }[]>`
        SELECT "block_id" AS "blockId", "ordinal", "payload_hash" AS "payloadHash",
          "plaintext_bytes" AS "plaintextBytes"
        FROM "workspace_control"."workspace_analysis_result_fragment"
        WHERE "organization_id" = ${organizationId}
          AND "run_id" = ${analysisRunId}::uuid
          AND "expires_at" > now()
      `;
      expect(runContract.analysisRunEvidenceIsComplete({
        resultHash: String(completedRun?.resultHash ?? ""),
        rowCount: 2,
        byteCount: 385,
        receipts: [queryReceipt],
        fragments: retainedFragments,
      })).toBe(false);

      const cancelledRunId = await createAnalysisRun(3);
      await expect(stageFragment(cancelledRunId, stagedFragment(0))).resolves.not.toBeNull();
      await expect(runStore.requestAnalysisRunCancellation({
        organizationId,
        articleId,
        runId: cancelledRunId,
        authority,
      })).resolves.toMatchObject({ id: cancelledRunId });
      expect(await runStore.canStageAnalysisRunFragment({
        organizationId,
        articleId,
        runId: cancelledRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: analysisRunnerCapabilityHash,
        authority,
      })).toBe(false);
      await expect(stageFragment(cancelledRunId, stagedFragment(1))).resolves.toBeNull();
      const cancelledReceiptProbe = {
        ...queryReceipt,
        queryRunId: randomUUID(),
        state: "cancelled" as const,
        rowCount: 0,
        byteCount: 0,
      };
      await expect(runStore.commitAnalysisRunCompletion({
        organizationId,
        articleId,
        runId: cancelledRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: analysisRunnerCapabilityHash,
        completion: {
          state: "cancelled",
          queryReceipts: [cancelledReceiptProbe],
          fragmentManifest: [],
          inlineFragments: [],
          error: { kind: "cancelled", message: "Cancelled by harness" },
        },
        fragmentManifest: [],
        authority,
      })).resolves.toMatchObject({ id: cancelledRunId, state: "cancelled" });
      const cancelledFragments = await sql<{ count: number }[]>`
        SELECT count(*)::int AS "count"
        FROM "workspace_control"."workspace_analysis_result_fragment"
        WHERE "organization_id" = ${organizationId}
          AND "run_id" = ${cancelledRunId}::uuid
      `;
      expect(cancelledFragments[0]?.count).toBe(0);
      const cancelledReceipts = await sql<{ count: number }[]>`
        SELECT count(*)::int AS "count"
        FROM "workspace_control"."workspace_analysis_article_query_receipt"
        WHERE "organization_id" = ${organizationId}
          AND "run_id" = ${cancelledRunId}::uuid
      `;
      expect(cancelledReceipts[0]?.count).toBe(0);

      const returnedDraft = await commitAnalysisArticleMutation({
        organizationId,
        article: revisedArticle,
        expectedRevision: 3,
        state: "draft",
        ownerMemberId: memberId,
        authority,
        operation: "return_draft",
      });
      expect(returnedDraft).toMatchObject({ revision: 4, state: "draft" });
      const privateArticleInput = articleContract.parseSharedAnalysisArticleCreate({
        ...revisedArticle,
        definition: {
          ...revisedArticle.definition,
          refresh: {
            ...revisedArticle.definition.refresh,
            shareReviewedResults: false,
          },
        },
      });
      const privateDraft = await commitAnalysisArticleMutation({
        organizationId,
        article: privateArticleInput,
        expectedRevision: 4,
        state: "draft",
        ownerMemberId: memberId,
        authority,
        operation: "update",
      });
      expect(privateDraft).toMatchObject({ revision: 5, state: "draft" });
      const privateReview = await commitAnalysisArticleMutation({
        organizationId,
        article: privateArticleInput,
        expectedRevision: 5,
        state: "review",
        ownerMemberId: memberId,
        authority,
        operation: "submit_review",
      });
      expect(privateReview).toMatchObject({ revision: 6, state: "review" });
      const privateRunId = await createAnalysisRun(6);
      expect(await runStore.canStageAnalysisRunFragment({
        organizationId,
        articleId,
        runId: privateRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: analysisRunnerCapabilityHash,
        authority,
      })).toBe(false);
      await expect(stageFragment(privateRunId, stagedFragment(0))).resolves.toBeNull();
      await sql`
        UPDATE "workspace_control"."workspace_analysis_runner"
        SET "runner_capability_hash" = ${invalidAnalysisRunnerCapabilityHash},
            "runner_capability_generation" = 2
        WHERE "organization_id" = ${organizationId}
          AND "id" = ${analysisRunnerId}::uuid
      `;
      expect(await runStore.canStageAnalysisRunFragment({
        organizationId,
        articleId,
        runId: privateRunId,
        runnerId: analysisRunnerId,
        runnerCapabilityHash: invalidAnalysisRunnerCapabilityHash,
        authority,
      })).toBe(false);
      await sql`
        INSERT INTO "workspace_control"."workspace_analysis_result_fragment"
          ("organization_id", "run_id", "block_id", "ordinal", "data_key_id",
           "key_reference", "key_version", "ciphertext", "payload_hash", "row_count",
           "plaintext_bytes", "expires_at")
        VALUES (${organizationId}, ${privateRunId}::uuid, 'active_rows_metric', 0,
          ${analysisDataKeyId}::uuid, 'dopedb-workspace-data-key', 'v1',
          ${Buffer.from("revocation-fragment").toString("base64")},
          ${versioning.canonicalHash({ privateRunId })}, 1, 64, now() + interval '1 minute')
      `;
      const revokedRunner = await runnerStore.revokeAnalysisRunner({
        organizationId,
        runnerId: analysisRunnerId,
        authority,
      });
      expect(revokedRunner).toMatchObject({ id: analysisRunnerId });
      const revokedRunState = await sql<{ state: string; fragments: number }[]>`
        SELECT run."state",
          (SELECT count(*)::int
           FROM "workspace_control"."workspace_analysis_result_fragment" fragment
           WHERE fragment."organization_id" = run."organization_id"
             AND fragment."run_id" = run."id") AS "fragments"
        FROM "workspace_control"."workspace_analysis_article_run" run
        WHERE run."organization_id" = ${organizationId}
          AND run."id" = ${privateRunId}::uuid
      `;
      expect(revokedRunState[0]).toEqual({ state: "stale", fragments: 0 });

      const removableRunnerId = randomUUID();
      const removableRunId = randomUUID();
      const removableHistoricalRunId = randomUUID();
      const removableLeaseId = randomUUID();
      const removableClaimId = randomUUID();
      const removableSignalId = randomUUID();
      const removablePublicationId = randomUUID();
      const removableSignalDefinition = {
        condition: { kind: "threshold_above", value: 1 },
        baselineWindowSeconds: null,
        minimumSampleCount: 1,
        cooldownSeconds: 60,
        rearmAfterNormalCount: 1,
        severity: "warning",
        recipientMemberIds: [removableMemberId],
        channels: ["workspace_web"],
        productionConfirmed: true,
      };
      const removableSignalPayload = {
        id: removableSignalId,
        articleRevision: 3,
        blockId: "active_rows_metric",
        definition: removableSignalDefinition,
        enabled: true,
        deleted: false,
      };
      await sql.begin(async (tx) => {
        await tx`
          UPDATE "workspace_control"."member"
          SET "revocation_pending_at" = now(),
              "revocation_claimed_at" = now(),
              "revocation_claim_id" = ${removableClaimId}::uuid
          WHERE "id" = ${removableMemberId}
            AND "organization_id" = ${organizationId}
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_analysis_runner"
            ("id", "organization_id", "member_id", "device_id", "display_name",
             "runner_capability_hash", "runner_capability_generation", "background_allowed")
          VALUES (${removableRunnerId}::uuid, ${organizationId}, ${removableMemberId},
                  ${`removable-runner-${suffix}`}, 'Removable member runner',
                  ${analysisRunnerCapabilityHash}, 1, TRUE)
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_analysis_refresh_lease"
            ("id", "organization_id", "article_id", "article_revision", "runner_id",
             "runner_capability_generation", "idempotency_key", "parameter_hash",
             "lease_capability_hash", "scheduled_at", "expires_at")
          VALUES (${removableLeaseId}::uuid, ${organizationId}, ${articleId}::uuid, 3,
                  ${removableRunnerId}::uuid, 1, ${`member-removal-${suffix}`},
                  ${versioning.canonicalHash({})}, ${"e".repeat(64)}, now(),
                  now() + interval '2 minutes')
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_analysis_article_run"
            ("id", "organization_id", "article_id", "article_revision", "runner_id",
             "runner_capability_generation", "lease_id", "requested_by_member_id", "trigger",
             "state", "parameter_values", "parameter_hash", "definition_hash", "started_at",
             "finished_at")
          VALUES (${removableRunId}::uuid, ${organizationId}, ${articleId}::uuid, 3,
                  ${removableRunnerId}::uuid, 1, ${removableLeaseId}::uuid,
                  ${removableMemberId}, 'schedule', 'running', '{}'::jsonb,
                  ${versioning.canonicalHash({})},
                  ${versioning.canonicalHash(revisedArticle.definition)}, now(), NULL),
                 (${removableHistoricalRunId}::uuid, ${organizationId}, ${articleId}::uuid, 3,
                  ${removableRunnerId}::uuid, 1, NULL, ${removableMemberId}, 'manual',
                  'succeeded', '{}'::jsonb, ${versioning.canonicalHash({})},
                  ${versioning.canonicalHash(revisedArticle.definition)}, now(), now())
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_analysis_article_query_receipt"
            ("organization_id", "run_id", "query_node_id", "connection_id",
             "connection_revision", "query_run_id", "query_hash", "schema_fingerprint",
             "state", "row_count", "byte_count", "duration_ms")
          VALUES (${organizationId}, ${removableRunId}::uuid, 'active_rows',
                  ${left.connection.id}::uuid, ${left.connection.contentRevision},
                  ${randomUUID()}::uuid, ${"a".repeat(64)}, ${"b".repeat(64)},
                  'succeeded', 1, 64, 1),
                 (${organizationId}, ${removableHistoricalRunId}::uuid, 'active_rows',
                  ${left.connection.id}::uuid, ${left.connection.contentRevision},
                  ${randomUUID()}::uuid, ${"c".repeat(64)}, ${"d".repeat(64)},
                  'succeeded', 1, 64, 1)
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_analysis_result_fragment"
            ("organization_id", "run_id", "block_id", "ordinal", "data_key_id",
             "key_reference", "key_version", "ciphertext", "payload_hash", "row_count",
             "plaintext_bytes", "expires_at")
          VALUES (${organizationId}, ${removableRunId}::uuid, 'active_rows_metric', 0,
                  ${analysisDataKeyId}::uuid, 'dopedb-workspace-data-key', 'v1',
                  ${Buffer.from("active-removal-fragment").toString("base64")},
                  ${versioning.canonicalHash({ removableRunId })}, 1, 64,
                  now() + interval '1 minute'),
                 (${organizationId}, ${removableHistoricalRunId}::uuid,
                  'active_rows_metric', 0, ${analysisDataKeyId}::uuid,
                  'dopedb-workspace-data-key', 'v1',
                  ${Buffer.from("historical-removal-evidence").toString("base64")},
                  ${versioning.canonicalHash({ removableHistoricalRunId })}, 1, 64,
                  now() + interval '1 minute')
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_analysis_publication"
            ("id", "organization_id", "article_id", "article_revision", "source_run_id",
             "slug", "visibility", "title", "snapshot", "snapshot_hash",
             "approved_by_member_id")
          VALUES (${removablePublicationId}::uuid, ${organizationId}, ${articleId}::uuid, 3,
                  ${removableHistoricalRunId}::uuid, ${`harness-publication-${suffix}`},
                  'unlisted', 'Historical member attribution',
                  ${JSON.stringify({ version: 1, title: "Historical member attribution" })}::jsonb,
                  ${versioning.canonicalHash({ version: 1, title: "Historical member attribution" })},
                  ${removableMemberId})
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_analysis_signal"
            ("id", "organization_id", "article_id", "article_revision", "block_id",
             "definition", "owner_member_id", "enabled", "revision")
          VALUES (${removableSignalId}::uuid, ${organizationId}, ${articleId}::uuid, 3,
                  'active_rows_metric', ${JSON.stringify(removableSignalDefinition)}::jsonb,
                  ${removableMemberId}, TRUE, 1)
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_analysis_signal_revision"
            ("organization_id", "signal_id", "revision", "base_revision", "operation",
             "payload", "payload_hash", "created_by_member_id")
          VALUES (${organizationId}, ${removableSignalId}::uuid, 1, NULL, 'create',
                  ${JSON.stringify(removableSignalPayload)}::jsonb,
                  ${versioning.canonicalHash(removableSignalPayload)}, ${removableMemberId})
        `;
        await tx`
          UPDATE "workspace_control"."workspace_analysis_article"
          SET "definition" = jsonb_set(
                jsonb_set("definition", '{refresh,mode}', '"scheduled"'::jsonb),
                '{refresh,runnerId}', to_jsonb(${removableRunnerId}::text)
              ),
              "next_refresh_at" = now()
          WHERE "organization_id" = ${organizationId}
            AND "id" = ${articleId}::uuid
        `;
      });
      // Model a signal created after an earlier HTTP preflight. The atomic
      // removal transaction must independently re-check active recipients and
      // leave both the member and every runner resource untouched.
      const signalBlockedRemoval = await runnerStore.removeMemberAfterAnalysisRunnerCleanup({
        organizationId,
        target: {
          memberId: removableMemberId,
          userId: removableUserId,
          role: "viewer",
          claimId: removableClaimId,
        },
        externalLeaseRevocation: { revoked: 0, deferred: 0 },
        authority,
      });
      expect(signalBlockedRemoval).toBeNull();
      const signalBlockedState = await sql<{ memberPresent: boolean; runnerActive: boolean }[]>`
        SELECT
          EXISTS (SELECT 1 FROM "workspace_control"."member"
                  WHERE "id" = ${removableMemberId}
                    AND "organization_id" = ${organizationId}) AS "memberPresent",
          EXISTS (SELECT 1 FROM "workspace_control"."workspace_analysis_runner"
                  WHERE "id" = ${removableRunnerId}::uuid
                    AND "revoked_at" IS NULL) AS "runnerActive"
      `;
      expect(signalBlockedState[0]).toEqual({ memberPresent: true, runnerActive: true });
      await sql`
        UPDATE "workspace_control"."workspace_analysis_signal"
        SET "enabled" = FALSE, "updated_at" = now()
        WHERE "organization_id" = ${organizationId}
          AND "id" = ${removableSignalId}::uuid
      `;
      const removedMember = await runnerStore.removeMemberAfterAnalysisRunnerCleanup({
        organizationId,
        target: {
          memberId: removableMemberId,
          userId: removableUserId,
          role: "viewer",
          claimId: removableClaimId,
        },
        externalLeaseRevocation: { revoked: 0, deferred: 0 },
        authority,
      });
      expect(removedMember).toMatchObject({
        id: removableMemberId,
        runnerCount: 1,
        activeRunCount: 1,
        discardedFragmentCount: 1,
        activeLeaseCount: 1,
      });
      const memberRemovalState = await sql<{
        memberPresent: boolean;
        runnerMemberId: string | null;
        runnerRevoked: boolean;
        activeState: string;
        activeFragments: number;
        activeReceipts: number;
        activeRequester: string | null;
        historicalState: string;
        historicalFragments: number;
        historicalReceipts: number;
        historicalRequester: string | null;
        leaseRevoked: boolean;
        nextRefreshAt: Date | null;
        auditRunnerCount: number;
        auditRunCount: number;
        auditFragmentCount: number;
        auditReceiptCount: number;
        auditLeaseCount: number;
        publicationApprover: string | null;
        publicationPreserved: boolean;
        signalOwner: string | null;
        signalRevisionCreator: string | null;
        signalRevisionPreserved: boolean;
        historicalSignalDefinitionPreserved: boolean;
      }[]>`
        SELECT
          EXISTS (SELECT 1 FROM "workspace_control"."member"
                  WHERE "id" = ${removableMemberId}) AS "memberPresent",
          runner."member_id" AS "runnerMemberId", runner."revoked_at" IS NOT NULL AS "runnerRevoked",
          active_run."state" AS "activeState",
          (SELECT count(*)::int FROM "workspace_control"."workspace_analysis_result_fragment" fragment
           WHERE fragment."organization_id" = ${organizationId}
             AND fragment."run_id" = ${removableRunId}::uuid) AS "activeFragments",
          (SELECT count(*)::int FROM "workspace_control"."workspace_analysis_article_query_receipt" receipt
           WHERE receipt."organization_id" = ${organizationId}
             AND receipt."run_id" = ${removableRunId}::uuid) AS "activeReceipts",
          active_run."requested_by_member_id" AS "activeRequester",
          historical_run."state" AS "historicalState",
          (SELECT count(*)::int FROM "workspace_control"."workspace_analysis_result_fragment" fragment
           WHERE fragment."organization_id" = ${organizationId}
             AND fragment."run_id" = ${removableHistoricalRunId}::uuid) AS "historicalFragments",
          (SELECT count(*)::int FROM "workspace_control"."workspace_analysis_article_query_receipt" receipt
           WHERE receipt."organization_id" = ${organizationId}
             AND receipt."run_id" = ${removableHistoricalRunId}::uuid) AS "historicalReceipts",
          historical_run."requested_by_member_id" AS "historicalRequester",
          lease."revoked_at" IS NOT NULL AS "leaseRevoked",
          article."next_refresh_at" AS "nextRefreshAt",
          (audit."redacted_summary"->>'analysisRunnerCount')::int AS "auditRunnerCount",
          (audit."redacted_summary"->>'analysisActiveRunCount')::int AS "auditRunCount",
          (audit."redacted_summary"->>'analysisDiscardedFragmentCount')::int
            AS "auditFragmentCount",
          (audit."redacted_summary"->>'analysisDiscardedReceiptCount')::int
            AS "auditReceiptCount",
          (audit."redacted_summary"->>'analysisActiveLeaseCount')::int AS "auditLeaseCount",
          (SELECT publication."approved_by_member_id"
           FROM "workspace_control"."workspace_analysis_publication" publication
           WHERE publication."organization_id" = ${organizationId}
             AND publication."id" = ${removablePublicationId}::uuid) AS "publicationApprover",
          EXISTS (
            SELECT 1 FROM "workspace_control"."workspace_analysis_publication" publication
            WHERE publication."organization_id" = ${organizationId}
              AND publication."id" = ${removablePublicationId}::uuid
              AND publication."snapshot_hash" =
                ${versioning.canonicalHash({ version: 1, title: "Historical member attribution" })}
          ) AS "publicationPreserved",
          (SELECT signal."owner_member_id"
           FROM "workspace_control"."workspace_analysis_signal" signal
           WHERE signal."organization_id" = ${organizationId}
             AND signal."id" = ${removableSignalId}::uuid) AS "signalOwner",
          (SELECT revision."created_by_member_id"
           FROM "workspace_control"."workspace_analysis_signal_revision" revision
           WHERE revision."organization_id" = ${organizationId}
             AND revision."signal_id" = ${removableSignalId}::uuid
             AND revision."revision" = 1) AS "signalRevisionCreator",
          EXISTS (
            SELECT 1 FROM "workspace_control"."workspace_analysis_signal_revision" revision
            WHERE revision."organization_id" = ${organizationId}
              AND revision."signal_id" = ${removableSignalId}::uuid
              AND revision."revision" = 1
              AND revision."payload_hash" = ${versioning.canonicalHash(removableSignalPayload)}
          ) AS "signalRevisionPreserved",
          EXISTS (
            SELECT 1 FROM "workspace_control"."workspace_analysis_signal" signal
            WHERE signal."organization_id" = ${organizationId}
              AND signal."id" = ${removableSignalId}::uuid
              AND signal."enabled" = FALSE
              AND signal."definition" = ${JSON.stringify(removableSignalDefinition)}::jsonb
          ) AS "historicalSignalDefinitionPreserved"
        FROM "workspace_control"."workspace_analysis_runner" runner
        JOIN "workspace_control"."workspace_analysis_article_run" active_run
          ON active_run."id" = ${removableRunId}::uuid
        JOIN "workspace_control"."workspace_analysis_article_run" historical_run
          ON historical_run."id" = ${removableHistoricalRunId}::uuid
        JOIN "workspace_control"."workspace_analysis_refresh_lease" lease
          ON lease."id" = ${removableLeaseId}::uuid
        JOIN "workspace_control"."workspace_analysis_article" article
          ON article."id" = ${articleId}::uuid
         AND article."organization_id" = ${organizationId}
        JOIN "workspace_control"."workspace_audit_event" audit
          ON audit."organization_id" = ${organizationId}
         AND audit."action" = 'member.remove'
         AND audit."resource_id" = ${removableMemberId}
        WHERE runner."id" = ${removableRunnerId}::uuid
      `;
      expect(memberRemovalState[0]).toEqual({
        memberPresent: false,
        runnerMemberId: null,
        runnerRevoked: true,
        activeState: "stale",
        activeFragments: 0,
        activeReceipts: 0,
        activeRequester: null,
        historicalState: "succeeded",
        historicalFragments: 1,
        historicalReceipts: 1,
        historicalRequester: null,
        leaseRevoked: true,
        nextRefreshAt: null,
        auditRunnerCount: 1,
        auditRunCount: 1,
        auditFragmentCount: 1,
        auditReceiptCount: 1,
        auditLeaseCount: 1,
        publicationApprover: null,
        publicationPreserved: true,
        signalOwner: null,
        signalRevisionCreator: null,
        signalRevisionPreserved: true,
        historicalSignalDefinitionPreserved: true,
      });

      const syncJournal = await sql<{
        head: number;
        events: number;
        audits: number;
        firstSequence: number;
        lastSequence: number;
        payloadColumns: number;
      }[]>`
        SELECT
          head."last_sequence"::int AS "head",
          (SELECT count(*)::int FROM "workspace_control"."workspace_sync_event" event
           WHERE event."organization_id" = ${organizationId}) AS "events",
          (SELECT count(*)::int FROM "workspace_control"."workspace_audit_event" audit
           WHERE audit."organization_id" = ${organizationId}) AS "audits",
          (SELECT min(event."sequence")::int
           FROM "workspace_control"."workspace_sync_event" event
           WHERE event."organization_id" = ${organizationId}) AS "firstSequence",
          (SELECT max(event."sequence")::int
           FROM "workspace_control"."workspace_sync_event" event
           WHERE event."organization_id" = ${organizationId}) AS "lastSequence",
          (SELECT count(*)::int FROM information_schema.columns
           WHERE table_schema = 'workspace_control'
             AND table_name = 'workspace_sync_event'
             AND column_name ~ '(payload|summary|resource_id|actor|credential|result)')
             AS "payloadColumns"
        FROM "workspace_control"."workspace_sync_head" head
        WHERE head."organization_id" = ${organizationId}
      `;
      expect(syncJournal[0]?.head).toBeGreaterThan(0);
      expect(syncJournal[0]).toMatchObject({
        events: syncJournal[0]?.head,
        audits: syncJournal[0]?.head,
        firstSequence: 1,
        lastSequence: syncJournal[0]?.head,
        payloadColumns: 0,
      });
      const headBeforeRollback = syncJournal[0]?.head ?? 0;
      await sql`
        INSERT INTO "workspace_control"."workspace_audit_event"
          ("organization_id", "actor_user_id", "action", "resource_type",
           "resource_id", "redacted_summary", "request_id")
        VALUES
          (${organizationId}, ${userId}, 'credential.lease.issue', 'connection',
           NULL, '{}'::jsonb, ${randomUUID()}::uuid),
          (${organizationId}, ${userId}, 'workspace.backup.create', 'workspace_backup',
           NULL, '{}'::jsonb, ${randomUUID()}::uuid),
          (${organizationId}, ${userId}, 'workspace.data_key.rotation.complete', 'workspace',
           NULL, '{}'::jsonb, ${randomUUID()}::uuid)
      `;
      const headAfterLeaseAudit = await sql<{ head: number }[]>`
        SELECT "last_sequence"::int AS "head"
        FROM "workspace_control"."workspace_sync_head"
        WHERE "organization_id" = ${organizationId}
      `;
      expect(headAfterLeaseAudit[0]?.head).toBe(headBeforeRollback);
      await expect(sql.begin(async (tx) => {
        await tx`
          INSERT INTO "workspace_control"."workspace_audit_event"
            ("organization_id", "actor_user_id", "action", "resource_type",
             "resource_id", "redacted_summary", "request_id")
          VALUES (${organizationId}, ${userId}, 'analysis_article.rollback_probe', 'analysis_article',
                  NULL, '{}'::jsonb, ${randomUUID()}::uuid)
        `;
        throw new Error("rollback sync probe");
      })).rejects.toThrow("rollback sync probe");
      const headAfterRollback = await sql<{ head: number }[]>`
        SELECT "last_sequence"::int AS "head"
        FROM "workspace_control"."workspace_sync_head"
        WHERE "organization_id" = ${organizationId}
      `;
      expect(headAfterRollback[0]?.head).toBe(headBeforeRollback);

      await Promise.all([
        sql`
          INSERT INTO "workspace_control"."workspace_audit_event"
            ("organization_id", "actor_user_id", "action", "resource_type",
             "resource_id", "redacted_summary", "request_id")
          VALUES (${organizationId}, ${userId}, 'connection.grant.revoke', 'connection',
                  NULL, '{}'::jsonb, ${randomUUID()}::uuid)
        `,
        sql`
          INSERT INTO "workspace_control"."workspace_audit_event"
            ("organization_id", "actor_user_id", "action", "resource_type",
             "resource_id", "redacted_summary", "request_id")
          VALUES (${organizationId}, ${userId}, 'analysis_article.archive', 'analysis_article',
                  NULL, '{}'::jsonb, ${randomUUID()}::uuid)
        `,
      ]);
      const concurrentSync = await sql<{
        sequence: number;
        resourceType: string;
        tombstone: boolean;
      }[]>`
        SELECT "sequence"::int AS "sequence", "resource_type" AS "resourceType",
          "tombstone" AS "tombstone"
        FROM "workspace_control"."workspace_sync_event"
        WHERE "organization_id" = ${organizationId}
          AND "sequence" > ${headBeforeRollback}
        ORDER BY "sequence"
      `;
      expect(concurrentSync.map((event) => event.sequence)).toEqual([
        headBeforeRollback + 1,
        headBeforeRollback + 2,
      ]);
      expect(new Set(concurrentSync.map((event) => event.resourceType))).toEqual(
        new Set(["connection", "analysis_article"]),
      );
      expect(concurrentSync.every((event) => event.tombstone)).toBe(true);
      const [workspaceAudit] = await sql<{ id: string }[]>`
        SELECT "id"::text AS "id"
        FROM "workspace_control"."workspace_audit_event"
        WHERE "organization_id" = ${organizationId}
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT 1
      `;
      if (!workspaceAudit) throw new Error("Workspace sync audit fixture is missing");
      await expect(sql.begin(async (tx) => {
        // Temporarily remove the trigger-created row so the tenant FK, rather
        // than the one-event-per-audit uniqueness guard, owns this rejection.
        // The failed transaction rolls the removal back with the probe.
        await tx`
          DELETE FROM "workspace_control"."workspace_sync_event"
          WHERE "audit_event_id" = ${workspaceAudit.id}::uuid
        `;
        await tx`
          INSERT INTO "workspace_control"."workspace_sync_event"
            ("organization_id", "sequence", "audit_event_id", "resource_type",
             "operation", "tombstone")
          VALUES (${otherOrganizationId}, 1, ${workspaceAudit.id}::uuid,
                  'connection', 'connection.cross_tenant_probe', FALSE)
        `;
      })).rejects.toThrow(/workspace_sync_event_org_audit_fk/);

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
      const [dataKeyStore, dataKeyRotation, workspaceBackup, workspaceLifecycle] = await Promise.all([
        import("./workspace-data-key"),
        import("./workspace-data-key-rotation"),
        import("./workspace-backup"),
        import("./workspace-lifecycle"),
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

      await sql`
        UPDATE "workspace_control"."workspace_metadata_backup"
        SET "deleted_at" = now() - interval '8 days',
            "purge_after" = now() - interval '1 day'
        WHERE "id" = ${backupId}::uuid
          AND "organization_id" = ${kmsOrganizationId}
      `;
      const backupRetention = await workspaceLifecycle.cleanupWorkspaceRetention({
        backupLimit: 8,
        workspaceLimit: 1,
      });
      expect(backupRetention).toMatchObject({ backupsPurged: 1, workspacesPurged: 0 });
      const deletedBackup = await sql<{ present: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_metadata_backup"
          WHERE "id" = ${backupId}::uuid
        ) AS "present"
      `;
      expect(deletedBackup[0]?.present).toBe(false);

      const deletionRequestId = randomUUID();
      expect(await workspaceLifecycle.scheduleWorkspaceDeletion({
        organizationId: kmsOrganizationId,
        authority: kmsAuthority,
        requestId: deletionRequestId,
        confirmation: "wrong workspace name",
      })).toBeNull();
      expect(await workspaceLifecycle.scheduleWorkspaceDeletion({
        organizationId: kmsOrganizationId,
        authority: kmsAuthority,
        requestId: deletionRequestId,
        confirmation: "KMS Harness",
      })).toBe("scheduled");
      expect(await workspaceLifecycle.scheduleWorkspaceDeletion({
        organizationId: kmsOrganizationId,
        authority: kmsAuthority,
        requestId: deletionRequestId,
        confirmation: "KMS Harness",
      })).toBe("replayed");
      expect(await workspaceLifecycle.workspaceLifecycleStatus(kmsOrganizationId)).toMatchObject({
        lifecycleState: "deletion_pending",
        deletionReceiptId: deletionRequestId,
        backupCount: 0,
        blockers: { memberRevocations: 1 },
      });
      expect(await workspaceLifecycle.cancelWorkspaceDeletion({
        organizationId: kmsOrganizationId,
        authority: kmsAuthority,
        requestId: deletionRequestId,
      })).toBe("cancelled");
      expect(await workspaceLifecycle.cancelWorkspaceDeletion({
        organizationId: kmsOrganizationId,
        authority: kmsAuthority,
        requestId: deletionRequestId,
      })).toBe("replayed");
      expect(await workspaceLifecycle.workspaceLifecycleStatus(kmsOrganizationId)).toMatchObject({
        lifecycleState: "active",
        deletionReceiptId: null,
        blockers: { memberRevocations: 0 },
      });

      const finalDeletionRequestId = randomUUID();
      expect(await workspaceLifecycle.scheduleWorkspaceDeletion({
        organizationId: kmsOrganizationId,
        authority: kmsAuthority,
        requestId: finalDeletionRequestId,
        confirmation: "KMS Harness",
      })).toBe("scheduled");
      await sql`
        UPDATE "workspace_control"."workspace_deletion_receipt"
        SET "requested_at" = now() - interval '8 days',
            "purge_after" = now() - interval '1 day'
        WHERE "id" = ${finalDeletionRequestId}::uuid
          AND "organization_id" = ${kmsOrganizationId}
      `;
      await sql`
        UPDATE "workspace_control"."workspace_profile"
        SET "deletion_requested_at" = now() - interval '8 days',
            "purge_after" = now() - interval '1 day'
        WHERE "organization_id" = ${kmsOrganizationId}
          AND "deletion_receipt_id" = ${finalDeletionRequestId}::uuid
      `;
      await sql`
        UPDATE "workspace_control"."member" member
        SET "revocation_pending_at" = profile."deletion_requested_at"
        FROM "workspace_control"."workspace_profile" profile
        WHERE member."organization_id" = ${kmsOrganizationId}
          AND profile."organization_id" = member."organization_id"
      `;
      const workspaceRetention = await workspaceLifecycle.cleanupWorkspaceRetention({
        backupLimit: 8,
        workspaceLimit: 1,
      });
      expect(workspaceRetention).toEqual({
        backupsPurged: 0,
        workspacesPurged: 1,
        workspacesDeferred: 0,
      });
      const purgedWorkspace = await sql<{ present: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "workspace_control"."organization"
          WHERE "id" = ${kmsOrganizationId}
        ) AS "present"
      `;
      expect(purgedWorkspace[0]?.present).toBe(false);
      const deletionReceipt = await sql<{ status: string; actor: string | null }[]>`
        SELECT "status" AS "status", "requested_by_user_id" AS "actor"
        FROM "workspace_control"."workspace_deletion_receipt"
        WHERE "id" = ${finalDeletionRequestId}::uuid
      `;
      expect(deletionReceipt[0]).toEqual({ status: "purged", actor: kmsUserId });

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
        DELETE FROM "workspace_control"."user"
        WHERE "id" IN (${userId}, ${removableUserId}, ${kmsUserId})
      `.catch(() => undefined);
      await sql.end({ timeout: 5 });
      vi.doUnmock("./db");
      vi.doUnmock("./workspace-kms");
    }
  }, 60_000);
});
