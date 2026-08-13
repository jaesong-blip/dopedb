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
       ON CONFLICT ("organization_id", "name") DO NOTHING
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
