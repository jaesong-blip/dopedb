// Project and Environment mutations use one PostgreSQL statement because the
// Neon HTTP Drizzle driver cannot execute callback transactions.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "../db";
import {
  knowledgeMutationAuthoritySql,
  type KnowledgeMutationAuthority,
} from "./mutation-authority";

export const KNOWLEDGE_RISK_CLASSES = [
  "production",
  "staging",
  "development",
  "test",
  "custom",
] as const;

export type KnowledgeRiskClass = (typeof KNOWLEDGE_RISK_CLASSES)[number];

export type StoredKnowledgeProject = {
  id: string;
  name: string;
  revision: number;
  environments: Array<{
    id: string;
    name: string;
    riskClass: KnowledgeRiskClass;
    revision: number;
  }>;
};

type ProjectRow = {
  projectId: string;
  projectName: string;
  projectRevision: string | number;
  environmentId: string;
  environmentName: string;
  riskClass: KnowledgeRiskClass;
  environmentRevision: string | number;
};

type DeleteProjectRow = {
  matched: boolean;
  blockedByActiveAnalyses: boolean;
  deleted: boolean;
};

export type DeleteKnowledgeProjectOutcome =
  | "deleted"
  | "active_analyses"
  | "stale";

function positiveRevision(value: string | number, field: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`Project Knowledge returned an invalid ${field}`);
  }
  return revision;
}

function projectFromRows(rows: ProjectRow[]): StoredKnowledgeProject | null {
  const first = rows[0];
  if (!first) return null;
  if (
    rows.some(
      (row) =>
        row.projectId !== first.projectId ||
        row.projectName !== first.projectName ||
        !KNOWLEDGE_RISK_CLASSES.includes(row.riskClass),
    )
  ) {
    throw new Error("Project Knowledge crossed a Project identity");
  }
  return {
    id: first.projectId,
    name: first.projectName,
    revision: positiveRevision(first.projectRevision, "Project revision"),
    environments: rows.map((row) => ({
      id: row.environmentId,
      name: row.environmentName,
      riskClass: row.riskClass,
      revision: positiveRevision(row.environmentRevision, "Environment revision"),
    })),
  };
}

export async function insertKnowledgeProject(input: {
  organizationId: string;
  name: string;
  environments: Array<{ name: string; riskClass: KnowledgeRiskClass }>;
  authority: KnowledgeMutationAuthority;
}): Promise<StoredKnowledgeProject | null> {
  const result = await db.execute<ProjectRow>(sql`
     WITH actor_authority AS MATERIALIZED (
       SELECT 1 WHERE ${knowledgeMutationAuthoritySql(input.authority, input.organizationId)}
     ), requested_environment AS MATERIALIZED (
       SELECT requested."name", requested."riskClass"
       FROM jsonb_to_recordset(${JSON.stringify(input.environments)}::jsonb)
         AS requested("name" text, "riskClass" text)
     ), inserted_project AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_project"
         ("organization_id", "name")
       SELECT ${input.organizationId}, ${input.name}
       FROM actor_authority
       ON CONFLICT ("organization_id", "name") WHERE "deleted_at" IS NULL
       DO NOTHING
       RETURNING "id", "name", "revision"
     ), inserted_environment AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_project_environment"
         ("organization_id", "project_id", "name", "production", "risk_class")
       SELECT ${input.organizationId}, project."id", environment."name",
         environment."riskClass" = 'production', environment."riskClass"
       FROM inserted_project project
       CROSS JOIN requested_environment environment
       RETURNING "id", "project_id", "name", "risk_class", "revision"
     )
     SELECT project."id"::text AS "projectId",
       project."name" AS "projectName",
       project."revision"::text AS "projectRevision",
       environment."id"::text AS "environmentId",
       environment."name" AS "environmentName",
       environment."risk_class" AS "riskClass",
       environment."revision"::text AS "environmentRevision"
     FROM inserted_project project
     JOIN inserted_environment environment
       ON environment."project_id" = project."id"
     ORDER BY environment."name", environment."id"
  `);
  return projectFromRows(result.rows);
}

export async function appendKnowledgeEnvironment(input: {
  organizationId: string;
  projectId: string;
  expectedProjectRevision: number;
  name: string;
  riskClass: KnowledgeRiskClass;
  authority: KnowledgeMutationAuthority;
}): Promise<StoredKnowledgeProject | null> {
  const result = await db.execute<ProjectRow>(sql`
     WITH actor_authority AS MATERIALIZED (
       SELECT 1 WHERE ${knowledgeMutationAuthoritySql(input.authority, input.organizationId)}
     ), eligible_project AS MATERIALIZED (
       SELECT project."id", project."name", project."revision"
       FROM "workspace_control"."knowledge_project" project
       CROSS JOIN actor_authority
       WHERE project."organization_id" = ${input.organizationId}
         AND project."id" = ${input.projectId}::uuid
         AND project."revision" = ${input.expectedProjectRevision}::bigint
         AND project."deleted_at" IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM "workspace_control"."knowledge_project_environment" environment
           WHERE environment."project_id" = project."id"
             AND environment."name" = ${input.name}
         )
       FOR UPDATE
     ), updated_project AS MATERIALIZED (
       UPDATE "workspace_control"."knowledge_project" project
       SET "revision" = eligible."revision" + 1,
         "updated_at" = now()
       FROM eligible_project eligible
       WHERE project."id" = eligible."id"
       RETURNING project."id", project."name", project."revision"
     ), inserted_environment AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_project_environment"
         ("organization_id", "project_id", "name", "production", "risk_class")
       SELECT ${input.organizationId}, project."id", ${input.name},
         ${input.riskClass} = 'production', ${input.riskClass}
       FROM updated_project project
       RETURNING "id", "project_id", "name", "risk_class", "revision"
     ), projected_environment AS (
       SELECT environment."id", environment."project_id", environment."name",
         environment."risk_class", environment."revision"
       FROM "workspace_control"."knowledge_project_environment" environment
       JOIN updated_project project ON project."id" = environment."project_id"
       UNION ALL
       SELECT environment."id", environment."project_id", environment."name",
         environment."risk_class", environment."revision"
       FROM inserted_environment environment
     )
     SELECT project."id"::text AS "projectId",
       project."name" AS "projectName",
       project."revision"::text AS "projectRevision",
       environment."id"::text AS "environmentId",
       environment."name" AS "environmentName",
       environment."risk_class" AS "riskClass",
       environment."revision"::text AS "environmentRevision"
     FROM updated_project project
     JOIN projected_environment environment
       ON environment."project_id" = project."id"
     ORDER BY environment."name", environment."id"
  `);
  return projectFromRows(result.rows);
}

/**
 * Tombstone one Project and atomically revoke every live authority derived
 * from it. Database connection profiles are workspace resources, so only their
 * Project bindings are revoked. Analysis Articles must be removed explicitly;
 * their version history and immutable publications are never cascaded here.
 */
export async function deleteKnowledgeProject(input: {
  organizationId: string;
  projectId: string;
  expectedRevision: number;
  authority: KnowledgeMutationAuthority;
}): Promise<DeleteKnowledgeProjectOutcome> {
  const requestId = crypto.randomUUID();
  const result = await db.execute<DeleteProjectRow>(sql`
    WITH actor_authority AS MATERIALIZED (
      SELECT 1 WHERE ${knowledgeMutationAuthoritySql(input.authority, input.organizationId)}
    ), eligible_project AS MATERIALIZED (
      SELECT project."id", project."revision"
      FROM "workspace_control"."knowledge_project" project
      CROSS JOIN actor_authority
      WHERE project."organization_id" = ${input.organizationId}
        AND project."id" = ${input.projectId}::uuid
        AND project."revision" = ${input.expectedRevision}::bigint
        AND project."deleted_at" IS NULL
      FOR UPDATE OF project
    ), active_analysis AS MATERIALIZED (
      SELECT 1
      FROM "workspace_control"."workspace_analysis_article" article
      JOIN "workspace_control"."knowledge_project_environment" environment
        ON environment."organization_id" = article."organization_id"
       AND environment."id" = article."project_environment_id"
      JOIN eligible_project project ON project."id" = environment."project_id"
      WHERE article."organization_id" = ${input.organizationId}
        AND article."deleted_at" IS NULL
      LIMIT 1
    ), tombstoned_project AS MATERIALIZED (
      UPDATE "workspace_control"."knowledge_project" project
      SET "deleted_at" = now(),
        "revision" = project."revision" + 1,
        "updated_at" = now()
      FROM eligible_project eligible
      WHERE project."id" = eligible."id"
        AND NOT EXISTS (SELECT 1 FROM active_analysis)
      RETURNING project."id"
    ), project_environment AS MATERIALIZED (
      SELECT environment."id"
      FROM "workspace_control"."knowledge_project_environment" environment
      JOIN tombstoned_project project ON project."id" = environment."project_id"
      WHERE environment."organization_id" = ${input.organizationId}
    ), project_source AS MATERIALIZED (
      SELECT source."id"
      FROM "workspace_control"."knowledge_source" source
      JOIN tombstoned_project project ON project."id" = source."project_id"
      WHERE source."organization_id" = ${input.organizationId}
    ), revoked_bindings AS MATERIALIZED (
      UPDATE "workspace_control"."knowledge_environment_connection" binding
      SET "revoked_at" = now()
      FROM project_environment environment
      WHERE binding."organization_id" = ${input.organizationId}
        AND binding."project_environment_id" = environment."id"
        AND binding."revoked_at" IS NULL
      RETURNING binding."id"
    ), revoked_sources AS MATERIALIZED (
      UPDATE "workspace_control"."knowledge_source" source
      SET "sync_state" = 'revoked',
        "sync_revision" = source."sync_revision" + 1,
        "revoked_at" = now(),
        "updated_at" = now()
      FROM project_source requested
      WHERE source."organization_id" = ${input.organizationId}
        AND source."id" = requested."id"
        AND source."revoked_at" IS NULL
      RETURNING source."id"
    ), superseded_sync_jobs AS MATERIALIZED (
      UPDATE "workspace_control"."knowledge_source_sync_job" job
      SET "state" = 'superseded',
        "failure_code" = 'project_deleted',
        "worker_id" = NULL,
        "claimed_at" = NULL,
        "lease_expires_at" = NULL,
        "finished_at" = now(),
        "updated_at" = now()
      FROM project_source source
      WHERE job."organization_id" = ${input.organizationId}
        AND job."source_id" = source."id"
        AND job."state" IN ('queued', 'claimed')
      RETURNING job."id"
    ), failed_source_events AS MATERIALIZED (
      UPDATE "workspace_control"."knowledge_source_event" event
      SET "state" = 'failed', "consumed_at" = now()
      FROM project_source source
      WHERE event."organization_id" = ${input.organizationId}
        AND event."source_id" = source."id"
        AND event."state" IN ('pending', 'claimed')
      RETURNING event."id"
    ), revoked_grants AS MATERIALIZED (
      UPDATE "workspace_control"."knowledge_grant" issued_grant
      SET "revoked_at" = now()
      FROM tombstoned_project project
      WHERE issued_grant."organization_id" = ${input.organizationId}
        AND issued_grant."project_id" = project."id"
        AND issued_grant."revoked_at" IS NULL
      RETURNING issued_grant."id"
    ), audited AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        'knowledge.project.delete', 'knowledge_project', project."id"::text,
        jsonb_build_object(
          'bindingCount', (SELECT count(*) FROM revoked_bindings),
          'sourceCount', (SELECT count(*) FROM revoked_sources),
          'grantCount', (SELECT count(*) FROM revoked_grants),
          'syncJobCount', (SELECT count(*) FROM superseded_sync_jobs),
          'sourceEventCount', (SELECT count(*) FROM failed_source_events)
        ), ${requestId}::uuid
      FROM tombstoned_project project
      RETURNING "id"
    )
    SELECT EXISTS (SELECT 1 FROM eligible_project) AS "matched",
      EXISTS (SELECT 1 FROM active_analysis) AS "blockedByActiveAnalyses",
      EXISTS (
        SELECT 1 FROM tombstoned_project
        WHERE EXISTS (SELECT 1 FROM audited)
      ) AS "deleted"
  `);
  const outcome = result.rows[0];
  if (outcome?.deleted) return "deleted";
  if (outcome?.matched && outcome.blockedByActiveAnalyses) {
    return "active_analyses";
  }
  return "stale";
}
