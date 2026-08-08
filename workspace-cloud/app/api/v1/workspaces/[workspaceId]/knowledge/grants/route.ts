import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { boundedJsonBody, isUuid, jsonError, mutationAllowed, privateJson } from "@/lib/http";
import {
  knowledgeEnvironmentHead,
  knowledgeGrant,
  knowledgeGrantGraphRevision,
  knowledgeProjectEnvironment,
  knowledgeSource,
  member,
} from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const rows = await db.select({
    id: knowledgeGrant.id,
    memberId: knowledgeGrant.memberId,
    projectId: knowledgeGrant.projectId,
    projectEnvironmentId: knowledgeGrant.projectEnvironmentId,
    environmentRevision: knowledgeGrant.environmentRevision,
    graphRevisionId: knowledgeGrantGraphRevision.graphRevisionId,
    expiresAt: knowledgeGrant.expiresAt,
    revokedAt: knowledgeGrant.revokedAt,
  }).from(knowledgeGrant).innerJoin(
    knowledgeGrantGraphRevision,
    and(
      eq(knowledgeGrantGraphRevision.organizationId, knowledgeGrant.organizationId),
      eq(knowledgeGrantGraphRevision.grantId, knowledgeGrant.id),
    ),
  ).where(and(
    eq(knowledgeGrant.organizationId, workspaceId),
    gt(knowledgeGrant.expiresAt, new Date()),
  ));
  const grants = Array.from(rows.reduce((grouped, row) => {
    const current = grouped.get(row.id);
    if (current) {
      current.graphRevisionIds.push(row.graphRevisionId);
      return grouped;
    }
    grouped.set(row.id, {
      id: row.id,
      memberId: row.memberId,
      projectId: row.projectId,
      projectEnvironmentId: row.projectEnvironmentId,
      environmentRevision: row.environmentRevision,
      graphRevisionIds: [row.graphRevisionId],
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    });
    return grouped;
  }, new Map<string, {
    id: string;
    memberId: string;
    projectId: string;
    projectEnvironmentId: string;
    environmentRevision: number;
    graphRevisionIds: string[];
    expiresAt: Date;
    revokedAt: Date | null;
  }>()).values());
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
  const memberId = body.memberId;
  const projectEnvironmentId = body.projectEnvironmentId;
  const ttlSeconds = body.ttlSeconds;
  const scopes = await db.select({
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
  ).innerJoin(
    knowledgeSource,
    and(
      eq(knowledgeSource.organizationId, knowledgeEnvironmentHead.organizationId),
      eq(knowledgeSource.id, knowledgeEnvironmentHead.sourceId),
      isNull(knowledgeSource.revokedAt),
    ),
  ).where(and(
    eq(member.organizationId, workspaceId),
    eq(member.id, memberId),
    isNull(member.revocationPendingAt),
    eq(knowledgeProjectEnvironment.id, projectEnvironmentId),
  ));
  if (scopes.length < 1) return jsonError("Member or active Knowledge graph not found", 404);
  if (scopes.length > 100) return jsonError("Knowledge environment has too many active graphs", 409);
  const scope = scopes[0]!;
  const graphRevisionIds = scopes.map((candidate) => candidate.graphRevisionId);
  const grant = await db.transaction(async (transaction) => {
    const [created] = await transaction.insert(knowledgeGrant).values({
      organizationId: workspaceId,
      memberId: scope.memberId,
      projectId: scope.projectId,
      projectEnvironmentId,
      environmentRevision: scope.environmentRevision,
      // Kept as the compatibility anchor while the set table is authoritative.
      graphRevisionId: graphRevisionIds[0],
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    }).returning({
      id: knowledgeGrant.id,
      expiresAt: knowledgeGrant.expiresAt,
    });
    await transaction.insert(knowledgeGrantGraphRevision).values(graphRevisionIds.map(
      (graphRevisionId) => ({
        organizationId: workspaceId,
        grantId: created.id,
        graphRevisionId,
      }),
    ));
    return { ...created, graphRevisionIds };
  });
  return privateJson({ grant }, { status: 201 });
}
