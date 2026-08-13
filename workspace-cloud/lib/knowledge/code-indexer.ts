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

const LEASE_SECONDS = 120;
const MAX_FAILURES = 5;
// Thirty-two one-megabyte-or-smaller files, fetched with bounded concurrency,
// leave room inside the 60-second Vercel route even when GitHub reaches its
// per-request timeout. The durable lease resumes at the next path on the next run.
const FILE_BATCH_SIZE = 32;
const MANIFEST_INSERT_BATCH_SIZE = 1_000;
const ACTIVATION_FRAGMENT_FILE_BATCH_SIZE = 64;
const ACTIVATION_FRAGMENT_ENTITY_BATCH_SIZE = 2_500;
const ACTIVATION_FRAGMENT_INPUT_BYTES = 4 * 1024 * 1024;

type CodeIndexPhase = "manifest" | "indexing" | "activating";

type CodeIndexProgress = {
  manifestedFiles: number;
  processedFiles: number;
  pendingFiles: number;
  entityCount: number;
  serializedInputBytes: number;
};

type QueueExecutionContext = {
  deadline: number;
  activationQuery: KnowledgeSqlQuery;
};

type ActivationPhaseResult = "advanced" | "completed";

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

type StoredManifest = Array<{
  path: string;
  blobSha: string;
  bytes: number;
}>;

function validStoredManifest(value: unknown): value is StoredManifest {
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

function productionQuery(fetchTimeoutMs?: number): KnowledgeSqlQuery {
  return async (statement, parameters) => await neonSql.query(
    statement,
    [...parameters],
    fetchTimeoutMs === undefined
      ? undefined
      : { fetchOptions: { signal: AbortSignal.timeout(fetchTimeoutMs) } },
  ) as Record<string, unknown>[];
}

function productionDeadlineQuery(deadline: number, maximumTimeoutMs: number): KnowledgeSqlQuery {
  return async (statement, parameters) => {
    const timeoutMs = codeIndexQueryTimeoutMs(deadline - Date.now(), maximumTimeoutMs);
    if (timeoutMs === null) throw new CodeIndexFailure("code_index_deadline_yield", true);
    return await productionQuery(timeoutMs)(statement, parameters);
  };
}

function productionActivationDeadlineQuery(
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

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validChangedFiles(value: unknown) {
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

async function transitionJob(
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

async function readCodeIndexProgress(
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

function requireEntityBudget(progress: CodeIndexProgress) {
  if (progress.entityCount > MAX_CODE_INDEX_ENTITIES) {
    throw new CodeIndexFailure("code_index_entity_limit", false);
  }
}

function retryDelaySeconds(attempt: number) {
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

async function manifestPhase(query: KnowledgeSqlQuery, job: CodeIndexJob, workerId: string) {
  let manifest = job.manifest;
  if (!validStoredManifest(manifest)) {
    throw new CodeIndexFailure("code_index_manifest_checkpoint_invalid", false);
  }
  if (job.totalFiles !== 0 && job.totalFiles !== manifest.length) {
    throw new CodeIndexFailure("code_index_manifest_checkpoint_invalid", false);
  }
  const before = await readCodeIndexProgress(query, job, workerId);
  const window = codeIndexManifestWindow(
    manifest.length,
    before.manifestedFiles,
    MANIFEST_INSERT_BATCH_SIZE,
  );
  const values = manifest.slice(window.start, window.end).map((file) => {
    const language = codeLanguageForPath(file.path) ?? "unsupported";
    const skipped = language === "unsupported" || file.bytes > MAX_CODE_INDEX_FILE_BYTES;
    return {
      ...file,
      language,
      initialState: skipped ? "skipped" as const : "pending" as const,
      failureCode: skipped ? "file_not_indexed" : null,
    };
  });
  if (values.length > 0) {
    await insertCodeIndexManifestBatch(
      query,
      job,
      workerId,
      values,
    );
  }
  const progress = values.length > 0
    ? await readCodeIndexProgress(query, job, workerId)
    : before;
  if (
    progress.manifestedFiles !== window.end
    || progress.processedFiles < job.processedFiles
  ) {
    throw new CodeIndexFailure("code_index_manifest_checkpoint_invalid", false);
  }
  requireEntityBudget(progress);
  const manifestComplete = progress.manifestedFiles === manifest.length;
  await transitionJob(
    query,
    job,
    workerId,
    manifestComplete
      ? (progress.pendingFiles === 0 ? "activating" : "indexing")
      : "manifest",
    manifest.length,
    progress.processedFiles,
  );
}

async function initializeActivation(
  query: KnowledgeSqlQuery,
  job: CodeIndexJob,
  workerId: string,
) {
  const generatedAt = new Date().toISOString();
  let graphRevisionId: string;
  try {
    graphRevisionId = codeIndexGraphRevisionId({
      sourceId: job.sourceId,
      projectEnvironmentId: job.projectEnvironmentId,
      environmentRevision: job.environmentRevision,
      parentGraphRevisionId: job.parentGraphRevisionId,
      sourceRevisionSha256: job.sourceRevisionSha256,
    });
  } catch {
    throw new CodeIndexFailure("code_index_artifact_invalid", false);
  }
  const initialized = await query(
    `UPDATE "workspace_control"."knowledge_source_sync_job" current_job
     SET "activation_graph_revision_id" = $3::uuid,
       "activation_parent_graph_revision_id" = $4::uuid,
       "activation_generated_at" = $5::timestamptz,
       "updated_at" = now()
     WHERE current_job."id" = $1::uuid
       AND current_job."worker_id" = $2
       AND current_job."state" = 'claimed'
       AND current_job."phase" = 'activating'
       AND current_job."activation_graph_revision_id" IS NULL
       AND current_job."lease_expires_at" > now()
     RETURNING current_job."id"`,
    [job.id, workerId, graphRevisionId, job.parentGraphRevisionId, generatedAt],
  );
  if (initialized.length !== 1) throw new CodeIndexFailure("code_index_lease_lost", true);
}

async function indexingPhase(query: KnowledgeSqlQuery, job: CodeIndexJob, workerId: string) {
  const pending = await query(
    `SELECT file."path", file."blob_sha" AS "blobSha", file."bytes", file."language"
     FROM "workspace_control"."knowledge_code_index_file" file
     WHERE file."organization_id" = $1
       AND file."job_id" = $2::uuid
       AND file."source_id" = $3::uuid
       AND file."state" = 'pending'
       AND EXISTS (
         SELECT 1 FROM "workspace_control"."knowledge_source_sync_job" job
         WHERE job."id" = file."job_id"
           AND job."state" = 'claimed'
           AND job."worker_id" = $4
           AND job."lease_expires_at" > now()
       )
     ORDER BY convert_to(file."path", 'UTF8')
     LIMIT $5`,
    [job.organizationId, job.id, job.sourceId, workerId, FILE_BATCH_SIZE],
  );
  if (pending.length === 0) {
    const progress = await readCodeIndexProgress(query, job, workerId);
    if (
      progress.manifestedFiles !== job.totalFiles
      || progress.processedFiles !== progress.manifestedFiles
    ) {
      throw new CodeIndexFailure("stored_code_index_incomplete", false);
    }
    requireEntityBudget(progress);
    await transitionJob(
      query,
      job,
      workerId,
      "activating",
      progress.manifestedFiles,
      progress.processedFiles,
    );
    return;
  }
  let downloaded: Array<{ path: string; bytes: Buffer }>;
  try {
    downloaded = await readGithubBlobs(
      job.installationId,
      job.repositoryFullName,
      pending.map((file) => ({ path: String(file.path), blobSha: String(file.blobSha) })),
    );
  } catch {
    throw new CodeIndexFailure("github_blob_batch_unavailable", true);
  }
  const indexed = downloaded.map((file, index) => {
    const manifest = pending[index]!;
    const analysis = analyzeCodeFile(file.path, file.bytes);
    return {
      path: file.path,
      state: analysis ? "ready" : "skipped",
      language: String(manifest.language),
      analysis,
      failureCode: analysis ? null : "file_not_indexed",
    };
  });
  const updated = await query(
    `WITH result AS MATERIALIZED (
       SELECT * FROM jsonb_to_recordset($5::text::jsonb) AS indexed(
         "path" text,
         "state" text,
         "language" text,
         "analysis" jsonb,
         "failureCode" text
       )
     ), changed AS (
       UPDATE "workspace_control"."knowledge_code_index_file" file
       SET "state" = result."state",
         "language" = result."language",
         "analysis" = result."analysis",
         "failure_code" = result."failureCode",
         "updated_at" = now()
       FROM result
       WHERE file."organization_id" = $1
         AND file."job_id" = $2::uuid
         AND file."source_id" = $3::uuid
         AND file."path" = result."path"
         AND file."state" = 'pending'
         AND EXISTS (
           SELECT 1 FROM "workspace_control"."knowledge_source_sync_job" job
           WHERE job."id" = file."job_id"
             AND job."state" = 'claimed'
             AND job."worker_id" = $4
             AND job."lease_expires_at" > now()
         )
       RETURNING file."path"
     )
     SELECT count(*)::int AS "updated" FROM changed`,
    [job.organizationId, job.id, job.sourceId, workerId, JSON.stringify(indexed)],
  );
  if (number(updated[0]?.updated) !== indexed.length) {
    throw new CodeIndexFailure("code_index_lease_lost", true);
  }
  const progress = await readCodeIndexProgress(query, job, workerId);
  if (progress.manifestedFiles !== job.totalFiles) {
    throw new CodeIndexFailure("stored_code_index_incomplete", false);
  }
  requireEntityBudget(progress);
  await transitionJob(
    query,
    job,
    workerId,
    progress.pendingFiles === 0 ? "activating" : "indexing",
    progress.manifestedFiles,
    progress.processedFiles,
  );
}

async function activatingPhase(
  query: KnowledgeSqlQuery,
  job: CodeIndexJob,
  workerId: string,
  execution: QueueExecutionContext,
): Promise<ActivationPhaseResult> {
  const progress = await readCodeIndexProgress(query, job, workerId);
  if (
    progress.manifestedFiles !== job.totalFiles
    || progress.processedFiles !== job.totalFiles
    || progress.pendingFiles !== 0
  ) {
    throw new CodeIndexFailure("stored_code_index_incomplete", false);
  }
  requireEntityBudget(progress);
  if (job.activationGraphRevisionId === null) {
    await initializeActivation(query, job, workerId);
    await transitionJob(query, job, workerId, "activating", job.totalFiles, job.processedFiles);
    return "advanced";
  }
  const fragmentProgress = await query(
    `WITH ordered AS (
       SELECT fragment."batch_index", fragment."file_count",
         fragment."start_path", fragment."end_path",
         lag(fragment."end_path") OVER (ORDER BY fragment."batch_index") AS previous_end,
         row_number() OVER (ORDER BY fragment."batch_index") - 1 AS expected_batch
       FROM "workspace_control"."knowledge_code_index_activation_fragment" fragment
       WHERE fragment."organization_id" = $1
         AND fragment."job_id" = $2::uuid
         AND fragment."source_id" = $3::uuid
     )
     SELECT COALESCE(sum(ordered."file_count"), 0)::int AS "preparedFiles",
       count(*)::int AS "fragmentCount",
       COALESCE(bool_and(
         ordered."batch_index" = ordered.expected_batch
       ), true) AS "continuous"
     FROM ordered`,
    [job.organizationId, job.id, job.sourceId],
  );
  const preparedFiles = number(fragmentProgress[0]?.preparedFiles);
  const fragmentCount = number(fragmentProgress[0]?.fragmentCount);
  if (
    preparedFiles === null
    || fragmentCount === null
    || preparedFiles < 0
    || preparedFiles > job.totalFiles
    || fragmentProgress[0]?.continuous !== true
  ) {
    throw new CodeIndexFailure("stored_code_index_invalid", false);
  }
  if (preparedFiles < job.totalFiles) {
    await prepareActivationFragment(query, job, workerId, preparedFiles, fragmentCount);
    await transitionJob(
      query,
      job,
      workerId,
      "activating",
      job.totalFiles,
      job.processedFiles,
    );
    return "advanced";
  }
  if (execution.deadline - Date.now() < 22_000) {
    await transitionJob(query, job, workerId, "activating", job.totalFiles, job.processedFiles);
    return "advanced";
  }
  await activateStagedKnowledgeGraph(execution.activationQuery, job, workerId);
  await purgeOldCodeIndexState(query, job);
  return "completed";
}

async function prepareActivationFragment(
  query: KnowledgeSqlQuery,
  job: CodeIndexJob,
  workerId: string,
  preparedFiles: number,
  fragmentCount: number,
) {
  const rows = await query(
    `WITH candidates AS MATERIALIZED (
       SELECT file.*,
         row_number() OVER (ORDER BY convert_to(file."path", 'UTF8')) AS ordinal,
         sum(1 + CASE WHEN file."state" = 'ready' THEN
           jsonb_array_length(file."analysis" -> 'symbols')
           + jsonb_array_length(file."analysis" -> 'references')
         ELSE 0 END) OVER (ORDER BY convert_to(file."path", 'UTF8')) AS running_entities,
         sum(octet_length(COALESCE(file."analysis"::text, 'null'))
           + octet_length(file."path") + 128
         ) OVER (ORDER BY convert_to(file."path", 'UTF8')) AS running_bytes
       FROM (
         SELECT stored_file.*
         FROM "workspace_control"."knowledge_code_index_file" stored_file
         WHERE stored_file."organization_id" = $1
           AND stored_file."job_id" = $2::uuid
           AND stored_file."source_id" = $3::uuid
           AND stored_file."state" IN ('ready', 'skipped')
         ORDER BY convert_to(stored_file."path", 'UTF8')
         OFFSET $4 LIMIT $5
       ) file
     )
     SELECT candidates."path", candidates."blob_sha" AS "blobSha", candidates."bytes",
       candidates."language", candidates."state", candidates."analysis"
     FROM candidates
     WHERE candidates.ordinal = 1
        OR (candidates.running_entities <= $6 AND candidates.running_bytes <= $7)
     ORDER BY candidates.ordinal`,
    [
      job.organizationId,
      job.id,
      job.sourceId,
      preparedFiles,
      ACTIVATION_FRAGMENT_FILE_BATCH_SIZE,
      ACTIVATION_FRAGMENT_ENTITY_BATCH_SIZE,
      ACTIVATION_FRAGMENT_INPUT_BYTES,
    ],
  );
  const files: CodeIndexArtifactFile[] = rows.map((row) => {
    const analysis = row.state === "ready" ? row.analysis : null;
    if (analysis !== null && !validateCodeFileAnalysis(analysis)) {
      throw new CodeIndexFailure("stored_code_index_invalid", false);
    }
    return {
      path: String(row.path),
      blobSha: String(row.blobSha),
      bytes: Number(row.bytes),
      language: String(row.language),
      analysis: analysis as CodeFileAnalysis | null,
    };
  });
  if (files.length < 1 || files.length > ACTIVATION_FRAGMENT_FILE_BATCH_SIZE) {
    throw new CodeIndexFailure("stored_code_index_incomplete", false);
  }
  const callNames = [...new Set(files.flatMap((file) =>
    (file.analysis?.references ?? [])
      .filter((reference) => {
        const shortName = reference.targetName.split(/[.:]/).at(-1);
        return reference.relation === "calls" && shortName === reference.targetName;
      })
      .map((reference) => reference.targetName)
  ))];
  const externalRows = callNames.length === 0 ? [] : await query(
    `WITH target AS MATERIALIZED (
       SELECT * FROM jsonb_to_recordset($4::text::jsonb) AS requested("name" text)
     ), candidate AS MATERIALIZED (
       SELECT target."name", count(symbol.item)::int AS matches,
         min(file."path") AS "path", min(file."language") AS "language",
         min((symbol.item ->> 'lineStart')::int) AS "lineStart",
         min((symbol.item ->> 'lineEnd')::int) AS "lineEnd",
         min(symbol.item ->> 'signature') AS "signature"
       FROM "workspace_control"."knowledge_code_index_file" file
       CROSS JOIN LATERAL jsonb_array_elements(file."analysis" -> 'symbols') symbol(item)
       JOIN target ON target."name" = symbol.item ->> 'name'
       WHERE file."organization_id" = $1
         AND file."job_id" = $2::uuid
         AND file."source_id" = $3::uuid
         AND file."state" = 'ready'
         AND symbol.item ->> 'kind' = 'function'
       GROUP BY target."name"
     )
     SELECT candidate."name", candidate."path", candidate."language",
       candidate."lineStart", candidate."lineEnd", candidate."signature", candidate.matches
     FROM candidate`,
    [job.organizationId, job.id, job.sourceId, JSON.stringify(callNames.map((name) => ({ name })))],
  );
  const currentPaths = new Set(files.map((file) => file.path));
  const globallyAmbiguousCallNames = externalRows.flatMap((row) =>
    number(row.matches) !== null && Number(row.matches) > 1 && typeof row.name === "string"
      ? [row.name]
      : []
  );
  const externalUniqueSymbols = externalRows.flatMap((row) => {
    const lineStart = number(row.lineStart);
    const lineEnd = number(row.lineEnd);
    return typeof row.name === "string"
      && typeof row.path === "string"
      && number(row.matches) === 1
      && !currentPaths.has(row.path)
      && typeof row.language === "string"
      && lineStart !== null && lineStart > 0
      && lineEnd !== null && lineEnd >= lineStart
      && typeof row.signature === "string"
      ? [{
        name: row.name,
        path: row.path,
        language: row.language,
        lineStart,
        lineEnd,
        signature: row.signature,
      }]
      : [];
  });
  let artifact;
  try {
    artifact = buildCodeIndexArtifactFragment({
      sourceId: job.sourceId,
      projectId: job.projectId,
      projectEnvironmentId: job.projectEnvironmentId,
      environmentRevision: job.environmentRevision,
      displayName: job.displayName,
      repositoryId: job.repositoryId,
      repository: job.repositoryFullName,
      refName: job.refName,
      commitSha: job.desiredCommitSha,
      parentGraphRevisionId: job.activationParentGraphRevisionId,
      changedFiles: job.changedFiles,
      generatedAt: job.activationGeneratedAt!,
      files,
      completeFileManifest: validStoredManifest(job.manifest) ? job.manifest : [],
      exactSourceRevisionSha256: job.sourceRevisionSha256,
      externalUniqueSymbols,
      globallyAmbiguousCallNames,
    });
  } catch {
    throw new CodeIndexFailure("code_index_artifact_invalid", false);
  }
  const health = artifact.health as Record<string, unknown>;
  const primaryNodeIds = new Set(files.map((file) =>
    String((artifact.nodes as Array<Record<string, unknown>>).find((node) =>
      node.kind === "file" && node.qualifiedName === file.path
    )?.id ?? "")
  ));
  for (const edge of artifact.edges as Array<Record<string, unknown>>) {
    if (edge.relation === "defines") primaryNodeIds.add(String(edge.to));
  }
  const entities = [
    ...(artifact.nodes as Array<Record<string, unknown>>).map((payload) => ({
      entityKind: "node",
      entityId: String(payload.id),
      primaryDefinition: primaryNodeIds.has(String(payload.id)),
      payload,
      canonicalPayload: canonicalKnowledgeJson(payload),
    })),
    ...(artifact.edges as Array<Record<string, unknown>>).map((payload) => ({
      entityKind: "edge", entityId: String(payload.id), primaryDefinition: false, payload,
      canonicalPayload: canonicalKnowledgeJson(payload),
    })),
    ...(artifact.evidence as Array<Record<string, unknown>>).map((payload) => ({
      entityKind: "evidence", entityId: String(payload.id), primaryDefinition: false, payload,
      canonicalPayload: canonicalKnowledgeJson(payload),
    })),
  ];
  const stored = await query(
    `WITH eligible_job AS MATERIALIZED (
       SELECT 1
       FROM "workspace_control"."knowledge_source_sync_job" current_job
       WHERE current_job."id" = $2::uuid
         AND current_job."organization_id" = $1
         AND current_job."source_id" = $3::uuid
         AND current_job."state" = 'claimed'
         AND current_job."phase" = 'activating'
         AND current_job."worker_id" = $9
         AND current_job."lease_expires_at" > now()
     ), inserted_fragment AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_code_index_activation_fragment" (
         "organization_id", "job_id", "source_id", "batch_index",
         "start_path", "end_path", "file_count", "parsed_files", "skipped_files"
       )
       SELECT $1, $2::uuid, $3::uuid, $4, $5, $6, $7, $10, $11
       FROM eligible_job
       ON CONFLICT ("job_id", "batch_index") DO NOTHING
       RETURNING "batch_index"
     ), incoming AS MATERIALIZED (
       SELECT * FROM jsonb_to_recordset($8::text::jsonb) AS entity(
         "entityKind" text,
         "entityId" text,
         "primaryDefinition" boolean,
         "payload" jsonb,
         "canonicalPayload" text
       )
     ), inserted_entities AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_code_index_activation_entity" (
         "organization_id", "job_id", "source_id", "entity_kind", "entity_id",
         "batch_index", "primary_definition", "payload", "canonical_payload"
       )
       SELECT $1, $2::uuid, $3::uuid, incoming."entityKind", incoming."entityId",
         $4, incoming."primaryDefinition", incoming."payload", incoming."canonicalPayload"
       FROM incoming CROSS JOIN inserted_fragment
       ON CONFLICT ("job_id", "entity_kind", "entity_id") DO UPDATE SET
         "primary_definition" = "knowledge_code_index_activation_entity"."primary_definition"
           OR EXCLUDED."primary_definition",
         "payload" = CASE
           WHEN "knowledge_code_index_activation_entity"."primary_definition"
             AND NOT EXCLUDED."primary_definition"
             THEN "knowledge_code_index_activation_entity"."payload"
           ELSE EXCLUDED."payload"
         END,
         "canonical_payload" = CASE
           WHEN "knowledge_code_index_activation_entity"."primary_definition"
             AND NOT EXCLUDED."primary_definition"
             THEN "knowledge_code_index_activation_entity"."canonical_payload"
           ELSE EXCLUDED."canonical_payload"
         END
       WHERE "knowledge_code_index_activation_entity"."payload" = EXCLUDED."payload"
          OR "knowledge_code_index_activation_entity"."primary_definition"
             <> EXCLUDED."primary_definition"
       RETURNING "entity_id"
     ), initialized_job AS (
       UPDATE "workspace_control"."knowledge_source_sync_job" current_job
       SET "updated_at" = now()
       FROM inserted_fragment
       WHERE current_job."id" = $2::uuid
         AND current_job."activation_graph_revision_id" = $12::uuid
         AND current_job."activation_parent_graph_revision_id" IS NOT DISTINCT FROM $13::uuid
         AND current_job."activation_generated_at" = $14::timestamptz
       RETURNING current_job."id"
     )
     SELECT (SELECT count(*)::int FROM inserted_fragment) AS "storedFragments",
       (SELECT count(*)::int FROM inserted_entities) AS "storedEntities",
       (SELECT count(*)::int FROM initialized_job) AS "initializedJobs"`,
    [
      job.organizationId,
      job.id,
      job.sourceId,
      fragmentCount,
      files[0]!.path,
      files.at(-1)!.path,
      files.length,
      JSON.stringify(entities),
      workerId,
      Number(health.parsedFiles),
      Number(health.skippedFiles),
      artifact.graphRevisionId,
      artifact.parentGraphRevisionId,
      artifact.generatedAt,
    ],
  );
  if (
    number(stored[0]?.storedFragments) !== 1
    || number(stored[0]?.storedEntities) !== entities.length
    || number(stored[0]?.initializedJobs) !== 1
  ) throw new CodeIndexFailure("code_index_lease_lost", true);
}

async function activateStagedKnowledgeGraph(
  query: KnowledgeSqlQuery,
  job: CodeIndexJob,
  workerId: string,
) {
  if (!job.activationGraphRevisionId && job.totalFiles > 0) {
    throw new CodeIndexFailure("stored_code_index_invalid", false);
  }
  const changedFiles = job.changedFiles.length > 0 || job.parentGraphRevisionId !== null
    ? [...new Set(job.changedFiles)].sort()
    : validStoredManifest(job.manifest) ? job.manifest.map((file) => file.path) : [];
  const rows = await query(
    `WITH locked_job AS MATERIALIZED (
       SELECT current_job.*
       FROM "workspace_control"."knowledge_source_sync_job" current_job
       WHERE current_job."organization_id" = $1
         AND current_job."source_id" = $2::uuid
         AND current_job."id" = $3::uuid
         AND current_job."desired_commit_sha" = $4
         AND current_job."source_sync_revision" = $5::bigint
         AND current_job."source_revision_sha256" = $6
         AND current_job."state" = 'claimed'
         AND current_job."phase" = 'activating'
         AND current_job."worker_id" = $7
         AND current_job."lease_expires_at" > now()
       FOR UPDATE OF current_job
     ), locked_environment AS MATERIALIZED (
       UPDATE "workspace_control"."knowledge_project_environment" environment
       SET "updated_at" = environment."updated_at"
       FROM locked_job
       WHERE environment."organization_id" = $1
         AND environment."id" = $9::uuid
         AND environment."project_id" = $8::uuid
         AND environment."revision" = $10::bigint
       RETURNING environment."id"
     ), eligible_source AS MATERIALIZED (
       SELECT source.*
       FROM "workspace_control"."knowledge_source" source
       CROSS JOIN locked_job
       CROSS JOIN locked_environment
       WHERE source."organization_id" = $1
         AND source."id" = $2::uuid
         AND source."project_id" = $8::uuid
         AND source."project_environment_id" = $9::uuid
         AND source."environment_revision" = $10::bigint
         AND source."provider" = 'github'
         AND source."display_name" = $11
         AND source."visibility" = 'shared_graph'
         AND source."repository_id" = $12
         AND source."repository_full_name" = $13
         AND source."ref_name" = $14
         AND source."commit_sha" = $4
         AND source."sync_revision" = $5::bigint
         AND source."revoked_at" IS NULL
         AND source."sync_state" <> 'stale'
     ), fragment_health AS MATERIALIZED (
       SELECT count(*)::int AS fragment_count,
         COALESCE(sum(fragment."file_count"), 0)::int AS file_count,
         COALESCE(sum(fragment."parsed_files"), 0)::int AS parsed_files,
         COALESCE(sum(fragment."skipped_files"), 0)::int AS skipped_files,
         COALESCE(bool_and(fragment."batch_index" = fragment.expected_batch), true) AS continuous
       FROM (
         SELECT stored_fragment.*,
           row_number() OVER (ORDER BY stored_fragment."batch_index") - 1 AS expected_batch
         FROM "workspace_control"."knowledge_code_index_activation_fragment" stored_fragment
         CROSS JOIN locked_job
         WHERE stored_fragment."organization_id" = $1
           AND stored_fragment."job_id" = $3::uuid
           AND stored_fragment."source_id" = $2::uuid
       ) fragment
     ), entity_health AS MATERIALIZED (
       SELECT count(*) FILTER (WHERE entity."entity_kind" = 'node')::int AS nodes,
         count(*) FILTER (WHERE entity."entity_kind" = 'edge')::int AS edges,
         count(*) FILTER (WHERE entity."entity_kind" = 'evidence')::int AS evidence,
         count(*) FILTER (WHERE entity."entity_kind" = 'edge' AND (
           NOT EXISTS (
             SELECT 1 FROM "workspace_control"."knowledge_code_index_activation_entity" node
             WHERE node."job_id" = entity."job_id" AND node."entity_kind" = 'node'
               AND node."entity_id" = entity."payload" ->> 'from'
           ) OR NOT EXISTS (
             SELECT 1 FROM "workspace_control"."knowledge_code_index_activation_entity" node
             WHERE node."job_id" = entity."job_id" AND node."entity_kind" = 'node'
               AND node."entity_id" = entity."payload" ->> 'to'
           ) OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(entity."payload" -> 'evidenceIds')
               AS evidence_ref(evidence_id)
             WHERE NOT EXISTS (
               SELECT 1 FROM "workspace_control"."knowledge_code_index_activation_entity" evidence
               WHERE evidence."job_id" = entity."job_id" AND evidence."entity_kind" = 'evidence'
                 AND evidence."entity_id" = evidence_ref.evidence_id
             )
           )
         ))::int AS invalid_edges
       FROM "workspace_control"."knowledge_code_index_activation_entity" entity
       CROSS JOIN locked_job
       WHERE entity."organization_id" = $1
         AND entity."job_id" = $3::uuid
         AND entity."source_id" = $2::uuid
     ), valid_stage AS MATERIALIZED (
       SELECT locked_job.*, fragment_health.*, entity_health.*
       FROM locked_job CROSS JOIN fragment_health CROSS JOIN entity_health
       WHERE fragment_health.file_count = locked_job."total_files"
         AND fragment_health.continuous
         AND fragment_health.parsed_files + fragment_health.skipped_files = locked_job."total_files"
         AND entity_health.nodes <= 200000
         AND entity_health.edges <= 600000
         AND entity_health.evidence <= 600000
         AND entity_health.invalid_edges = 0
     ), canonical_sections AS MATERIALIZED (
       SELECT '[' || COALESCE(string_agg(entity."canonical_payload", ',' ORDER BY entity."entity_id")
           FILTER (WHERE entity."entity_kind" = 'node'), '') || ']' AS nodes,
         '[' || COALESCE(string_agg(entity."canonical_payload", ',' ORDER BY entity."entity_id")
           FILTER (WHERE entity."entity_kind" = 'edge'), '') || ']' AS edges,
         '[' || COALESCE(string_agg(entity."canonical_payload", ',' ORDER BY entity."entity_id")
           FILTER (WHERE entity."entity_kind" = 'evidence'), '') || ']' AS evidence
       FROM "workspace_control"."knowledge_code_index_activation_entity" entity
       CROSS JOIN valid_stage
       WHERE entity."organization_id" = $1
         AND entity."job_id" = $3::uuid
         AND entity."source_id" = $2::uuid
     ), assembled AS MATERIALIZED (
       SELECT valid_stage.*, canonical_sections.nodes AS canonical_nodes,
         canonical_sections.edges AS canonical_edges,
         canonical_sections.evidence AS canonical_evidence,
         jsonb_build_object(
           'schemaVersion', 1,
           'graphRevisionId', COALESCE(valid_stage."activation_graph_revision_id", $15::uuid),
           'environmentRevision', $10::bigint,
           'binding', jsonb_build_object(
             'sourceId', $2::uuid,
             'projectId', $8::uuid,
             'projectEnvironmentId', $9::uuid,
             'provider', 'github',
             'displayName', $11,
             'visibility', 'shared_graph',
             'revision', jsonb_build_object(
               'kind', 'github', 'repository_id', $12, 'repository', $13,
               'ref_name', $14, 'commit_sha', $4
             )
           ),
           'sourceRevisionSha256', $6,
           'parentGraphRevisionId', valid_stage."activation_parent_graph_revision_id",
           'extractor', jsonb_build_object(
             'id', 'dopedb.code-index', 'version', '1.0.0',
             'sourceSha256', encode(digest(
               convert_to('dopedb.code-index', 'UTF8') || decode('00', 'hex')
                 || convert_to('1.0.0', 'UTF8'),
               'sha256'
             ), 'hex')
           ),
           'generatedAt', $16::text,
           'health', jsonb_build_object(
             'complete', true, 'parsedFiles', valid_stage.parsed_files,
             'skippedFiles', valid_stage.skipped_files, 'failedFiles', 0
           ),
           'changedFiles', $17::text::jsonb,
           'nodes', COALESCE((
             SELECT jsonb_agg(entity."payload" ORDER BY entity."entity_id")
             FROM "workspace_control"."knowledge_code_index_activation_entity" entity
             WHERE entity."job_id" = $3::uuid AND entity."entity_kind" = 'node'
           ), '[]'::jsonb),
           'edges', COALESCE((
             SELECT jsonb_agg(entity."payload" ORDER BY entity."entity_id")
             FROM "workspace_control"."knowledge_code_index_activation_entity" entity
             WHERE entity."job_id" = $3::uuid AND entity."entity_kind" = 'edge'
           ), '[]'::jsonb),
           'evidence', COALESCE((
             SELECT jsonb_agg(entity."payload" ORDER BY entity."entity_id")
             FROM "workspace_control"."knowledge_code_index_activation_entity" entity
             WHERE entity."job_id" = $3::uuid AND entity."entity_kind" = 'evidence'
           ), '[]'::jsonb)
         ) AS artifact
       FROM valid_stage CROSS JOIN canonical_sections
     ), canonical AS MATERIALIZED (
       SELECT assembled.*,
         '{"binding":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'binding')
         || ',"changedFiles":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'changedFiles')
         || ',"edges":' || assembled.canonical_edges
         || ',"environmentRevision":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'environmentRevision')
         || ',"evidence":' || assembled.canonical_evidence
         || ',"extractor":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'extractor')
         || ',"generatedAt":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'generatedAt')
         || ',"graphRevisionId":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'graphRevisionId')
         || ',"health":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'health')
         || ',"nodes":' || assembled.canonical_nodes
         || ',"parentGraphRevisionId":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'parentGraphRevisionId')
         || ',"schemaVersion":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'schemaVersion')
         || ',"sourceRevisionSha256":' || "workspace_control"."knowledge_canonical_json"(assembled.artifact -> 'sourceRevisionSha256')
         || '}' AS canonical_artifact
       FROM assembled
     ), bounded AS MATERIALIZED (
       SELECT canonical.*,
         encode(digest(convert_to(canonical.canonical_artifact, 'UTF8'), 'sha256'), 'hex') AS artifact_sha256
       FROM canonical
       WHERE octet_length(convert_to(canonical.canonical_artifact, 'UTF8')) <= 125829120
     ), head_before AS MATERIALIZED (
       SELECT eligible_source.*, head."graph_revision_id" AS current_graph_revision_id,
         bounded.artifact, bounded.artifact_sha256,
         COALESCE(bounded."activation_graph_revision_id", $15::uuid) AS graph_revision_id,
         bounded."activation_parent_graph_revision_id" AS parent_graph_revision_id
       FROM eligible_source CROSS JOIN bounded
       LEFT JOIN "workspace_control"."knowledge_environment_head" head
         ON head."organization_id" = eligible_source."organization_id"
        AND head."project_environment_id" = eligible_source."project_environment_id"
        AND head."source_id" = eligible_source."id"
     ), parent_match AS MATERIALIZED (
       SELECT * FROM head_before
       WHERE current_graph_revision_id IS NOT DISTINCT FROM parent_graph_revision_id
          OR current_graph_revision_id = graph_revision_id
     ), inserted_revision AS (
       INSERT INTO "workspace_control"."knowledge_graph_revision" (
         "id", "organization_id", "source_id", "project_environment_id",
         "environment_revision", "parent_graph_revision_id", "source_revision_sha256",
         "artifact_sha256", "artifact", "generated_at"
       )
       SELECT graph_revision_id, $1, $2::uuid, $9::uuid, $10::bigint,
         parent_graph_revision_id, $6, artifact_sha256, artifact, $16::timestamptz
       FROM parent_match
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"
     ), stored_revision AS MATERIALIZED (
       SELECT inserted_revision."id" FROM inserted_revision
       UNION ALL
       SELECT revision."id"
       FROM "workspace_control"."knowledge_graph_revision" revision
       CROSS JOIN parent_match
       WHERE revision."organization_id" = $1
         AND revision."id" = parent_match.graph_revision_id
         AND revision."source_id" = $2::uuid
         AND revision."artifact_sha256" = parent_match.artifact_sha256
         AND NOT EXISTS (SELECT 1 FROM inserted_revision)
     ), stale_mappings AS (
       UPDATE "workspace_control"."knowledge_mapping_proposal" proposal
       SET "state" = 'stale', "decided_at" = now()
       FROM stored_revision
       WHERE proposal."organization_id" = $1
         AND proposal."project_environment_id" = $9::uuid
         AND proposal."graph_revision_id" <> stored_revision."id"
         AND proposal."state" IN ('proposed', 'approved')
         AND EXISTS (
           SELECT 1 FROM "workspace_control"."knowledge_graph_revision" previous
           WHERE previous."id" = proposal."graph_revision_id" AND previous."source_id" = $2::uuid
         )
       RETURNING proposal."id"
     ), activated_head AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_environment_head" (
         "organization_id", "project_environment_id", "source_id",
         "graph_revision_id", "environment_revision"
       )
       SELECT $1, $9::uuid, $2::uuid, stored_revision."id", $10::bigint
       FROM stored_revision
       ON CONFLICT ("project_environment_id", "source_id") DO UPDATE SET
         "graph_revision_id" = EXCLUDED."graph_revision_id",
         "environment_revision" = EXCLUDED."environment_revision",
         "activated_at" = now()
       RETURNING "graph_revision_id"
     ), ready_source AS (
       UPDATE "workspace_control"."knowledge_source" source
       SET "sync_state" = 'ready', "last_failure_code" = NULL, "updated_at" = now()
       FROM activated_head
       WHERE source."organization_id" = $1 AND source."id" = $2::uuid
       RETURNING source."id"
     ), consumed_events AS (
       UPDATE "workspace_control"."knowledge_source_event" event
       SET "state" = 'consumed', "consumed_at" = now()
       FROM activated_head
       WHERE event."organization_id" = $1 AND event."source_id" = $2::uuid
         AND event."state" = 'pending' AND event."after_commit_sha" = $4
       RETURNING event."id"
     ), completed_job AS (
       UPDATE "workspace_control"."knowledge_source_sync_job" current_job
       SET "state" = 'succeeded', "claimed_at" = NULL, "lease_expires_at" = NULL,
         "worker_id" = NULL, "failure_code" = NULL, "finished_at" = now(), "updated_at" = now()
       FROM activated_head
       WHERE current_job."organization_id" = $1 AND current_job."source_id" = $2::uuid
         AND current_job."id" = $3::uuid AND current_job."worker_id" = $7
       RETURNING current_job."id"
     )
     SELECT (SELECT "graph_revision_id"::text FROM activated_head) AS "graphRevisionId",
       (SELECT artifact_sha256 FROM bounded) AS "artifactSha256",
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM locked_job) THEN 'code_index_lease_lost'
         WHEN NOT EXISTS (SELECT 1 FROM locked_environment) THEN 'code_index_environment_stale'
         WHEN NOT EXISTS (SELECT 1 FROM eligible_source) THEN 'code_index_source_stale'
         WHEN NOT EXISTS (SELECT 1 FROM valid_stage) THEN 'stored_code_index_invalid'
         WHEN NOT EXISTS (SELECT 1 FROM bounded) THEN 'code_index_artifact_limit'
         WHEN NOT EXISTS (SELECT 1 FROM parent_match) THEN 'code_index_parent_stale'
         WHEN NOT EXISTS (SELECT 1 FROM stored_revision) THEN 'code_index_revision_conflict'
         WHEN NOT EXISTS (SELECT 1 FROM activated_head) THEN 'code_index_activation_stale'
         WHEN NOT EXISTS (SELECT 1 FROM completed_job) THEN 'code_index_completion_stale'
         ELSE NULL
       END AS "failureCode"`,
    [
      job.organizationId,
      job.sourceId,
      job.id,
      job.desiredCommitSha,
      job.sourceSyncRevision,
      job.sourceRevisionSha256,
      workerId,
      job.projectId,
      job.projectEnvironmentId,
      job.environmentRevision,
      job.displayName,
      job.repositoryId,
      job.repositoryFullName,
      job.refName,
      job.activationGraphRevisionId!,
      job.activationGeneratedAt!,
      JSON.stringify(changedFiles),
    ],
  );
  const graphRevisionId = rows[0]?.graphRevisionId;
  if (typeof graphRevisionId !== "string" || rows[0]?.failureCode !== null) {
    const failureCode = typeof rows[0]?.failureCode === "string"
      ? rows[0].failureCode
      : "code_index_activation_stale";
    throw new CodeIndexFailure(
      failureCode,
      !["stored_code_index_invalid", "code_index_artifact_limit"].includes(failureCode),
    );
  }
}

async function purgeOldCodeIndexState(query: KnowledgeSqlQuery, job: CodeIndexJob) {
  await query(
    `WITH old_jobs AS MATERIALIZED (
       SELECT old_job."id"
       FROM "workspace_control"."knowledge_source_sync_job" old_job
       WHERE old_job."organization_id" = $1
         AND old_job."source_id" = $2::uuid
         AND old_job."id" <> $3::uuid
         AND old_job."state" IN ('succeeded', 'failed', 'superseded')
     ), purged_fragments AS (
       DELETE FROM "workspace_control"."knowledge_code_index_activation_fragment" fragment
       USING old_jobs
       WHERE fragment."job_id" = old_jobs."id"
       RETURNING fragment."job_id"
     ), purged_entities AS (
       DELETE FROM "workspace_control"."knowledge_code_index_activation_entity" entity
       USING old_jobs
       WHERE entity."job_id" = old_jobs."id"
       RETURNING entity."job_id"
     )
     DELETE FROM "workspace_control"."knowledge_code_index_file" file
     USING old_jobs
     WHERE file."job_id" = old_jobs."id"`,
    [job.organizationId, job.sourceId, job.id],
  );
}

function categoricalFailure(error: unknown) {
  return error instanceof CodeIndexFailure
    ? error
    : new CodeIndexFailure("code_index_internal", true);
}

function phaseHasStartBudget(phase: CodeIndexPhase, deadline: number) {
  return codeIndexPhaseHasStartBudget(phase, deadline - Date.now());
}

export async function processCodeIndexQueue(input: {
  maxSteps?: number;
  deadlineMs?: number;
  query?: KnowledgeSqlQuery;
} = {}) {
  const maxSteps = Math.min(Math.max(input.maxSteps ?? 3, 1), 10);
  const deadline = Date.now() + Math.min(Math.max(input.deadlineMs ?? 45_000, 1_000), 50_000);
  const query = input.query ?? productionDeadlineQuery(deadline, 20_000);
  const activationQuery = input.query
    ?? productionActivationDeadlineQuery(deadline, 20_000);
  const cleanupQuery = input.query ?? productionQuery(4_000);
  const workerId = randomUUID();
  let completed = 0;
  let advanced = 0;
  let failed = 0;
  let yielded = 0;
  for (let step = 0; step < maxSteps && Date.now() < deadline; step += 1) {
    const job = await claimCodeIndexJob(query, workerId);
    if (!job) break;
    if (!phaseHasStartBudget(job.phase, deadline)) {
      await transitionJob(
        cleanupQuery,
        job,
        workerId,
        job.phase,
        job.totalFiles,
        job.processedFiles,
      );
      yielded += 1;
      break;
    }
    try {
      if (job.phase === "manifest") await manifestPhase(query, job, workerId);
      else if (job.phase === "indexing") await indexingPhase(query, job, workerId);
      else {
        const result = await activatingPhase(query, job, workerId, { deadline, activationQuery });
        if (result === "completed") completed += 1;
        else advanced += 1;
        continue;
      }
      advanced += 1;
    } catch (error) {
      await failCodeIndexJob(cleanupQuery, job, workerId, categoricalFailure(error));
      failed += 1;
    }
  }
  return { completed, advanced, failed, yielded };
}
