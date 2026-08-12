import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { boundedJsonBody, isUuid, jsonError, mutationAllowed, privateJson } from "@/lib/http";
import { authorizeKnowledgeGrant } from "@/lib/knowledge/authorization";
import {
  knowledgeEnvironmentHead,
  knowledgeMappingProposal,
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
    || /[\u0000-\u001f\u007f]/.test(body.targetIdentity)
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
  const mappingId = crypto.randomUUID();
  const [createdRows] = await db.batch([
    db.insert(knowledgeMappingProposal).values({
      id: mappingId,
      organizationId: workspaceId,
      projectEnvironmentId: authorization.grant.projectEnvironmentId,
      graphRevisionId: body.graphRevisionId as string,
      schemaFingerprint: body.schemaFingerprint as string,
      fromNodeId: body.fromNodeId as string,
      targetKind: body.targetKind as string,
      targetIdentity: body.targetIdentity as string,
      state: "proposed",
      proposedByMemberId: authorization.membership.id,
    }).returning({
      id: knowledgeMappingProposal.id,
      projectEnvironmentId: knowledgeMappingProposal.projectEnvironmentId,
      graphRevisionId: knowledgeMappingProposal.graphRevisionId,
      schemaFingerprint: knowledgeMappingProposal.schemaFingerprint,
      fromNodeId: knowledgeMappingProposal.fromNodeId,
      targetKind: knowledgeMappingProposal.targetKind,
      targetIdentity: knowledgeMappingProposal.targetIdentity,
      state: knowledgeMappingProposal.state,
      proposedAt: knowledgeMappingProposal.proposedAt,
    }),
    db.insert(workspaceAuditEvent).values({
      organizationId: workspaceId,
      actorUserId: authorization.session.user.id,
      action: "knowledge.mapping.propose",
      resourceType: "knowledge_mapping",
      resourceId: mappingId,
      redactedSummary: {
        projectEnvironmentId: authorization.grant.projectEnvironmentId,
        graphRevisionId: body.graphRevisionId,
        targetKind: body.targetKind,
      },
      requestId: crypto.randomUUID(),
    }),
  ]);
  const mapping = createdRows[0];
  if (!mapping) throw new Error("Knowledge mapping insert returned no row");
  return privateJson({ mapping }, { status: 201 });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
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
    WITH updated AS MATERIALIZED (
      UPDATE ${knowledgeMappingProposal} AS proposal
      SET "state" = ${decision},
          "decided_by_member_id" = ${authorization.membership.id},
          "decided_at" = ${decidedAt}
      WHERE proposal."organization_id" = ${workspaceId}
        AND proposal."id" = ${mappingId}::uuid
        AND proposal."graph_revision_id" = ${expectedGraphRevisionId}::uuid
        AND proposal."state" = 'proposed'
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
