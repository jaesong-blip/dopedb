import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { AnalysisLifecycleScenarioResult } from "./analysis-lifecycle-scenarios";
import type { AuthorityProviderScenarioResult } from "./authority-provider-scenarios";
import type { ProviderImportPostgresHarness } from "./fixture";

export async function runAnalysisMemberRemovalScenarios(
  fixture: ProviderImportPostgresHarness,
  provider: AuthorityProviderScenarioResult,
  analysis: AnalysisLifecycleScenarioResult,
) {
  const {
    authority,
    organizationId,
    removableMemberId,
    removableUserId,
    sql,
    suffix,
  } = fixture;
  const { imported: left } = provider;
  const {
    analysisDataKeyId,
    analysisRunnerCapabilityHash,
    articleId,
    revisedArticle,
    runnerStore,
    versioning,
  } = analysis;

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

}
