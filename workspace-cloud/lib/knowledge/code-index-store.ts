import "server-only";

import { randomUUID } from "node:crypto";

import { neonSql } from "../db";
import {
  analyzeCodeFile,
  buildCodeIndexArtifactFragment,
  codeIndexGraphRevisionId,
  codeIndexSourceRevisionSha256,
  compareCodeIndexPath,
  codeIndexManifestWindow,
  codeIndexPhaseHasStartBudget,
  codeIndexQueryTimeoutMs,
  codeLanguageForPath,
  MAX_CODE_INDEX_ENTITIES,
  MAX_CODE_INDEX_FILE_BYTES,
  MAX_CODE_INDEX_FILES,
  validateCodeFileAnalysis,
  type CodeFileAnalysis,
  type CodeIndexArtifactFile,
} from "./code-index-core";
import {
  readGithubBlobs,
} from "./github-app";
import { type KnowledgeSqlQuery } from "./graph-activation-core";
import { canonicalKnowledgeJson } from "./canonical-json";

export const LEASE_SECONDS = 120;
export const MAX_FAILURES = 5;
// Thirty-two one-megabyte-or-smaller files, fetched with bounded concurrency,
// leave room inside the 60-second Vercel route even when GitHub reaches its
// per-request timeout. The durable lease resumes at the next path on the next run.
export const FILE_BATCH_SIZE = 32;
export const MANIFEST_INSERT_BATCH_SIZE = 1_000;
export const ACTIVATION_FRAGMENT_FILE_BATCH_SIZE = 64;
export const ACTIVATION_FRAGMENT_ENTITY_BATCH_SIZE = 2_500;
export const ACTIVATION_FRAGMENT_INPUT_BYTES = 4 * 1024 * 1024;

export type CodeIndexPhase = "manifest" | "indexing" | "activating";

export type CodeIndexProgress = {
  manifestedFiles: number;
  processedFiles: number;
  pendingFiles: number;
  entityCount: number;
  serializedInputBytes: number;
};

export type QueueExecutionContext = {
  deadline: number;
  activationQuery: KnowledgeSqlQuery;
};

export type ActivationPhaseResult = "advanced" | "completed";

export type CodeIndexJob = {
  id: string;
  organizationId: string;
  sourceId: string;
  desiredCommitSha: string;
  sourceSyncRevision: number;
  phase: CodeIndexPhase;
  attempt: number;
  totalFiles: number;
  processedFiles: number;
  projectId: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  displayName: string;
  repositoryId: string;
  repositoryFullName: string;
  refName: string;
  installationId: bigint;
  parentGraphRevisionId: string | null;
  changedFiles: string[];
  manifest: unknown;
  sourceRevisionSha256: string;
  activationGraphRevisionId: string | null;
  activationParentGraphRevisionId: string | null;
  activationGeneratedAt: string | null;
};

export class CodeIndexFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "CodeIndexFailure";
  }
}

export type StoredManifest = Array<{
  path: string;
  blobSha: string;
  bytes: number;
}>;

export function validStoredManifest(value: unknown): value is StoredManifest {
  if (!Array.isArray(value) || value.length > MAX_CODE_INDEX_FILES) return false;
  let previous = "";
  for (const file of value) {
    if (
      !file
      || typeof file !== "object"
      || Array.isArray(file)
      || Object.keys(file).length !== 3
      || typeof file.path !== "string"
      || file.path.length < 1
      || file.path.length > 4_096
      || file.path.startsWith("/")
      || file.path.includes("\\")
      || /[\u0000-\u001f\u007f-\u009f]/.test(file.path)
      || file.path.split("/").some((segment: string) =>
        !segment || segment === "." || segment === ".."
      )
      || typeof file.blobSha !== "string"
      || !/^[0-9a-f]{40}$/.test(file.blobSha)
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || file.bytes > 16 * 1024 * 1024
    ) return false;
    if (previous && compareCodeIndexPath(file.path, previous) <= 0) return false;
    previous = file.path;
  }
  return true;
}

export function productionQuery(fetchTimeoutMs?: number): KnowledgeSqlQuery {
  return async (statement, parameters) => await neonSql.query(
    statement,
    [...parameters],
    fetchTimeoutMs === undefined
      ? undefined
      : { fetchOptions: { signal: AbortSignal.timeout(fetchTimeoutMs) } },
  ) as Record<string, unknown>[];
}

export function productionDeadlineQuery(deadline: number, maximumTimeoutMs: number): KnowledgeSqlQuery {
  return async (statement, parameters) => {
    const timeoutMs = codeIndexQueryTimeoutMs(deadline - Date.now(), maximumTimeoutMs);
    if (timeoutMs === null) throw new CodeIndexFailure("code_index_deadline_yield", true);
    return await productionQuery(timeoutMs)(statement, parameters);
  };
}

export function productionActivationDeadlineQuery(
  deadline: number,
  maximumTimeoutMs: number,
): KnowledgeSqlQuery {
  return async (statement, parameters) => {
    const fetchTimeoutMs = codeIndexQueryTimeoutMs(deadline - Date.now(), maximumTimeoutMs);
    if (fetchTimeoutMs === null) {
      throw new CodeIndexFailure("code_index_deadline_yield", true);
    }
    // AbortSignal alone bounds the Vercel caller but cannot prove that a remote
    // PostgreSQL backend stopped. Run the final CAS in a non-interactive
    // transaction with a slightly shorter server-side timeout. If the backend
    // reaches this bound the whole activation rolls back before the caller's
    // cleanup reserve begins.
    const statementTimeoutMs = Math.max(1_000, fetchTimeoutMs - 1_000);
    const results = await neonSql.transaction((sql) => [
      sql.query("SELECT set_config('statement_timeout', $1, true)", [
        String(statementTimeoutMs),
      ]),
      sql.query(statement, [...parameters]),
    ], {
      fetchOptions: { signal: AbortSignal.timeout(fetchTimeoutMs) },
    });
    return results[1] as Record<string, unknown>[];
  };
}

export function number(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function validChangedFiles(value: unknown) {
  if (!Array.isArray(value) || value.length > 10_000) return [];
  return value.filter((path): path is string =>
    typeof path === "string"
    && path.length > 0
    && path.length <= 4_096
    && !path.startsWith("/")
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f-\u009f]/.test(path)
    && path.split("/").every((segment) => segment && segment !== "." && segment !== "..")
  );
}

export async function claimCodeIndexJob(
  query: KnowledgeSqlQuery,
  workerId: string,
): Promise<CodeIndexJob | null> {
  const rows = await query(
    `WITH superseded AS MATERIALIZED (
       UPDATE "workspace_control"."knowledge_source_sync_job" job
       SET "state" = 'superseded',
         "claimed_at" = NULL,
         "lease_expires_at" = NULL,
         "worker_id" = NULL,
         "finished_at" = now(),
         "updated_at" = now()
       FROM "workspace_control"."knowledge_source" source
       WHERE source."organization_id" = job."organization_id"
         AND source."id" = job."source_id"
         AND job."state" IN ('queued', 'claimed')
         AND (
           source."revoked_at" IS NOT NULL
           OR source."provider" <> 'github'
           OR source."commit_sha" <> job."desired_commit_sha"
           OR source."sync_revision" <> job."source_sync_revision"
           OR source."sync_state" IN ('stale', 'revoked')
         )
       RETURNING job."id"
     ), purged AS (
       DELETE FROM "workspace_control"."knowledge_code_index_file" file
       USING superseded
       WHERE file."job_id" = superseded."id"
       RETURNING file."job_id"
     ), purged_fragments AS (
       DELETE FROM "workspace_control"."knowledge_code_index_activation_fragment" fragment
       USING superseded
       WHERE fragment."job_id" = superseded."id"
       RETURNING fragment."job_id"
     ), purged_entities AS (
       DELETE FROM "workspace_control"."knowledge_code_index_activation_entity" entity
       USING superseded
       WHERE entity."job_id" = superseded."id"
       RETURNING entity."job_id"
     ), candidate AS MATERIALIZED (
       SELECT job."id"
       FROM "workspace_control"."knowledge_source_sync_job" job
       JOIN "workspace_control"."knowledge_source" source
         ON source."organization_id" = job."organization_id"
        AND source."id" = job."source_id"
       JOIN "workspace_control"."knowledge_github_installation" installation
         ON installation."organization_id" = source."organization_id"
        AND installation."id" = source."github_installation_id"
       WHERE (
           (job."state" = 'queued' AND job."available_at" <= now())
           OR (job."state" = 'claimed' AND job."lease_expires_at" <= now())
         )
         AND job."attempt" < $2
         AND source."provider" = 'github'
         AND source."visibility" = 'shared_graph'
         AND source."revoked_at" IS NULL
         AND source."sync_state" IN ('pending', 'syncing')
         AND source."commit_sha" = job."desired_commit_sha"
         AND source."sync_revision" = job."source_sync_revision"
         AND installation."status" = 'active'
       ORDER BY job."available_at", job."created_at", job."id"
       FOR UPDATE OF job SKIP LOCKED
       LIMIT 1
     ), claimed AS MATERIALIZED (
       UPDATE "workspace_control"."knowledge_source_sync_job" job
       SET "state" = 'claimed',
         "claimed_at" = now(),
         "lease_expires_at" = now() + ($3 * interval '1 second'),
         "worker_id" = $1,
         "failure_code" = NULL,
         "finished_at" = NULL,
         "updated_at" = now()
       FROM candidate
       WHERE job."id" = candidate."id"
       RETURNING job.*
     ), syncing_source AS (
       UPDATE "workspace_control"."knowledge_source" source
       SET "sync_state" = 'syncing',
         "last_failure_code" = NULL,
         "updated_at" = now()
       FROM claimed
       WHERE source."organization_id" = claimed."organization_id"
         AND source."id" = claimed."source_id"
         AND source."commit_sha" = claimed."desired_commit_sha"
       RETURNING source."id"
     )
     SELECT claimed."id"::text AS "id",
       claimed."organization_id" AS "organizationId",
       claimed."source_id"::text AS "sourceId",
       claimed."desired_commit_sha" AS "desiredCommitSha",
       claimed."source_sync_revision"::text AS "sourceSyncRevision",
       claimed."phase" AS "phase",
       claimed."attempt" AS "attempt",
       claimed."total_files" AS "totalFiles",
       claimed."processed_files" AS "processedFiles",
       claimed."manifest" AS "manifest",
       claimed."source_revision_sha256" AS "sourceRevisionSha256",
       claimed."activation_graph_revision_id"::text AS "activationGraphRevisionId",
       claimed."activation_parent_graph_revision_id"::text AS "activationParentGraphRevisionId",
       claimed."activation_generated_at"::text AS "activationGeneratedAt",
       source."project_id"::text AS "projectId",
       source."project_environment_id"::text AS "projectEnvironmentId",
       source."environment_revision"::text AS "environmentRevision",
       source."display_name" AS "displayName",
       source."repository_id" AS "repositoryId",
       source."repository_full_name" AS "repositoryFullName",
       source."ref_name" AS "refName",
       installation."installation_id"::text AS "installationId",
       head."graph_revision_id"::text AS "parentGraphRevisionId",
       event."changed_files" AS "changedFiles"
     FROM claimed
     JOIN "workspace_control"."knowledge_source" source
       ON source."organization_id" = claimed."organization_id"
      AND source."id" = claimed."source_id"
     JOIN "workspace_control"."knowledge_github_installation" installation
       ON installation."organization_id" = source."organization_id"
      AND installation."id" = source."github_installation_id"
     LEFT JOIN "workspace_control"."knowledge_environment_head" head
       ON head."organization_id" = source."organization_id"
      AND head."project_environment_id" = source."project_environment_id"
      AND head."source_id" = source."id"
     LEFT JOIN "workspace_control"."knowledge_source_event" event
       ON event."id" = claimed."trigger_event_id"`,
    [workerId, MAX_FAILURES, LEASE_SECONDS],
  );
  const row = rows[0];
  if (!row) return null;
  const sourceSyncRevision = number(row.sourceSyncRevision);
  const environmentRevision = number(row.environmentRevision);
  const attempt = number(row.attempt);
  const totalFiles = number(row.totalFiles);
  const processedFiles = number(row.processedFiles);
  const phase = String(row.phase) as CodeIndexPhase;
  if (
    typeof row.id !== "string"
    || typeof row.organizationId !== "string"
    || typeof row.sourceId !== "string"
    || typeof row.desiredCommitSha !== "string"
    || !/^[0-9a-f]{40}$/.test(row.desiredCommitSha)
    || sourceSyncRevision === null
    || sourceSyncRevision < 1
    || !["manifest", "indexing", "activating"].includes(phase)
    || attempt === null
    || attempt < 0
    || totalFiles === null
    || totalFiles < 0
    || processedFiles === null
    || processedFiles < 0
    || processedFiles > totalFiles
    || typeof row.projectId !== "string"
    || typeof row.projectEnvironmentId !== "string"
    || environmentRevision === null
    || environmentRevision < 1
    || typeof row.displayName !== "string"
    || typeof row.repositoryId !== "string"
    || !/^[1-9][0-9]{0,19}$/.test(row.repositoryId)
    || typeof row.repositoryFullName !== "string"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.repositoryFullName)
    || typeof row.refName !== "string"
    || typeof row.installationId !== "string"
    || !/^[1-9][0-9]{0,19}$/.test(row.installationId)
    || (row.parentGraphRevisionId !== null && typeof row.parentGraphRevisionId !== "string")
    || (row.manifest !== null && !validStoredManifest(row.manifest))
    || (phase !== "manifest" && !validStoredManifest(row.manifest))
    || typeof row.sourceRevisionSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(row.sourceRevisionSha256)
    || (validStoredManifest(row.manifest)
      && codeIndexSourceRevisionSha256(row.manifest) !== row.sourceRevisionSha256)
    || (row.activationGraphRevisionId !== null
      && typeof row.activationGraphRevisionId !== "string")
    || (row.activationParentGraphRevisionId !== null
      && typeof row.activationParentGraphRevisionId !== "string")
    || (row.activationGeneratedAt !== null
      && (typeof row.activationGeneratedAt !== "string"
        || !Number.isFinite(Date.parse(row.activationGeneratedAt))))
    || ((row.activationGraphRevisionId === null) !== (row.activationGeneratedAt === null))
  ) {
    throw new CodeIndexFailure("code_index_job_invalid", false);
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    sourceId: row.sourceId,
    desiredCommitSha: row.desiredCommitSha,
    sourceSyncRevision,
    phase,
    attempt,
    totalFiles,
    processedFiles,
    projectId: row.projectId,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision,
    displayName: row.displayName,
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    refName: row.refName,
    installationId: BigInt(row.installationId),
    parentGraphRevisionId: row.parentGraphRevisionId as string | null,
    changedFiles: validChangedFiles(row.changedFiles),
    manifest: row.manifest,
    sourceRevisionSha256: row.sourceRevisionSha256,
    activationGraphRevisionId: row.activationGraphRevisionId as string | null,
    activationParentGraphRevisionId: row.activationParentGraphRevisionId as string | null,
    activationGeneratedAt: typeof row.activationGeneratedAt === "string"
      ? new Date(row.activationGeneratedAt).toISOString()
      : null,
  };
}

export async function transitionJob(
  query: KnowledgeSqlQuery,
  job: CodeIndexJob,
  workerId: string,
  phase: CodeIndexPhase,
  totalFiles: number,
  processedFiles: number,
) {
  const rows = await query(
    `UPDATE "workspace_control"."knowledge_source_sync_job"
     SET "phase" = $3,
       "state" = 'queued',
       "total_files" = $4,
       "processed_files" = $5,
       "available_at" = now(),
       "claimed_at" = NULL,
       "lease_expires_at" = NULL,
       "worker_id" = NULL,
       "updated_at" = now()
     WHERE "id" = $1::uuid
       AND "worker_id" = $2
       AND "state" = 'claimed'
     RETURNING "id"::text AS "id"`,
    [job.id, workerId, phase, totalFiles, processedFiles],
  );
  if (rows.length !== 1) throw new CodeIndexFailure("code_index_lease_lost", true);
}

export async function readCodeIndexProgress(
  query: KnowledgeSqlQuery,
  job: CodeIndexJob,
  workerId: string,
): Promise<CodeIndexProgress> {
  const rows = await query(
    `WITH eligible_job AS MATERIALIZED (
       SELECT job."id"
       FROM "workspace_control"."knowledge_source_sync_job" job
       WHERE job."organization_id" = $1
         AND job."source_id" = $2::uuid
         AND job."id" = $3::uuid
         AND job."desired_commit_sha" = $4
         AND job."source_sync_revision" = $5::bigint
         AND job."state" = 'claimed'
         AND job."worker_id" = $6
         AND job."lease_expires_at" > now()
     ), progress AS MATERIALIZED (
       SELECT count(*)::int AS "manifestedFiles",
         count(*) FILTER (WHERE file."state" <> 'pending')::int AS "processedFiles",
         count(*) FILTER (WHERE file."state" = 'pending')::int AS "pendingFiles",
         (count(*) + COALESCE(sum(
           CASE WHEN file."state" = 'ready' THEN
             jsonb_array_length(file."analysis" -> 'symbols')
             + jsonb_array_length(file."analysis" -> 'references')
           ELSE 0 END
         ), 0))::bigint AS "entityCount",
         COALESCE(sum(
           128
           + octet_length(file."path")
           + octet_length(file."blob_sha")
           + octet_length(file."language")
           + CASE WHEN file."analysis" IS NULL
             THEN 4
             ELSE octet_length(file."analysis"::text)
           END
         ), 0)::bigint AS "serializedInputBytes"
       FROM "workspace_control"."knowledge_code_index_file" file
       WHERE file."organization_id" = $1
         AND file."job_id" = $3::uuid
         AND file."source_id" = $2::uuid
     )
     SELECT progress.*
     FROM eligible_job CROSS JOIN progress`,
    [
      job.organizationId,
      job.sourceId,
      job.id,
      job.desiredCommitSha,
      job.sourceSyncRevision,
      workerId,
    ],
  );
  const row = rows[0];
  if (!row) throw new CodeIndexFailure("code_index_lease_lost", true);
  const progress = {
    manifestedFiles: number(row.manifestedFiles),
    processedFiles: number(row.processedFiles),
    pendingFiles: number(row.pendingFiles),
    entityCount: number(row.entityCount),
    serializedInputBytes: number(row.serializedInputBytes),
  };
  if (Object.values(progress).some((value) => value === null)) {
    throw new CodeIndexFailure("stored_code_index_invalid", false);
  }
  return progress as CodeIndexProgress;
}

export function requireEntityBudget(progress: CodeIndexProgress) {
  if (progress.entityCount > MAX_CODE_INDEX_ENTITIES) {
    throw new CodeIndexFailure("code_index_entity_limit", false);
  }
}

export function retryDelaySeconds(attempt: number) {
  return Math.min(30 * (4 ** Math.max(0, attempt)), 30 * 60);
}

export async function failCodeIndexJob(
  query: KnowledgeSqlQuery,
  job: CodeIndexJob,
  workerId: string,
  failure: CodeIndexFailure,
) {
  const nextAttempt = job.attempt + 1;
  const retry = failure.retryable && nextAttempt < MAX_FAILURES;
  await query(
    `WITH failed_job AS MATERIALIZED (
       UPDATE "workspace_control"."knowledge_source_sync_job" job
       SET "state" = CASE WHEN $4 THEN 'queued' ELSE 'failed' END,
         "attempt" = $6,
         "available_at" = CASE
           WHEN $4 THEN now() + ($5 * interval '1 second')
           ELSE job."available_at"
         END,
         "claimed_at" = NULL,
         "lease_expires_at" = NULL,
         "worker_id" = NULL,
         "failure_code" = $3,
         "finished_at" = CASE WHEN $4 THEN NULL ELSE now() END,
         "updated_at" = now()
       WHERE job."id" = $1::uuid
         AND job."worker_id" = $2
         AND job."state" = 'claimed'
       RETURNING job."id", job."organization_id", job."source_id", job."desired_commit_sha"
     ), purged AS (
       DELETE FROM "workspace_control"."knowledge_code_index_file" file
       USING failed_job
       WHERE file."job_id" = failed_job."id" AND NOT $4
       RETURNING file."job_id"
     ), purged_fragments AS (
       DELETE FROM "workspace_control"."knowledge_code_index_activation_fragment" fragment
       USING failed_job
       WHERE fragment."job_id" = failed_job."id" AND NOT $4
       RETURNING fragment."job_id"
     ), purged_entities AS (
       DELETE FROM "workspace_control"."knowledge_code_index_activation_entity" entity
       USING failed_job
       WHERE entity."job_id" = failed_job."id" AND NOT $4
       RETURNING entity."job_id"
     )
     UPDATE "workspace_control"."knowledge_source" source
     SET "sync_state" = CASE WHEN $4 THEN 'pending' ELSE 'failed' END,
       "last_failure_code" = CASE WHEN $4 THEN NULL ELSE $3 END,
       "updated_at" = now()
     FROM failed_job
     WHERE source."organization_id" = failed_job."organization_id"
       AND source."id" = failed_job."source_id"
       AND source."commit_sha" = failed_job."desired_commit_sha"`,
    [job.id, workerId, failure.code, retry, retryDelaySeconds(job.attempt), nextAttempt],
  );
}

export async function insertCodeIndexManifestBatch(
  query: KnowledgeSqlQuery,
  job: CodeIndexJob,
  workerId: string,
  values: Array<{
    path: string;
    blobSha: string;
    bytes: number;
    language: string;
    initialState: "pending" | "skipped";
    failureCode: string | null;
  }>,
) {
  await query(
    `WITH eligible_job AS MATERIALIZED (
       SELECT job."id"
       FROM "workspace_control"."knowledge_source_sync_job" job
       WHERE job."organization_id" = $1
         AND job."source_id" = $2::uuid
         AND job."id" = $3::uuid
         AND job."desired_commit_sha" = $4
         AND job."source_sync_revision" = $7::bigint
         AND job."state" = 'claimed'
         AND job."worker_id" = $6
         AND job."lease_expires_at" > now()
     ), incoming AS MATERIALIZED (
       SELECT * FROM jsonb_to_recordset($5::text::jsonb) AS file(
         "path" text,
         "blobSha" text,
         "bytes" integer,
         "language" text,
         "initialState" text,
         "failureCode" text
       )
     ), projected AS (
       SELECT incoming.*,
         CASE
           WHEN incoming."initialState" = 'skipped' THEN 'skipped'
           WHEN reused."analysis" IS NOT NULL THEN 'ready'
           ELSE 'pending'
         END AS "state",
         CASE
           WHEN incoming."initialState" = 'skipped' THEN NULL
           ELSE reused."analysis"
         END AS "analysis"
       FROM incoming
       LEFT JOIN LATERAL (
         SELECT previous."analysis"
         FROM "workspace_control"."knowledge_code_index_file" previous
         WHERE previous."organization_id" = $1
           AND previous."source_id" = $2::uuid
           AND previous."blob_sha" = incoming."blobSha"
           AND previous."language" = incoming."language"
           AND previous."state" = 'ready'
           AND previous."job_id" <> $3::uuid
         ORDER BY previous."updated_at" DESC
         LIMIT 1
       ) reused ON true
     )
     INSERT INTO "workspace_control"."knowledge_code_index_file" (
       "organization_id", "job_id", "source_id", "commit_sha", "path",
       "blob_sha", "bytes", "language", "state", "analysis", "failure_code"
     )
     SELECT $1, $3::uuid, $2::uuid, $4, projected."path", projected."blobSha",
       projected."bytes", projected."language", projected."state",
       projected."analysis", projected."failureCode"
     FROM projected CROSS JOIN eligible_job
     ON CONFLICT ("job_id", "path") DO UPDATE SET
       "blob_sha" = EXCLUDED."blob_sha",
       "bytes" = EXCLUDED."bytes",
       "language" = EXCLUDED."language",
       "state" = EXCLUDED."state",
       "analysis" = EXCLUDED."analysis",
       "failure_code" = EXCLUDED."failure_code",
       "updated_at" = now()`,
    [
      job.organizationId,
      job.sourceId,
      job.id,
      job.desiredCommitSha,
      JSON.stringify(values),
      workerId,
      job.sourceSyncRevision,
    ],
  );
}
