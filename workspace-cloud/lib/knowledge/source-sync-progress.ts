import "server-only";

import { sql } from "drizzle-orm";

import { db } from "../db";

export type KnowledgeSyncProgressRow = {
  sourceId: string;
  projectEnvironmentId: string;
  displayName: string;
  projectName: string;
  environmentName: string;
  phase: "manifest" | "indexing" | "activating";
  state: "queued" | "claimed";
  totalFiles: number;
  completedFiles: number;
  attempt: number;
  startedAt: Date;
  updatedAt: Date;
  retryAt: Date | null;
};

export const MAX_ACTIVE_SYNC_PROGRESS_ROWS = 512;

export async function listKnowledgeSyncProgress(workspaceId: string) {
  const result = await db.execute<KnowledgeSyncProgressRow>(sql`
    SELECT source."id"::text AS "sourceId",
      source."project_environment_id"::text AS "projectEnvironmentId",
      source."display_name" AS "displayName",
      project."name" AS "projectName",
      environment."name" AS "environmentName",
      job."phase",
      job."state",
      job."total_files"::integer AS "totalFiles",
      LEAST(job."total_files", GREATEST(0, CASE job."phase"
        WHEN 'manifest' THEN COALESCE(manifest_progress."completed", 0)
        WHEN 'indexing' THEN job."processed_files"
        WHEN 'activating' THEN COALESCE(activation_progress."completed", 0)
      END))::integer AS "completedFiles",
      job."attempt"::integer AS "attempt",
      job."created_at" AS "startedAt",
      job."updated_at" AS "updatedAt",
      CASE
        WHEN job."state" = 'queued' AND job."failure_code" IS NOT NULL
          THEN job."available_at"
        ELSE NULL
      END AS "retryAt"
    FROM "workspace_control"."knowledge_source_sync_job" job
    JOIN "workspace_control"."knowledge_source" source
      ON source."organization_id" = job."organization_id"
     AND source."id" = job."source_id"
     AND source."commit_sha" = job."desired_commit_sha"
     AND source."sync_revision" = job."source_sync_revision"
     AND source."sync_state" IN ('pending', 'syncing')
     AND source."revoked_at" IS NULL
    JOIN "workspace_control"."knowledge_project" project
      ON project."organization_id" = source."organization_id"
     AND project."id" = source."project_id"
    JOIN "workspace_control"."knowledge_project_environment" environment
      ON environment."organization_id" = source."organization_id"
     AND environment."project_id" = source."project_id"
     AND environment."id" = source."project_environment_id"
     AND environment."revision" = source."environment_revision"
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS "completed"
      FROM "workspace_control"."knowledge_code_index_file" file
      WHERE job."phase" = 'manifest'
        AND file."organization_id" = job."organization_id"
        AND file."job_id" = job."id"
        AND file."source_id" = job."source_id"
    ) manifest_progress ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(fragment."file_count"), 0)::integer AS "completed"
      FROM "workspace_control"."knowledge_code_index_activation_fragment" fragment
      WHERE job."phase" = 'activating'
        AND fragment."organization_id" = job."organization_id"
        AND fragment."job_id" = job."id"
        AND fragment."source_id" = job."source_id"
    ) activation_progress ON true
    WHERE job."organization_id" = ${workspaceId}
      AND job."state" IN ('queued', 'claimed')
    ORDER BY job."updated_at" DESC, job."id"
    LIMIT ${MAX_ACTIVE_SYNC_PROGRESS_ROWS + 1}
  `);
  return result.rows;
}
