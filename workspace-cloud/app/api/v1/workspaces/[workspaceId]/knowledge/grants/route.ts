import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { boundedJsonBody, isUuid, jsonError, mutationAllowed, privateJson } from "@/lib/http";
import {
  knowledgeEnvironmentHead,
  knowledgeGrant,
  knowledgeProjectEnvironment,
  member,
} from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const grants = await db.select({
    id: knowledgeGrant.id,
    memberId: knowledgeGrant.memberId,
    projectId: knowledgeGrant.projectId,
    projectEnvironmentId: knowledgeGrant.projectEnvironmentId,
    environmentRevision: knowledgeGrant.environmentRevision,
    graphRevisionId: knowledgeGrant.graphRevisionId,
    expiresAt: knowledgeGrant.expiresAt,
    revokedAt: knowledgeGrant.revokedAt,
  }).from(knowledgeGrant).where(and(
    eq(knowledgeGrant.organizationId, workspaceId),
    gt(knowledgeGrant.expiresAt, new Date()),
  ));
  return privateJson({ grants });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 8 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !body
    || typeof body.memberId !== "string"
    || typeof body.projectEnvironmentId !== "string"
    || !isUuid(body.projectEnvironmentId)
    || typeof body.ttlSeconds !== "number"
    || !Number.isSafeInteger(body.ttlSeconds)
    || body.ttlSeconds < 60
    || body.ttlSeconds > 24 * 60 * 60
  ) {
    return jsonError("Invalid Knowledge grant", 400);
  }
  const [scope] = await db.select({
    memberId: member.id,
    projectId: knowledgeProjectEnvironment.projectId,
    environmentRevision: knowledgeProjectEnvironment.revision,
    graphRevisionId: knowledgeEnvironmentHead.graphRevisionId,
  }).from(member).innerJoin(
    knowledgeProjectEnvironment,
    eq(knowledgeProjectEnvironment.organizationId, member.organizationId),
  ).innerJoin(
    knowledgeEnvironmentHead,
    and(
      eq(knowledgeEnvironmentHead.organizationId, knowledgeProjectEnvironment.organizationId),
      eq(knowledgeEnvironmentHead.projectEnvironmentId, knowledgeProjectEnvironment.id),
      eq(knowledgeEnvironmentHead.environmentRevision, knowledgeProjectEnvironment.revision),
    ),
  ).where(and(
    eq(member.organizationId, workspaceId),
    eq(member.id, body.memberId),
    isNull(member.revocationPendingAt),
    eq(knowledgeProjectEnvironment.id, body.projectEnvironmentId),
  )).limit(1);
  if (!scope) return jsonError("Member or active Knowledge graph not found", 404);
  const [grant] = await db.insert(knowledgeGrant).values({
    organizationId: workspaceId,
    memberId: scope.memberId,
    projectId: scope.projectId,
    projectEnvironmentId: body.projectEnvironmentId,
    environmentRevision: scope.environmentRevision,
    graphRevisionId: scope.graphRevisionId,
    expiresAt: new Date(Date.now() + body.ttlSeconds * 1_000),
  }).returning({
    id: knowledgeGrant.id,
    graphRevisionId: knowledgeGrant.graphRevisionId,
    expiresAt: knowledgeGrant.expiresAt,
  });
  return privateJson({ grant }, { status: 201 });
}
