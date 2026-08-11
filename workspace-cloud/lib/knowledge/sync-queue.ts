// Durable Project Knowledge queue. GitHub delivery ids remain the audit cursor;
// sync jobs are coalesced by source + immutable commit and advanced by bounded
// Vercel cron invocations without any member desktop being online.
import "server-only";

import { neonSql } from "../db";

const SHA1 = /^[0-9a-f]{40}$/;

type EnqueueResult = { jobId: string };
type RequeueResult = { jobId: string; graphRevisionId: string | null };

export type GithubReconciliationCandidate = {
  organizationId: string;
  sourceId: string;
  installationId: bigint;
  repositoryFullName: string;
  refName: string;
  commitSha: string;
};

function checkedSha(value: string) {
  if (!SHA1.test(value)) throw new Error("Invalid GitHub commit identity");
  return value;
}

function checkedChangedFiles(values: readonly string[]) {
  if (values.length > 10_000) return [];
  for (const value of values) {
    if (
      value.length < 1
      || value.length > 4_096
      || value.startsWith("/")
      || value.includes("\\")
      || /[\u0000-\u001f\u007f]/.test(value)
      || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("Invalid GitHub changed-file path");
    }
  }
  return [...new Set(values)].sort();
}

export async function enqueueInitialGithubKnowledgeSync(input: {
  organizationId: string;
  sourceId: string;
  commitSha: string;
}) {
  const rows = await neonSql.query(
    `INSERT INTO "workspace_control"."knowledge_source_sync_job" (
       "organization_id", "source_id", "desired_commit_sha", "source_sync_revision"
     )
     SELECT source."organization_id", source."id", source."commit_sha", source."sync_revision"
     FROM "workspace_control"."knowledge_source" source
     JOIN "workspace_control"."knowledge_github_installation" installation
       ON installation."organization_id" = source."organization_id"
      AND installation."id" = source."github_installation_id"
      AND installation."status" = 'active'
     WHERE source."organization_id" = $1
       AND source."id" = $2::uuid
       AND source."provider" = 'github'
       AND source."commit_sha" = $3
       AND source."revoked_at" IS NULL
     ON CONFLICT ("source_id", "desired_commit_sha") DO NOTHING
     RETURNING "id"::text AS "jobId"`,
    [input.organizationId, input.sourceId, checkedSha(input.commitSha)],
  ) as EnqueueResult[];
  return rows[0]?.jobId ?? null;
}

export async function requeueGithubKnowledgeSync(input: {
  organizationId: string;
  sourceId: string;
}) {
  const rows = await neonSql.query(
    `WITH advanced_source AS MATERIALIZED (
       UPDATE "workspace_control"."knowledge_source" source
       SET "sync_state" = 'pending',
         "sync_revision" = source."sync_revision" + 1,
         "last_failure_code" = NULL,
         "updated_at" = now()
       WHERE source."organization_id" = $1
         AND source."id" = $2::uuid
         AND source."provider" = 'github'
         AND source."revoked_at" IS NULL
         AND source."commit_sha" IS NOT NULL
       RETURNING source."organization_id", source."id", source."commit_sha",
         source."sync_revision"
     ), queued AS (
       INSERT INTO "workspace_control"."knowledge_source_sync_job" (
         "organization_id", "source_id", "desired_commit_sha", "source_sync_revision"
       )
       SELECT "organization_id", "id", "commit_sha", "sync_revision"
       FROM advanced_source
       ON CONFLICT ("source_id", "desired_commit_sha") DO UPDATE SET
         "source_sync_revision" = EXCLUDED."source_sync_revision",
         "trigger_event_id" = NULL,
         "phase" = 'manifest',
         "state" = 'queued',
         "attempt" = 0,
         "total_files" = 0,
         "processed_files" = 0,
         "available_at" = now(),
         "claimed_at" = NULL,
         "lease_expires_at" = NULL,
         "worker_id" = NULL,
         "failure_code" = NULL,
         "finished_at" = NULL,
         "updated_at" = now()
       RETURNING "id", "organization_id", "source_id"
     ), cleared AS (
       DELETE FROM "workspace_control"."knowledge_code_index_file" file
       USING queued
       WHERE file."job_id" = queued."id"
       RETURNING file."job_id"
     )
     SELECT queued."id"::text AS "jobId",
       head."graph_revision_id"::text AS "graphRevisionId"
     FROM queued
     LEFT JOIN "workspace_control"."knowledge_environment_head" head
       ON head."organization_id" = queued."organization_id"
      AND head."source_id" = queued."source_id"`,
    [input.organizationId, input.sourceId],
  ) as RequeueResult[];
  return rows[0] ?? null;
}

export async function recordGithubKnowledgePush(input: {
  organizationId: string;
  sourceId: string;
  deliveryId: string;
  beforeCommitSha: string;
  afterCommitSha: string | null;
  changedFiles: readonly string[];
}) {
  const after = input.afterCommitSha ? checkedSha(input.afterCommitSha) : null;
  const files = checkedChangedFiles(input.changedFiles);
  const rows = await neonSql.query(
    `WITH current_source AS MATERIALIZED (
       SELECT source."commit_sha", source."sync_revision"
       FROM "workspace_control"."knowledge_source" source
       WHERE source."organization_id" = $1
         AND source."id" = $2::uuid
         AND source."provider" = 'github'
         AND source."revoked_at" IS NULL
       FOR UPDATE OF source
     ), inserted_event AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_source_event" (
         "organization_id", "source_id", "delivery_id", "event_kind",
         "before_commit_sha", "after_commit_sha", "changed_files", "state", "consumed_at"
       )
       SELECT $1, $2::uuid, $3, 'push', $4, $5, $6::text::jsonb,
         CASE WHEN current_source."commit_sha" = $4 THEN 'pending' ELSE 'failed' END,
         CASE WHEN current_source."commit_sha" = $4 THEN NULL ELSE now() END
       FROM current_source
       ON CONFLICT ("delivery_id", "source_id") DO NOTHING
       RETURNING "id"
     ), advanced_source AS MATERIALIZED (
       UPDATE "workspace_control"."knowledge_source" source
       SET "commit_sha" = CASE
           WHEN current_source."commit_sha" = $4 THEN COALESCE($5, source."commit_sha")
           ELSE source."commit_sha"
         END,
         "sync_state" = CASE
           WHEN current_source."commit_sha" <> $4 THEN source."sync_state"
           WHEN $5::text IS NULL THEN 'stale'
           ELSE 'pending'
         END,
         "sync_revision" = CASE
           WHEN current_source."commit_sha" = $4 THEN source."sync_revision" + 1
           ELSE source."sync_revision"
         END,
         "last_failure_code" = CASE
           WHEN current_source."commit_sha" <> $4 THEN source."last_failure_code"
           WHEN $5::text IS NULL THEN 'tracked_ref_deleted'
           ELSE NULL
         END,
         "last_reconciled_at" = CASE
           WHEN current_source."commit_sha" <> $4 THEN NULL
           ELSE source."last_reconciled_at"
         END,
         "updated_at" = now()
       FROM current_source CROSS JOIN inserted_event
       WHERE source."organization_id" = $1
         AND source."id" = $2::uuid
       RETURNING source."sync_revision",
         current_source."commit_sha" = $4 AS "accepted"
     ), queued AS (
       INSERT INTO "workspace_control"."knowledge_source_sync_job" (
         "organization_id", "source_id", "desired_commit_sha",
         "source_sync_revision", "trigger_event_id"
       )
       SELECT $1, $2::uuid, $5, advanced_source."sync_revision", inserted_event."id"
       FROM advanced_source CROSS JOIN inserted_event
       WHERE advanced_source."accepted" AND $5::text IS NOT NULL
       ON CONFLICT ("source_id", "desired_commit_sha") DO UPDATE SET
         "source_sync_revision" = EXCLUDED."source_sync_revision",
         "trigger_event_id" = EXCLUDED."trigger_event_id",
         "phase" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN 'manifest'
           ELSE "workspace_control"."knowledge_source_sync_job"."phase"
         END,
         "state" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN 'queued'
           ELSE "workspace_control"."knowledge_source_sync_job"."state"
         END,
         "attempt" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN 0
           ELSE "workspace_control"."knowledge_source_sync_job"."attempt"
         END,
         "total_files" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN 0
           ELSE "workspace_control"."knowledge_source_sync_job"."total_files"
         END,
         "processed_files" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN 0
           ELSE "workspace_control"."knowledge_source_sync_job"."processed_files"
         END,
         "available_at" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN now()
           ELSE "workspace_control"."knowledge_source_sync_job"."available_at"
         END,
         "claimed_at" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN NULL
           ELSE "workspace_control"."knowledge_source_sync_job"."claimed_at"
         END,
         "lease_expires_at" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN NULL
           ELSE "workspace_control"."knowledge_source_sync_job"."lease_expires_at"
         END,
         "worker_id" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN NULL
           ELSE "workspace_control"."knowledge_source_sync_job"."worker_id"
         END,
         "failure_code" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN NULL
           ELSE "workspace_control"."knowledge_source_sync_job"."failure_code"
         END,
         "finished_at" = CASE
           WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
             OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN NULL
           ELSE "workspace_control"."knowledge_source_sync_job"."finished_at"
         END,
         "updated_at" = now()
       RETURNING "id"
     )
     SELECT inserted_event."id"::text AS "eventId",
       (SELECT "id"::text FROM queued) AS "jobId"
     FROM inserted_event`,
    [
      input.organizationId,
      input.sourceId,
      input.deliveryId,
      checkedSha(input.beforeCommitSha),
      after,
      JSON.stringify(files),
    ],
  ) as Array<{ eventId: string; jobId: string | null }>;
  return rows[0] ?? null;
}

export async function listGithubKnowledgeReconciliationCandidates(limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Invalid GitHub reconciliation batch size");
  }
  const rows = await neonSql.query(
    `SELECT source."organization_id" AS "organizationId",
       source."id"::text AS "sourceId",
       installation."installation_id"::text AS "installationId",
       source."repository_full_name" AS "repositoryFullName",
       source."ref_name" AS "refName",
       source."commit_sha" AS "commitSha"
     FROM "workspace_control"."knowledge_source" source
     JOIN "workspace_control"."knowledge_github_installation" installation
       ON installation."organization_id" = source."organization_id"
      AND installation."id" = source."github_installation_id"
     WHERE source."provider" = 'github'
       AND source."revoked_at" IS NULL
       AND installation."status" = 'active'
       AND (
         source."last_reconciled_at" IS NULL
         OR source."last_reconciled_at" <= now() - interval '10 minutes'
       )
     ORDER BY source."last_reconciled_at" ASC NULLS FIRST, source."id"
     LIMIT $1`,
    [limit],
  ) as Array<Omit<GithubReconciliationCandidate, "installationId"> & {
    installationId: string;
  }>;
  return rows.map((row) => ({ ...row, installationId: BigInt(row.installationId) }));
}

export async function reconcileGithubKnowledgeCommit(input: {
  organizationId: string;
  sourceId: string;
  observedCommitSha: string;
}) {
  const observed = checkedSha(input.observedCommitSha);
  const deliveryId = `reconcile-${input.sourceId}-${observed}`;
  await neonSql.query(
    `WITH current_source AS MATERIALIZED (
       SELECT source."commit_sha", source."sync_revision", source."sync_state"
       FROM "workspace_control"."knowledge_source" source
       WHERE source."organization_id" = $1
         AND source."id" = $2::uuid
         AND source."provider" = 'github'
         AND source."revoked_at" IS NULL
       FOR UPDATE
     ), inserted_event AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_source_event" (
         "organization_id", "source_id", "delivery_id", "event_kind",
         "before_commit_sha", "after_commit_sha", "changed_files"
       )
       SELECT $1, $2::uuid, $4, 'repository', current_source."commit_sha", $3, '[]'::jsonb
       FROM current_source
       WHERE current_source."commit_sha" <> $3
       ON CONFLICT ("delivery_id", "source_id") DO NOTHING
       RETURNING "id"
     ), updated_source AS MATERIALIZED (
       UPDATE "workspace_control"."knowledge_source" source
       SET "commit_sha" = CASE
           WHEN source."commit_sha" <> $3 THEN $3
           ELSE source."commit_sha"
         END,
         "sync_state" = CASE
           WHEN source."commit_sha" <> $3 THEN 'pending'
           ELSE source."sync_state"
         END,
         "sync_revision" = CASE
           WHEN source."commit_sha" <> $3 THEN source."sync_revision" + 1
           ELSE source."sync_revision"
         END,
         "last_failure_code" = CASE
           WHEN source."commit_sha" <> $3 THEN NULL
           ELSE source."last_failure_code"
         END,
         "last_reconciled_at" = now(),
         "updated_at" = CASE
           WHEN source."commit_sha" <> $3 THEN now()
           ELSE source."updated_at"
         END
       FROM current_source
       WHERE source."organization_id" = $1
         AND source."id" = $2::uuid
       RETURNING source."sync_revision", source."sync_state"
     )
     INSERT INTO "workspace_control"."knowledge_source_sync_job" (
       "organization_id", "source_id", "desired_commit_sha",
       "source_sync_revision", "trigger_event_id"
     )
     SELECT $1, $2::uuid, $3, updated_source."sync_revision", inserted_event."id"
     FROM updated_source
     LEFT JOIN inserted_event ON true
     WHERE updated_source."sync_state" <> 'ready'
        OR inserted_event."id" IS NOT NULL
     ON CONFLICT ("source_id", "desired_commit_sha") DO UPDATE SET
       "source_sync_revision" = GREATEST(
         "workspace_control"."knowledge_source_sync_job"."source_sync_revision",
         EXCLUDED."source_sync_revision"
       ),
       "trigger_event_id" = COALESCE(
         EXCLUDED."trigger_event_id",
         "workspace_control"."knowledge_source_sync_job"."trigger_event_id"
       ),
       "phase" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision"
           THEN 'manifest'
         ELSE "workspace_control"."knowledge_source_sync_job"."phase"
       END,
       "state" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision"
           THEN 'queued'
         ELSE "workspace_control"."knowledge_source_sync_job"."state"
       END,
       "available_at" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision"
           THEN now()
         ELSE "workspace_control"."knowledge_source_sync_job"."available_at"
       END,
       "finished_at" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision"
           THEN NULL
         ELSE "workspace_control"."knowledge_source_sync_job"."finished_at"
       END,
       "attempt" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
           < EXCLUDED."source_sync_revision" THEN 0
         ELSE "workspace_control"."knowledge_source_sync_job"."attempt"
       END,
       "total_files" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN 0
         ELSE "workspace_control"."knowledge_source_sync_job"."total_files"
       END,
       "processed_files" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
             < EXCLUDED."source_sync_revision" THEN 0
         ELSE "workspace_control"."knowledge_source_sync_job"."processed_files"
       END,
       "claimed_at" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
           < EXCLUDED."source_sync_revision" THEN NULL
         ELSE "workspace_control"."knowledge_source_sync_job"."claimed_at"
       END,
       "lease_expires_at" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
           < EXCLUDED."source_sync_revision" THEN NULL
         ELSE "workspace_control"."knowledge_source_sync_job"."lease_expires_at"
       END,
       "worker_id" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
           < EXCLUDED."source_sync_revision" THEN NULL
         ELSE "workspace_control"."knowledge_source_sync_job"."worker_id"
       END,
       "failure_code" = CASE
         WHEN "workspace_control"."knowledge_source_sync_job"."state" = 'superseded'
           OR "workspace_control"."knowledge_source_sync_job"."source_sync_revision"
           < EXCLUDED."source_sync_revision" THEN NULL
         ELSE "workspace_control"."knowledge_source_sync_job"."failure_code"
       END,
       "updated_at" = now()`,
    [input.organizationId, input.sourceId, observed, deliveryId],
  );
}

export async function recordGithubKnowledgeReconciliationFailure(input: {
  organizationId: string;
  sourceId: string;
  refMissing: boolean;
}) {
  await neonSql.query(
    `UPDATE "workspace_control"."knowledge_source"
     SET "last_reconciled_at" = now(),
       "sync_state" = CASE WHEN $3 THEN 'stale' ELSE "sync_state" END,
       "last_failure_code" = CASE
         WHEN $3 THEN 'tracked_ref_unavailable'
         ELSE "last_failure_code"
       END,
       "updated_at" = CASE WHEN $3 THEN now() ELSE "updated_at" END
     WHERE "organization_id" = $1
       AND "id" = $2::uuid
       AND "provider" = 'github'
       AND "revoked_at" IS NULL`,
    [input.organizationId, input.sourceId, input.refMissing],
  );
}
