import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { boundedJsonBody, isUuid, jsonError, mutationAllowed, privateJson } from "@/lib/http";
import { authorizeKnowledgeGrant } from "@/lib/knowledge/authorization";
import {
  knowledgeMutationAuthority,
  knowledgeMutationAuthoritySql,
} from "@/lib/knowledge/mutation-authority";
import {
  knowledgeEnvironmentHead,
  knowledgeGrant,
  knowledgeGrantGraphRevision,
  knowledgeGraphRevision,
  knowledgeMappingProposal,
  knowledgeProjectEnvironment,
  knowledgeSource,
  workspaceAuditEvent,
} from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const mappings = await db.select({
    id: knowledgeMappingProposal.id,
    projectEnvironmentId: knowledgeMappingProposal.projectEnvironmentId,
    graphRevisionId: knowledgeMappingProposal.graphRevisionId,
    schemaFingerprint: knowledgeMappingProposal.schemaFingerprint,
    fromNodeId: knowledgeMappingProposal.fromNodeId,
    targetKind: knowledgeMappingProposal.targetKind,
    targetIdentity: knowledgeMappingProposal.targetIdentity,
    state: knowledgeMappingProposal.state,
    proposedAt: knowledgeMappingProposal.proposedAt,
  }).from(knowledgeMappingProposal).where(eq(
    knowledgeMappingProposal.organizationId,
    workspaceId,
  ));
  return privateJson({ mappings });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const parsed = await boundedJsonBody(request, 16 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !body
    || typeof body.grantId !== "string"
    || !isUuid(body.grantId)
    || typeof body.graphRevisionId !== "string"
    || !isUuid(body.graphRevisionId)
    || typeof body.schemaFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(body.schemaFingerprint)
    || typeof body.fromNodeId !== "string"
    || !/^[0-9a-f]{64}$/.test(body.fromNodeId)
    || typeof body.targetKind !== "string"
    || body.targetKind.length < 1
    || body.targetKind.length > 128
    || typeof body.targetIdentity !== "string"
    || body.targetIdentity.length < 1
    || body.targetIdentity.length > 2_048
    || /[\u0000-\u001f\u007f-\u009f]/.test(body.targetIdentity)
  ) return jsonError("Invalid Knowledge mapping proposal", 400);
  const authorization = await authorizeKnowledgeGrant(request, workspaceId, body.grantId);
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!authorization.grant.graphRevisionIds.includes(body.graphRevisionId)) {
    return jsonError("Knowledge graph is outside this grant", 403);
  }
  const [head] = await db.select({ graphRevisionId: knowledgeEnvironmentHead.graphRevisionId })
    .from(knowledgeEnvironmentHead).where(and(
      eq(knowledgeEnvironmentHead.organizationId, workspaceId),
      eq(knowledgeEnvironmentHead.projectEnvironmentId, authorization.grant.projectEnvironmentId),
      eq(knowledgeEnvironmentHead.graphRevisionId, body.graphRevisionId),
      eq(knowledgeEnvironmentHead.environmentRevision, authorization.grant.environmentRevision),
    )).limit(1);
  if (!head) return jsonError("Knowledge grant graph is no longer active", 409);
  const authority = knowledgeMutationAuthority(authorization, workspaceId, "view");
  const mappingId = crypto.randomUUID();
  const createdResult = await db.execute<{
    id: string;
    projectEnvironmentId: string;
    graphRevisionId: string;
    schemaFingerprint: string;
    fromNodeId: string;
    targetKind: string;
    targetIdentity: string;
    state: string;
    proposedAt: Date;
  }>(sql`
    WITH actor_authority AS MATERIALIZED (
      SELECT 1 WHERE ${knowledgeMutationAuthoritySql(authority, workspaceId)}
    ), eligible_grant AS MATERIALIZED (
      SELECT issued."project_environment_id", graph_scope."graph_revision_id"
      FROM ${knowledgeGrant} issued
      JOIN ${knowledgeGrantGraphRevision} graph_scope
        ON graph_scope."organization_id" = issued."organization_id"
       AND graph_scope."grant_id" = issued."id"
      JOIN ${knowledgeProjectEnvironment} environment
        ON environment."organization_id" = issued."organization_id"
       AND environment."id" = issued."project_environment_id"
       AND environment."project_id" = issued."project_id"
       AND environment."revision" = issued."environment_revision"
      JOIN ${knowledgeEnvironmentHead} head
        ON head."organization_id" = graph_scope."organization_id"
       AND head."project_environment_id" = issued."project_environment_id"
       AND head."graph_revision_id" = graph_scope."graph_revision_id"
       AND head."environment_revision" = issued."environment_revision"
      JOIN ${knowledgeSource} source
        ON source."organization_id" = head."organization_id"
       AND source."id" = head."source_id"
       AND source."revoked_at" IS NULL
      CROSS JOIN actor_authority
      WHERE issued."organization_id" = ${workspaceId}
        AND issued."id" = ${body.grantId}::uuid
        AND issued."member_id" = ${authorization.membership.id}
        AND issued."revoked_at" IS NULL
        AND issued."expires_at" > now()
        AND graph_scope."graph_revision_id" = ${body.graphRevisionId}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM ${knowledgeGrantGraphRevision} required_scope
          WHERE required_scope."organization_id" = issued."organization_id"
            AND required_scope."grant_id" = issued."id"
            AND NOT EXISTS (
              SELECT 1
              FROM ${knowledgeGraphRevision} required_graph
              JOIN ${knowledgeEnvironmentHead} required_head
                ON required_head."organization_id" = required_graph."organization_id"
               AND required_head."project_environment_id" = required_graph."project_environment_id"
               AND required_head."source_id" = required_graph."source_id"
               AND required_head."graph_revision_id" = required_graph."id"
               AND required_head."environment_revision" = required_graph."environment_revision"
              JOIN ${knowledgeSource} required_source
                ON required_source."organization_id" = required_graph."organization_id"
               AND required_source."id" = required_graph."source_id"
               AND required_source."revoked_at" IS NULL
              WHERE required_graph."organization_id" = required_scope."organization_id"
                AND required_graph."id" = required_scope."graph_revision_id"
                AND required_graph."project_environment_id" = issued."project_environment_id"
                AND required_graph."environment_revision" = issued."environment_revision"
            )
        )
      FOR UPDATE OF issued, environment, head, source
    ), inserted AS MATERIALIZED (
      INSERT INTO ${knowledgeMappingProposal}
        ("id", "organization_id", "project_environment_id", "graph_revision_id",
         "schema_fingerprint", "from_node_id", "target_kind", "target_identity",
         "state", "proposed_by_member_id")
      SELECT ${mappingId}::uuid, ${workspaceId}, eligible."project_environment_id",
        eligible."graph_revision_id", ${body.schemaFingerprint}, ${body.fromNodeId},
        ${body.targetKind}, ${body.targetIdentity}, 'proposed', ${authorization.membership.id}
      FROM eligible_grant eligible
      RETURNING *
    ), audited AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${workspaceId}, ${authorization.session.user.id}, 'knowledge.mapping.propose',
        'knowledge_mapping', inserted."id"::text,
        jsonb_build_object(
          'projectEnvironmentId', inserted."project_environment_id",
          'graphRevisionId', inserted."graph_revision_id",
          'targetKind', inserted."target_kind"
        ), ${crypto.randomUUID()}::uuid
      FROM inserted RETURNING "id"
    )
    SELECT inserted."id"::text AS "id",
      inserted."project_environment_id"::text AS "projectEnvironmentId",
      inserted."graph_revision_id"::text AS "graphRevisionId",
      inserted."schema_fingerprint" AS "schemaFingerprint",
      inserted."from_node_id" AS "fromNodeId", inserted."target_kind" AS "targetKind",
      inserted."target_identity" AS "targetIdentity", inserted."state",
      inserted."proposed_at" AS "proposedAt"
    FROM inserted, audited
  `);
  const mapping = createdResult.rows[0];
  if (!mapping) return jsonError("Knowledge grant authority or graph changed", 409);
  return privateJson({ mapping }, { status: 201 });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const authority = knowledgeMutationAuthority(authorization, workspaceId, "manage");
  const parsed = await boundedJsonBody(request, 8 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !body
    || typeof body.mappingId !== "string"
    || !isUuid(body.mappingId)
    || typeof body.expectedGraphRevisionId !== "string"
    || !isUuid(body.expectedGraphRevisionId)
    || (body.decision !== "approved" && body.decision !== "rejected")
  ) return jsonError("Invalid Knowledge mapping decision", 400);
  const mappingId = body.mappingId;
  const expectedGraphRevisionId = body.expectedGraphRevisionId;
  const decision = body.decision;
  const decidedAt = new Date();
  const updatedResult = await db.execute<{
    id: string;
    state: string;
    projectEnvironmentId: string;
    graphRevisionId: string;
  }>(sql`
    WITH actor_authority AS MATERIALIZED (
      SELECT 1 WHERE ${knowledgeMutationAuthoritySql(authority, workspaceId)}
    ), updated AS MATERIALIZED (
      UPDATE ${knowledgeMappingProposal} AS proposal
      SET "state" = ${decision},
          "decided_by_member_id" = ${authorization.membership.id},
          "decided_at" = ${decidedAt}
      WHERE proposal."organization_id" = ${workspaceId}
        AND proposal."id" = ${mappingId}::uuid
        AND proposal."graph_revision_id" = ${expectedGraphRevisionId}::uuid
        AND proposal."state" = 'proposed'
        AND EXISTS (SELECT 1 FROM actor_authority)
        AND EXISTS (
          SELECT 1 FROM ${knowledgeEnvironmentHead} head
          WHERE head."organization_id" = ${workspaceId}
            AND head."project_environment_id" = proposal."project_environment_id"
            AND head."graph_revision_id" = proposal."graph_revision_id"
        )
      RETURNING proposal."id"::text AS "id", proposal."state" AS "state",
        proposal."project_environment_id"::text AS "projectEnvironmentId",
        proposal."graph_revision_id"::text AS "graphRevisionId"
    ), audited AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${workspaceId}, ${authorization.session.user.id},
        ${`knowledge.mapping.${decision}`}, 'knowledge_mapping', updated."id",
        jsonb_build_object(
          'projectEnvironmentId', updated."projectEnvironmentId",
          'graphRevisionId', updated."graphRevisionId"
        ), ${crypto.randomUUID()}::uuid
      FROM updated
      RETURNING "id"
    )
    SELECT updated.* FROM updated, audited
  `);
  const updated = updatedResult.rows;
  if (updated.length !== 1) return jsonError("Knowledge mapping is stale or already decided", 409);
  return privateJson({ mapping: updated[0] });
}
