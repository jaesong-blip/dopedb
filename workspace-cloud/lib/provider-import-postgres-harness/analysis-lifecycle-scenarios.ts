import { randomUUID } from "node:crypto";

import { expect } from "vitest";

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

  const [{ commitAnalysisArticleCreate, commitAnalysisArticleMutation }, articleContract]
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
      import("../workspace-analysis-run-store"),
      import("../workspace-analysis-runner-store"),
      import("../workspace-analysis-runs"),
      import("../workspace-versioning"),
      import("../workspace-analysis-runner-capability"),
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
