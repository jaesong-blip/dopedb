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

import {
  FILE_BATCH_SIZE,
  CodeIndexFailure,
  MANIFEST_INSERT_BATCH_SIZE,
  insertCodeIndexManifestBatch,
  number,
  readCodeIndexProgress,
  requireEntityBudget,
  transitionJob,
  validStoredManifest,
  type CodeIndexJob,
} from "./code-index-store";

export async function manifestPhase(query: KnowledgeSqlQuery, job: CodeIndexJob, workerId: string) {
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

export async function initializeActivation(
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

export async function indexingPhase(query: KnowledgeSqlQuery, job: CodeIndexJob, workerId: string) {
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
