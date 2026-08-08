import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { boundedJsonBody, isUuid, jsonError, mutationAllowed, privateJson } from "@/lib/http";
import { authorizeKnowledgeGrant } from "@/lib/knowledge/authorization";
import {
  knowledgeEnvironmentHead,
  knowledgeMappingProposal,
} from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const mappings = await db.select().from(knowledgeMappingProposal).where(eq(
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
  const [mapping] = await db.insert(knowledgeMappingProposal).values({
    organizationId: workspaceId,
    projectEnvironmentId: authorization.grant.projectEnvironmentId,
    graphRevisionId: body.graphRevisionId,
    schemaFingerprint: body.schemaFingerprint,
    fromNodeId: body.fromNodeId,
    targetKind: body.targetKind,
    targetIdentity: body.targetIdentity,
    state: "proposed",
    proposedByMemberId: authorization.membership.id,
  }).returning({ id: knowledgeMappingProposal.id, state: knowledgeMappingProposal.state });
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
  const updated = await db.update(knowledgeMappingProposal).set({
    state: body.decision,
    decidedByMemberId: authorization.membership.id,
    decidedAt: new Date(),
  }).where(and(
    eq(knowledgeMappingProposal.organizationId, workspaceId),
    eq(knowledgeMappingProposal.id, body.mappingId),
    eq(knowledgeMappingProposal.graphRevisionId, body.expectedGraphRevisionId),
    eq(knowledgeMappingProposal.state, "proposed"),
    sql`EXISTS (
      SELECT 1 FROM ${knowledgeEnvironmentHead} head
      WHERE head.organization_id = ${workspaceId}
        AND head.project_environment_id = ${knowledgeMappingProposal.projectEnvironmentId}
        AND head.graph_revision_id = ${knowledgeMappingProposal.graphRevisionId}
    )`,
  )).returning({ id: knowledgeMappingProposal.id, state: knowledgeMappingProposal.state });
  if (updated.length !== 1) return jsonError("Knowledge mapping is stale or already decided", 409);
  return privateJson({ mapping: updated[0] });
}
