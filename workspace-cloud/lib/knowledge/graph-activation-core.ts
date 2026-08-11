import {
  validateGraphBuildArtifact,
  type ValidGraphArtifact,
} from "./artifact-core";

export type KnowledgeSqlQuery = (
  text: string,
  parameters: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export type KnowledgeGraphActivation = {
  graphRevisionId: string;
  artifactSha256: string;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function activationIdentity(artifact: ValidGraphArtifact) {
  const binding = artifact.binding as JsonRecord;
  const revision = record(binding.revision) ? binding.revision : {};
  return {
    displayName: optionalString(binding.displayName),
    visibility: optionalString(binding.visibility),
    repositoryId: optionalString(revision.repository_id),
    repository: optionalString(revision.repository),
    refName: optionalString(revision.ref_name),
    commitSha: optionalString(revision.commit_sha),
  };
}

/**
 * Activate one immutable graph with a source/environment/parent CAS in a single
 * PostgreSQL statement. The Vercel code indexer is the sole publisher, so a
 * stale build cannot compete with a Desktop-generated revision.
 */
export async function activateKnowledgeGraph(input: {
  query: KnowledgeSqlQuery;
  organizationId: string;
  sourceId: string;
  artifact: unknown;
  jobId: string;
  workerId: string;
}): Promise<KnowledgeGraphActivation | null> {
  const validated = validateGraphBuildArtifact(input.artifact);
  if (!validated) return null;
  const { artifact, artifactSha256 } = validated;
  const identity = activationIdentity(artifact);
  const rows = await input.query(
    `WITH locked_environment AS MATERIALIZED (
       UPDATE "workspace_control"."knowledge_project_environment" environment
       SET "updated_at" = environment."updated_at"
       WHERE environment."organization_id" = $1
         AND environment."id" = $4::uuid
         AND environment."project_id" = $3::uuid
         AND environment."revision" = $5::bigint
       RETURNING environment."id"
     ), eligible_source AS MATERIALIZED (
       SELECT source.*
       FROM "workspace_control"."knowledge_source" source
       CROSS JOIN locked_environment
       WHERE source."organization_id" = $1
         AND source."id" = $2::uuid
         AND source."project_id" = $3::uuid
         AND source."project_environment_id" = $4::uuid
         AND source."environment_revision" = $5::bigint
         AND source."provider" = $6
         AND source."display_name" = $7
         AND source."visibility" = $8
         AND source."revoked_at" IS NULL
         AND source."sync_state" <> 'stale'
         AND $6 = 'github'
         AND source."repository_id" = $9
         AND source."repository_full_name" = $10
         AND source."ref_name" = $11
         AND source."commit_sha" = $12
         AND EXISTS (
           SELECT 1
           FROM "workspace_control"."knowledge_source_sync_job" job
           WHERE job."organization_id" = source."organization_id"
             AND job."source_id" = source."id"
             AND job."id" = $19::uuid
             AND job."desired_commit_sha" = source."commit_sha"
             AND job."source_sync_revision" = source."sync_revision"
             AND job."state" = 'claimed'
             AND job."worker_id" = $20
             AND job."lease_expires_at" > now()
         )
     ), head_before AS MATERIALIZED (
       SELECT source.*, head."graph_revision_id" AS "current_graph_revision_id"
       FROM eligible_source source
       LEFT JOIN "workspace_control"."knowledge_environment_head" head
         ON head."organization_id" = source."organization_id"
        AND head."project_environment_id" = source."project_environment_id"
        AND head."source_id" = source."id"
     ), parent_match AS MATERIALIZED (
       SELECT * FROM head_before
       WHERE "current_graph_revision_id" IS NOT DISTINCT FROM $14::uuid
          OR "current_graph_revision_id" = $13::uuid
     ), inserted_revision AS (
       INSERT INTO "workspace_control"."knowledge_graph_revision" (
         "id", "organization_id", "source_id", "project_environment_id",
         "environment_revision", "parent_graph_revision_id",
         "source_revision_sha256", "artifact_sha256", "artifact", "generated_at"
       )
       SELECT $13::uuid, $1, $2::uuid, $4::uuid, $5::bigint, $14::uuid,
         $15, $16, $17::text::jsonb, $18::timestamptz
       FROM parent_match
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"
     ), stored_revision AS MATERIALIZED (
       SELECT inserted_revision."id"
       FROM inserted_revision
       UNION ALL
       SELECT revision."id"
       FROM "workspace_control"."knowledge_graph_revision" revision
       CROSS JOIN parent_match
       WHERE revision."organization_id" = $1
         AND revision."id" = $13::uuid
         AND revision."source_id" = $2::uuid
         AND revision."project_environment_id" = $4::uuid
         AND revision."environment_revision" = $5::bigint
         AND revision."parent_graph_revision_id" IS NOT DISTINCT FROM $14::uuid
         AND revision."source_revision_sha256" = $15
         AND revision."artifact_sha256" = $16
         AND NOT EXISTS (SELECT 1 FROM inserted_revision)
     ), stale_mappings AS (
       UPDATE "workspace_control"."knowledge_mapping_proposal" proposal
       SET "state" = 'stale', "decided_at" = now()
       FROM stored_revision
       WHERE proposal."organization_id" = $1
         AND proposal."project_environment_id" = $4::uuid
         AND proposal."graph_revision_id" <> $13::uuid
         AND proposal."state" IN ('proposed', 'approved')
         AND EXISTS (
           SELECT 1
           FROM "workspace_control"."knowledge_graph_revision" previous
           WHERE previous."id" = proposal."graph_revision_id"
             AND previous."source_id" = $2::uuid
         )
       RETURNING proposal."id"
     ), activated_head AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_environment_head" (
         "organization_id", "project_environment_id", "source_id",
         "graph_revision_id", "environment_revision"
       )
       SELECT $1, $4::uuid, $2::uuid, stored_revision."id", $5::bigint
       FROM stored_revision
       ON CONFLICT ("project_environment_id", "source_id") DO UPDATE SET
         "graph_revision_id" = EXCLUDED."graph_revision_id",
         "environment_revision" = EXCLUDED."environment_revision",
         "activated_at" = now()
       RETURNING "graph_revision_id"
     ), ready_source AS (
       UPDATE "workspace_control"."knowledge_source" source
       SET "sync_state" = 'ready',
         "last_failure_code" = NULL,
         "updated_at" = now()
       FROM activated_head
       WHERE source."organization_id" = $1
         AND source."id" = $2::uuid
       RETURNING source."id"
     ), consumed_events AS (
       UPDATE "workspace_control"."knowledge_source_event" event
       SET "state" = 'consumed', "consumed_at" = now()
       FROM activated_head
       WHERE event."organization_id" = $1
         AND event."source_id" = $2::uuid
         AND event."state" = 'pending'
         AND event."after_commit_sha" = $12
       RETURNING event."id"
     ), completed_job AS (
       UPDATE "workspace_control"."knowledge_source_sync_job" job
       SET "state" = 'succeeded',
         "claimed_at" = NULL,
         "lease_expires_at" = NULL,
         "worker_id" = NULL,
         "failure_code" = NULL,
         "finished_at" = now(),
         "updated_at" = now()
       FROM activated_head
       WHERE job."organization_id" = $1
         AND job."source_id" = $2::uuid
         AND job."id" = $19::uuid
         AND job."worker_id" = $20
       RETURNING job."id"
     ), superseded_jobs AS (
       UPDATE "workspace_control"."knowledge_source_sync_job" job
       SET "state" = 'superseded',
         "claimed_at" = NULL,
         "lease_expires_at" = NULL,
         "worker_id" = NULL,
         "finished_at" = now(),
         "updated_at" = now()
       FROM activated_head
       WHERE job."organization_id" = $1
         AND job."source_id" = $2::uuid
         AND job."desired_commit_sha" <> $12
         AND job."state" IN ('queued', 'claimed')
       RETURNING job."id"
     )
     SELECT activated_head."graph_revision_id"::text AS "graphRevisionId"
     FROM activated_head`,
    [
      input.organizationId,
      input.sourceId,
      artifact.binding.projectId,
      artifact.binding.projectEnvironmentId,
      artifact.environmentRevision,
      artifact.binding.provider,
      identity.displayName,
      identity.visibility,
      identity.repositoryId,
      identity.repository,
      identity.refName,
      identity.commitSha,
      artifact.graphRevisionId,
      artifact.parentGraphRevisionId,
      artifact.sourceRevisionSha256,
      artifactSha256,
      JSON.stringify(artifact),
      artifact.generatedAt,
      input.jobId,
      input.workerId,
    ],
  );
  const graphRevisionId = rows[0]?.graphRevisionId;
  return typeof graphRevisionId === "string"
    ? { graphRevisionId, artifactSha256 }
    : null;
}
