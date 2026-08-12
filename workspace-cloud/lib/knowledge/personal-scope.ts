// Account-backed Personal Workspace Knowledge authority. This server-only
// projection never receives local folder paths, database records, or credentials.
import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { neonSql } from "../db";

const PERSONAL_KNOWLEDGE_NAMESPACE = "dopedb.personal-knowledge.v1";
const PERSONAL_KNOWLEDGE_METADATA = JSON.stringify({
  dopedbKind: "personalKnowledge",
  version: 1,
});

export type PersonalKnowledgeProject = {
  id: string;
  name: string;
  revision: number;
  environments: Array<{
    id: string;
    name: string;
    riskClass: "production" | "staging" | "development" | "test" | "custom";
    revision: number;
  }>;
};

type PersonalKnowledgeScopeRow = {
  workspaceId: string;
  memberId: string;
  projectCount: string | number;
  environmentCount: string | number;
};

function deterministicUuid(kind: "workspace" | "member", userId: string) {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${PERSONAL_KNOWLEDGE_NAMESPACE}:${kind}:${userId}`, "utf8")
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export function personalKnowledgeOrganizationId(userId: string) {
  return deterministicUuid("workspace", userId);
}

export function isPersonalKnowledgeOrganization(userId: string, organizationId: string) {
  return organizationId === personalKnowledgeOrganizationId(userId);
}

export function isPersonalKnowledgeMetadata(metadata: string | null | undefined) {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return parsed.dopedbKind === "personalKnowledge" && parsed.version === 1;
  } catch {
    return false;
  }
}

/**
 * Ensure one private server authority per signed-in account and mirror only the
 * Personal Workspace Project/Environment identities needed by GitHub indexing.
 * One SQL statement keeps first-use provisioning and scope projection atomic on
 * the Neon HTTP driver.
 */
export async function ensurePersonalKnowledgeScope(input: {
  userId: string;
  projects: PersonalKnowledgeProject[];
}) {
  const workspaceId = personalKnowledgeOrganizationId(input.userId);
  const memberId = deterministicUuid("member", input.userId);
  const slugHash = createHash("sha256").update(input.userId, "utf8").digest("hex").slice(0, 24);
  const projects = JSON.stringify(input.projects);
  const expectedEnvironmentCount = input.projects.reduce(
    (count, project) => count + project.environments.length,
    0,
  );
  const rows = await neonSql.query(
    `WITH requested_project AS MATERIALIZED (
       SELECT requested."id", requested."name", requested."revision",
         requested."environments"
       FROM jsonb_to_recordset($7::jsonb)
         AS requested("id" uuid, "name" text, "revision" bigint, "environments" jsonb)
     ), requested_environment AS MATERIALIZED (
       SELECT project."id" AS "project_id", environment."id", environment."name",
         environment."riskClass" AS "risk_class", environment."revision"
       FROM requested_project project
       CROSS JOIN LATERAL jsonb_to_recordset(project."environments")
         AS environment("id" uuid, "name" text, "riskClass" text, "revision" bigint)
     ), requested_identity_conflict AS MATERIALIZED (
       SELECT project."id"::text AS "id"
       FROM requested_project project
       JOIN "workspace_control"."knowledge_project" existing
         ON existing."id" = project."id"
        AND existing."organization_id" <> $1
       UNION ALL
       SELECT environment."id"::text AS "id"
       FROM requested_environment environment
       JOIN "workspace_control"."knowledge_project_environment" existing
         ON existing."id" = environment."id"
        AND existing."organization_id" <> $1
     ), inserted_organization AS MATERIALIZED (
       INSERT INTO "workspace_control"."organization"
         ("id", "name", "slug", "metadata")
       SELECT $1, 'Personal Knowledge', $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM requested_identity_conflict)
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"
     ), current_organization AS MATERIALIZED (
       SELECT "id" FROM inserted_organization
       UNION ALL
       SELECT organization."id"
       FROM "workspace_control"."organization" organization
       WHERE organization."id" = $1
       LIMIT 1
     ), ensured_profile AS MATERIALIZED (
       INSERT INTO "workspace_control"."workspace_profile"
         ("organization_id", "encryption_key_ref", "residency_region")
       SELECT organization."id", 'pending://' || organization."id", $5
       FROM current_organization organization
       WHERE NOT EXISTS (SELECT 1 FROM requested_identity_conflict)
       ON CONFLICT ("organization_id") DO NOTHING
       RETURNING "organization_id"
     ), ensured_member AS MATERIALIZED (
       INSERT INTO "workspace_control"."member"
         ("id", "organization_id", "user_id", "role")
       SELECT $2, organization."id", $6, 'owner'
       FROM current_organization organization
       WHERE NOT EXISTS (SELECT 1 FROM requested_identity_conflict)
       ON CONFLICT ("organization_id", "user_id") DO UPDATE SET
         "role" = 'owner'
       WHERE "workspace_control"."member"."revocation_pending_at" IS NULL
       RETURNING "id", "organization_id"
     ), created_audit AS MATERIALIZED (
       INSERT INTO "workspace_control"."workspace_audit_event"
         ("organization_id", "actor_user_id", "action", "resource_type",
          "resource_id", "redacted_summary", "request_id")
       SELECT organization."id", $6, 'workspace.create', 'workspace',
         organization."id", jsonb_build_object('kind', 'personal_knowledge'), $8::uuid
       FROM inserted_organization organization
       RETURNING "id"
     ), ensured_project AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_project"
         ("id", "organization_id", "name", "revision", "updated_at")
       SELECT project."id", organization."id", project."name", project."revision", now()
       FROM requested_project project
       CROSS JOIN current_organization organization
       WHERE NOT EXISTS (SELECT 1 FROM requested_identity_conflict)
       ON CONFLICT ("id") DO UPDATE SET
         "name" = EXCLUDED."name",
         "revision" = EXCLUDED."revision",
         "updated_at" = now()
       WHERE "workspace_control"."knowledge_project"."organization_id"
         = EXCLUDED."organization_id"
       RETURNING "id", "organization_id"
     ), ensured_environment AS MATERIALIZED (
       INSERT INTO "workspace_control"."knowledge_project_environment"
         ("id", "organization_id", "project_id", "name", "production",
          "risk_class", "revision", "updated_at")
       SELECT environment."id", project."organization_id", environment."project_id",
         environment."name", environment."risk_class" = 'production',
         environment."risk_class", environment."revision", now()
       FROM requested_environment environment
       JOIN ensured_project project ON project."id" = environment."project_id"
       ON CONFLICT ("id") DO UPDATE SET
         "name" = EXCLUDED."name",
         "production" = EXCLUDED."production",
         "risk_class" = EXCLUDED."risk_class",
         "revision" = EXCLUDED."revision",
         "updated_at" = now()
       WHERE "workspace_control"."knowledge_project_environment"."organization_id"
           = EXCLUDED."organization_id"
         AND "workspace_control"."knowledge_project_environment"."project_id"
           = EXCLUDED."project_id"
       RETURNING "id"
     )
     SELECT organization."id" AS "workspaceId", member."id" AS "memberId",
       (SELECT count(*) FROM ensured_project)::text AS "projectCount",
       (SELECT count(*) FROM ensured_environment)::text AS "environmentCount"
     FROM current_organization organization
     JOIN ensured_member member ON member."organization_id" = organization."id"
     WHERE NOT EXISTS (SELECT 1 FROM requested_identity_conflict)`,
    [
      workspaceId,
      memberId,
      `personal-knowledge-${slugHash}`,
      PERSONAL_KNOWLEDGE_METADATA,
      process.env.VERCEL_REGION ?? null,
      input.userId,
      projects,
      randomUUID(),
    ],
  ) as PersonalKnowledgeScopeRow[];
  const scope = rows[0];
  if (
    !scope
    || scope.workspaceId !== workspaceId
    || Number(scope.projectCount) !== input.projects.length
    || Number(scope.environmentCount) !== expectedEnvironmentCount
  ) {
    throw new Error("Personal Knowledge scope projection was incomplete");
  }
  return { workspaceId: scope.workspaceId, memberId: scope.memberId };
}
