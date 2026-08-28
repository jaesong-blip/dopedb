import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { returnDraftAndVerifyLocalOnlyCompletion } from "./analysis-local-result-scenarios";
import { expectRfc3339Timestamp } from "./assertions";
import type { AuthorityProviderScenarioResult } from "./authority-provider-scenarios";
import type { ProviderImportPostgresHarness } from "./fixture";

export async function runAnalysisLifecycleScenarios(
  fixture: ProviderImportPostgresHarness,
  provider: AuthorityProviderScenarioResult,
) {
  const {
    authority,
    memberId,
    organizationId,
    sql,
    suffix,
    userId,
  } = fixture;
  const {
    developmentEnvironment,
    imported: left,
  } = provider;

  const [{
    commitAnalysisArticleCreate,
    commitAnalysisArticleDelete,
    commitAnalysisArticleMutation,
  }, articleContract]
    = await Promise.all([
      import("../workspace-analysis-article-store"),
      import("../workspace-analysis-articles"),
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
      version: 2,
      source: "human",
      title: "Harness analysis",
      html: "<h2>Active rows</h2><p>A bounded aggregate backed by one saved query.</p>",
      question: "",
      summary: "",
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
      metrics: [],
      blocks: [{
        id: "query_result",
        kind: "table",
        title: "Query result",
        sourceNodeId: "active_rows",
        width: 12,
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
        shareReviewedResults: false,
      },
      warnings: [],
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
      html: "<h2>Active rows</h2><p>A reviewed aggregate backed by one saved query.</p>",
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
  const [runStore, runnerStore, runContract, versioning, runnerCapabilityContract,
    connectionStore] =
    await Promise.all([
      import("../workspace-analysis-run-store"),
      import("../workspace-analysis-runner-store"),
      import("../workspace-analysis-runs"),
      import("../workspace-versioning"),
      import("../workspace-analysis-runner-capability"),
      import("../workspace-versioning-store"),
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
    const started = await runStore.commitAnalysisRunCreate({
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
    expect(started?.run).toMatchObject({ id, state: "running", runnerId: analysisRunnerId });
    expect(started?.connectionContentRevisions).toEqual({
      [left.connection.id]: left.connection.contentRevision,
    });
    expectRfc3339Timestamp(started?.run.startedAt);
    expectRfc3339Timestamp(started?.run.createdAt);
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
  const authorityEpochDrift = await sql.begin(async (tx) => {
    const revisions = await tx<{
      contentRevision: number;
      authorityRevision: number;
    }[]>`
      UPDATE "workspace_control"."workspace_connection"
      SET "revision" = "revision" + 1
      WHERE "organization_id" = ${organizationId}
        AND "id" = ${left.connection.id}::uuid
      RETURNING "content_revision"::int AS "contentRevision",
        "revision"::int AS "authorityRevision"
    `;
    await tx`
      UPDATE "workspace_control"."knowledge_environment_connection"
      SET "connection_revision" = ${revisions[0]!.authorityRevision}
      WHERE "organization_id" = ${organizationId}
        AND "project_environment_id" = ${developmentEnvironment.id}::uuid
        AND "connection_id" = ${left.connection.id}::uuid
        AND "revoked_at" IS NULL
    `;
    return revisions;
  });
  expect(authorityEpochDrift[0]).toEqual({
    contentRevision: left.connection.contentRevision,
    authorityRevision: left.connection.contentRevision + 1,
  });
  // A revocation/lease epoch change must not make unchanged saved SQL stale.
  // The run still rechecks the live binding, grant, and revocation gate.
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
  // Simple Articles keep query results on the member's Desktop. The control
  // plane receives only the bounded execution receipt.
  expect(await runStore.canStageAnalysisRunFragment({
    organizationId,
    articleId,
    runId: analysisRunId,
    runnerId: analysisRunnerId,
    runnerCapabilityHash: analysisRunnerCapabilityHash,
    authority,
  })).toBe(false);
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
  const completion = runContract.parseAnalysisRunCompletion({
    state: "succeeded",
    queryReceipts: [queryReceipt],
    fragmentManifest: [],
    error: null,
  }, revisedArticle.definition);
  const completedRun = await runStore.commitAnalysisRunCompletion({
    organizationId,
    articleId,
    runId: analysisRunId,
    runnerId: analysisRunnerId,
    runnerCapabilityHash: analysisRunnerCapabilityHash,
    completion,
    fragmentManifest: [],
    authority,
  });
  expect(completedRun).toMatchObject({
    id: analysisRunId,
    articleRevision: 3,
    state: "succeeded",
    rowCount: 2,
    byteCount: 0,
    resultHash: runContract.analysisRunResultHash([queryReceipt], []),
  });
  expectRfc3339Timestamp(completedRun?.finishedAt);
  expectRfc3339Timestamp(completedRun?.createdAt);
  // A response-loss retry recovers the exact durable terminal run without
  // duplicating receipts or terminal audit events.
  await expect(runStore.commitAnalysisRunCompletion({
    organizationId,
    articleId,
    runId: analysisRunId,
    runnerId: analysisRunnerId,
    runnerCapabilityHash: analysisRunnerCapabilityHash,
    completion,
    fragmentManifest: [],
    authority,
  })).resolves.toMatchObject({ id: analysisRunId, state: "succeeded" });
  await expect(runStore.commitAnalysisRunCompletion({
    organizationId,
    articleId,
    runId: analysisRunId,
    runnerId: analysisRunnerId,
    runnerCapabilityHash: invalidAnalysisRunnerCapabilityHash,
    completion,
    fragmentManifest: [],
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

  // v1 Articles pinned the internal epoch. Preserve unchanged content, fail
  // after a content edit, and still let the owner delete the stale Article.
  const legacyConnectionId = randomUUID();
  const legacyArticleId = randomUUID();
  const legacyConnectionPayload = {
    name: "Legacy analysis source", engine: "postgres" as const, provider: "auto" as const,
    driverId: null, host: "legacy-analysis.invalid", port: 5432, database: "legacy_analysis",
    sslmode: "require" as const, readonlyDefault: true, allowWrites: false,
    env: "development" as const, schemaGroup: null, deleted: false,
  };
  await expect(connectionStore.commitConnectionCreate({
    organizationId, connectionId: legacyConnectionId, authority, input: legacyConnectionPayload,
  })).resolves.toMatchObject({ id: legacyConnectionId, contentRevision: 1 });
  await sql.begin(async (tx) => {
    await tx`
      UPDATE "workspace_control"."workspace_connection"
      SET "revision" = 2
      WHERE "organization_id" = ${organizationId} AND "id" = ${legacyConnectionId}::uuid
    `;
    await tx`
      INSERT INTO "workspace_control"."knowledge_environment_connection"
        ("organization_id", "project_environment_id", "environment_revision",
         "connection_id", "connection_revision", "role", "alias")
      VALUES (${organizationId}, ${developmentEnvironment.id}::uuid,
        ${developmentEnvironment.revision}, ${legacyConnectionId}::uuid, 2,
        'primary', 'Legacy harness')
    `;
  });
  const { html: legacyHtml, ...legacyDefinitionWithoutHtml } = revisedArticle.definition;
  expect(legacyHtml).toContain("Active rows");
  const legacyDefinition = {
    ...legacyDefinitionWithoutHtml,
    version: 1 as const,
    question: "How many active rows exist?",
    summary: "Legacy exact-read definition",
  };
  const legacyArticle = articleContract.parseSharedAnalysisArticleCreate({
    ...revisedArticle,
    id: legacyArticleId,
    connections: [{ connectionId: legacyConnectionId, connectionRevision: 2,
      role: "primary", alias: "Legacy harness" }],
    definition: legacyDefinition,
  });
  const legacyPayload = {
    ...legacyArticle, definition: legacyDefinition, state: "draft",
    ownerMemberId: memberId, deleted: false,
  };
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO "workspace_control"."workspace_analysis_article"
        ("id", "organization_id", "project_environment_id", "environment_revision",
         "definition", "owner_member_id", "updated_by_member_id")
      VALUES (${legacyArticleId}::uuid, ${organizationId}, ${developmentEnvironment.id}::uuid,
        ${developmentEnvironment.revision}, ${JSON.stringify(legacyDefinition)}::jsonb,
        ${memberId}, ${memberId})
    `;
    await tx`
      INSERT INTO "workspace_control"."workspace_analysis_article_connection"
        ("organization_id", "article_id", "article_revision", "connection_id",
         "connection_revision", "role", "alias")
      VALUES (${organizationId}, ${legacyArticleId}::uuid, 1, ${legacyConnectionId}::uuid,
        2, 'primary', 'Legacy harness')
    `;
    await tx`
      INSERT INTO "workspace_control"."workspace_analysis_article_revision"
        ("organization_id", "article_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_user_id", "created_by_member_id")
      VALUES (${organizationId}, ${legacyArticleId}::uuid, 1, 0, 'create',
        ${JSON.stringify(legacyPayload)}::jsonb, ${versioning.canonicalHash(legacyPayload)},
        ${userId}, ${memberId})
    `;
  });
  const legacyRunId = randomUUID();
  const legacyStarted = await runStore.commitAnalysisRunCreate({
    organizationId,
    articleId: legacyArticleId,
    run: { id: legacyRunId, articleRevision: 1, runnerId: analysisRunnerId,
      trigger: "manual", parameterValues: {} },
    parameterHash: versioning.canonicalHash({}),
    definitionHash: versioning.canonicalHash(legacyArticle.definition),
    runnerCapabilityHash: analysisRunnerCapabilityHash,
    authority,
  });
  expect(legacyStarted?.connectionContentRevisions).toEqual({ [legacyConnectionId]: 1 });
  expect(legacyStarted?.run).toMatchObject({ id: legacyRunId, state: "running" });
  expect(await runStore.getAnalysisRunControl({
    organizationId, articleId: legacyArticleId, runId: legacyRunId,
    membershipId: memberId, role: authority.role,
    runnerCapabilityHash: analysisRunnerCapabilityHash,
    leaseCapabilityHash: null,
  })).toMatchObject({ authorized: true });
  const legacyReceipt = {
    ...queryReceipt, connectionId: legacyConnectionId,
    connectionRevision: 1, queryRunId: randomUUID(),
  };
  const legacyCompletion = runContract.parseAnalysisRunCompletion({
    state: "succeeded", queryReceipts: [legacyReceipt], fragmentManifest: [], error: null,
  }, legacyArticle.definition);
  await expect(runStore.commitAnalysisRunCompletion({
    organizationId,
    articleId: legacyArticleId,
    runId: legacyRunId,
    runnerId: analysisRunnerId,
    runnerCapabilityHash: analysisRunnerCapabilityHash,
    completion: legacyCompletion,
    fragmentManifest: [],
    authority,
  })).resolves.toMatchObject({ id: legacyRunId, state: "succeeded" });

  const changedLegacyConnectionPayload = { ...legacyConnectionPayload,
    name: "Changed legacy analysis source" };
  await sql.begin(async (tx) => {
    await tx`
      WITH parent AS (
        SELECT "id" FROM "workspace_control"."workspace_resource_version"
        WHERE "organization_id" = ${organizationId} AND "resource_type" = 'connection'
          AND "resource_id" = ${legacyConnectionId}::uuid
          AND "branch" = 'main' AND "revision" = 1
      ), changed AS (
        UPDATE "workspace_control"."workspace_connection"
        SET "name" = ${changedLegacyConnectionPayload.name}, "content_revision" = 2,
          "revision" = 3, "updated_at" = now()
        WHERE "organization_id" = ${organizationId} AND "id" = ${legacyConnectionId}::uuid
        RETURNING "id"
      )
      INSERT INTO "workspace_control"."workspace_resource_version"
        ("organization_id", "resource_type", "resource_id", "revision", "base_revision",
         "parent_version_id", "branch", "operation", "payload", "payload_hash",
         "created_by_user_id")
      SELECT ${organizationId}, 'connection', changed."id", 2, 1, parent."id", 'main',
        'update', ${JSON.stringify(changedLegacyConnectionPayload)}::jsonb,
        ${versioning.canonicalHash(changedLegacyConnectionPayload)}, ${userId}
      FROM changed CROSS JOIN parent
    `;
    await tx`
      UPDATE "workspace_control"."knowledge_environment_connection"
      SET "connection_revision" = 3
      WHERE "organization_id" = ${organizationId} AND "connection_id" = ${legacyConnectionId}::uuid
        AND "revoked_at" IS NULL
    `;
  });
  await expect(runStore.commitAnalysisRunCreate({
    organizationId,
    articleId: legacyArticleId,
    run: { id: randomUUID(), articleRevision: 1, runnerId: analysisRunnerId,
      trigger: "manual", parameterValues: {} },
    parameterHash: versioning.canonicalHash({}),
    definitionHash: versioning.canonicalHash(legacyArticle.definition),
    runnerCapabilityHash: analysisRunnerCapabilityHash,
    authority,
  })).resolves.toBeNull();
  await expect(commitAnalysisArticleDelete({
    organizationId, article: legacyArticle, expectedRevision: 1,
    ownerMemberId: memberId, authority,
  })).resolves.toMatchObject({ id: legacyArticleId, revision: 2, state: "archived" });

  const cancelledRunId = await createAnalysisRun(3);
  const cancelRequestedRun = await runStore.requestAnalysisRunCancellation({
    organizationId,
    articleId,
    runId: cancelledRunId,
    authority,
  });
  expect(cancelRequestedRun).toMatchObject({ id: cancelledRunId });
  expectRfc3339Timestamp(cancelRequestedRun?.cancelRequestedAt);
  expect(await runStore.canStageAnalysisRunFragment({
    organizationId,
    articleId,
    runId: cancelledRunId,
    runnerId: analysisRunnerId,
    runnerCapabilityHash: analysisRunnerCapabilityHash,
    authority,
  })).toBe(false);
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

  await returnDraftAndVerifyLocalOnlyCompletion({
    fixture,
    articleId,
    article: revisedArticle,
    queryReceipt,
    runnerId: analysisRunnerId,
    runnerCapabilityHash: analysisRunnerCapabilityHash,
    createRun: createAnalysisRun,
    mutateArticle: commitAnalysisArticleMutation,
    runStore,
    runContract,
  });
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


  return {
    analysisDataKeyId,
    analysisRunnerCapabilityHash,
    articleId,
    revisedArticle,
    runnerStore,
    versioning,
  };
}

export type AnalysisLifecycleScenarioResult =
  Awaited<ReturnType<typeof runAnalysisLifecycleScenarios>>;
