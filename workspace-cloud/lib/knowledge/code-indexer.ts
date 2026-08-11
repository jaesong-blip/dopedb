import "server-only";

import { randomUUID } from "node:crypto";

import { neonSql } from "../db";
import {
  analyzeCodeFile,
  buildCodeIndexArtifact,
  codeLanguageForPath,
  MAX_CODE_INDEX_ENTITIES,
  MAX_CODE_INDEX_FILE_BYTES,
  MAX_CODE_INDEX_FILES,
  validateCodeFileAnalysis,
  type CodeFileAnalysis,
  type CodeIndexArtifactFile,
} from "./code-index-core";
import {
  githubSourceManifest,
  readGithubBlobs,
} from "./github-app";
import {
  activateKnowledgeGraph,
  type KnowledgeSqlQuery,
} from "./graph-activation-core";

const LEASE_SECONDS = 120;
const MAX_FAILURES = 5;
// Thirty-two one-megabyte-or-smaller files, fetched with bounded concurrency,
// leave room inside the 60-second Vercel route even when GitHub reaches its
// per-request timeout. The durable lease resumes at the next path on the next run.
const FILE_BATCH_SIZE = 32;
const MANIFEST_INSERT_BATCH_SIZE = 1_000;

type CodeIndexPhase = "manifest" | "indexing" | "activating";

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

function productionQuery(): KnowledgeSqlQuery {
  return async (statement, parameters) => await neonSql.query(
    statement,
    [...parameters],
  ) as Record<string, unknown>[];
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
    && !/[\u0000-\u001f\u007f]/.test(path)
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
  if (
    typeof row.id !== "string"
    || typeof row.organizationId !== "string"
    || typeof row.sourceId !== "string"
    || typeof row.desiredCommitSha !== "string"
    || !/^[0-9a-f]{40}$/.test(row.desiredCommitSha)
    || sourceSyncRevision === null
    || sourceSyncRevision < 1
    || !["manifest", "indexing", "activating"].includes(String(row.phase))
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
  ) {
    throw new CodeIndexFailure("code_index_job_invalid", false);
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    sourceId: row.sourceId,
    desiredCommitSha: row.desiredCommitSha,
    sourceSyncRevision,
    phase: row.phase as CodeIndexPhase,
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
  let manifest;
  try {
    manifest = await githubSourceManifest(
      job.installationId,
      job.repositoryFullName,
      job.desiredCommitSha,
    );
  } catch {
    throw new CodeIndexFailure("github_manifest_unavailable", true);
  }
  if (manifest.length > MAX_CODE_INDEX_FILES) {
    throw new CodeIndexFailure("code_index_file_limit", false);
  }
  const values = manifest.map((file) => {
    const language = codeLanguageForPath(file.path) ?? "unsupported";
    const skipped = language === "unsupported" || file.bytes > MAX_CODE_INDEX_FILE_BYTES;
    return {
      ...file,
      language,
      initialState: skipped ? "skipped" as const : "pending" as const,
      failureCode: skipped ? "file_not_indexed" : null,
    };
  });
  for (let offset = 0; offset < values.length; offset += MANIFEST_INSERT_BATCH_SIZE) {
    await insertCodeIndexManifestBatch(
      query,
      job,
      workerId,
      values.slice(offset, offset + MANIFEST_INSERT_BATCH_SIZE),
    );
  }
  const counts = await query(
    `SELECT count(*)::int AS "totalFiles",
       count(*) FILTER (WHERE "state" <> 'pending')::int AS "processedFiles"
     FROM "workspace_control"."knowledge_code_index_file"
     WHERE "organization_id" = $1
       AND "job_id" = $2::uuid
       AND "source_id" = $3::uuid`,
    [job.organizationId, job.id, job.sourceId],
  );
  const totalFiles = number(counts[0]?.totalFiles) ?? 0;
  const processedFiles = number(counts[0]?.processedFiles) ?? 0;
  await transitionJob(
    query,
    job,
    workerId,
    processedFiles === totalFiles ? "activating" : "indexing",
    totalFiles,
    processedFiles,
  );
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
     ORDER BY file."path"
     LIMIT $5`,
    [job.organizationId, job.id, job.sourceId, workerId, FILE_BATCH_SIZE],
  );
  if (pending.length === 0) {
    const counts = await query(
      `SELECT count(*)::int AS "totalFiles",
         count(*) FILTER (WHERE "state" <> 'pending')::int AS "processedFiles"
       FROM "workspace_control"."knowledge_code_index_file"
       WHERE "organization_id" = $1 AND "job_id" = $2::uuid`,
      [job.organizationId, job.id],
    );
    await transitionJob(
      query,
      job,
      workerId,
      "activating",
      number(counts[0]?.totalFiles) ?? 0,
      number(counts[0]?.processedFiles) ?? 0,
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
  const counts = await query(
    `SELECT count(*)::int AS "totalFiles",
       count(*) FILTER (WHERE "state" <> 'pending')::int AS "processedFiles",
       count(*) FILTER (WHERE "state" = 'pending')::int AS "pendingFiles",
       (count(*) + COALESCE(sum(
         CASE WHEN "state" = 'ready' THEN
           jsonb_array_length("analysis" -> 'symbols')
           + jsonb_array_length("analysis" -> 'references')
         ELSE 0 END
       ), 0))::bigint AS "entityCount"
     FROM "workspace_control"."knowledge_code_index_file"
     WHERE "organization_id" = $1 AND "job_id" = $2::uuid`,
    [job.organizationId, job.id],
  );
  const totalFiles = number(counts[0]?.totalFiles) ?? 0;
  const processedFiles = number(counts[0]?.processedFiles) ?? 0;
  const pendingFiles = number(counts[0]?.pendingFiles) ?? 0;
  const entityCount = number(counts[0]?.entityCount);
  if (entityCount === null || entityCount > MAX_CODE_INDEX_ENTITIES) {
    throw new CodeIndexFailure("code_index_entity_limit", false);
  }
  await transitionJob(
    query,
    job,
    workerId,
    pendingFiles === 0 ? "activating" : "indexing",
    totalFiles,
    processedFiles,
  );
}

async function activatingPhase(query: KnowledgeSqlQuery, job: CodeIndexJob, workerId: string) {
  const rows = await query(
    `SELECT file."path", file."blob_sha" AS "blobSha", file."bytes",
       file."language", file."state", file."analysis"
     FROM "workspace_control"."knowledge_code_index_file" file
     WHERE file."organization_id" = $1
       AND file."job_id" = $2::uuid
       AND file."source_id" = $3::uuid
       AND file."state" IN ('ready', 'skipped')
     ORDER BY file."path"`,
    [job.organizationId, job.id, job.sourceId],
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
  if (files.length !== job.totalFiles || job.processedFiles !== job.totalFiles) {
    throw new CodeIndexFailure("stored_code_index_incomplete", false);
  }
  let artifact;
  try {
    artifact = buildCodeIndexArtifact({
      sourceId: job.sourceId,
      projectId: job.projectId,
      projectEnvironmentId: job.projectEnvironmentId,
      environmentRevision: job.environmentRevision,
      displayName: job.displayName,
      repositoryId: job.repositoryId,
      repository: job.repositoryFullName,
      refName: job.refName,
      commitSha: job.desiredCommitSha,
      parentGraphRevisionId: job.parentGraphRevisionId,
      changedFiles: job.changedFiles,
      generatedAt: new Date().toISOString(),
      files,
    });
  } catch {
    throw new CodeIndexFailure("code_index_artifact_invalid", false);
  }
  const activated = await activateKnowledgeGraph({
    query,
    organizationId: job.organizationId,
    sourceId: job.sourceId,
    artifact,
    jobId: job.id,
    workerId,
  });
  if (!activated) throw new CodeIndexFailure("code_index_activation_stale", true);
  await query(
    `DELETE FROM "workspace_control"."knowledge_code_index_file" file
     USING "workspace_control"."knowledge_source_sync_job" old_job
     WHERE file."job_id" = old_job."id"
       AND file."organization_id" = $1
       AND file."source_id" = $2::uuid
       AND file."job_id" <> $3::uuid
       AND old_job."state" IN ('succeeded', 'failed', 'superseded')`,
    [job.organizationId, job.sourceId, job.id],
  );
}

function categoricalFailure(error: unknown) {
  return error instanceof CodeIndexFailure
    ? error
    : new CodeIndexFailure("code_index_internal", true);
}

export async function processCodeIndexQueue(input: {
  maxSteps?: number;
  deadlineMs?: number;
  query?: KnowledgeSqlQuery;
} = {}) {
  const query = input.query ?? productionQuery();
  const maxSteps = Math.min(Math.max(input.maxSteps ?? 3, 1), 10);
  const deadline = Date.now() + Math.min(Math.max(input.deadlineMs ?? 45_000, 1_000), 50_000);
  const workerId = randomUUID();
  let completed = 0;
  let advanced = 0;
  let failed = 0;
  for (let step = 0; step < maxSteps && Date.now() < deadline; step += 1) {
    const job = await claimCodeIndexJob(query, workerId);
    if (!job) break;
    try {
      if (job.phase === "manifest") await manifestPhase(query, job, workerId);
      else if (job.phase === "indexing") await indexingPhase(query, job, workerId);
      else await activatingPhase(query, job, workerId);
      if (job.phase === "activating") completed += 1;
      else advanced += 1;
    } catch (error) {
      await failCodeIndexJob(query, job, workerId, categoricalFailure(error));
      failed += 1;
    }
  }
  return { completed, advanced, failed };
}
