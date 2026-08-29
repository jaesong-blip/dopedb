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
  ACTIVATION_FRAGMENT_ENTITY_BATCH_SIZE,
  ACTIVATION_FRAGMENT_FILE_BATCH_SIZE,
  ACTIVATION_FRAGMENT_INPUT_BYTES,
  CodeIndexFailure,
  number,
  readCodeIndexProgress,
  requireEntityBudget,
  transitionJob,
  validStoredManifest,
  type ActivationPhaseResult,
  type CodeIndexJob,
  type QueueExecutionContext,
} from "./code-index-store";
import { initializeActivation } from "./code-index-indexing";

export async function activatingPhase(
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

export async function prepareActivationFragment(
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

export async function activateStagedKnowledgeGraph(
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

export async function purgeOldCodeIndexState(query: KnowledgeSqlQuery, job: CodeIndexJob) {
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
