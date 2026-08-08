import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { boundedJsonBody, isUuid, jsonError, mutationAllowed, privateJson } from "@/lib/http";
import {
  knowledgeEnvironmentHead,
  knowledgeGrant,
  knowledgeGrantGraphRevision,
  knowledgeGraphRevision,
  knowledgeProjectEnvironment,
  knowledgeSource,
  member,
  workspaceAuditEvent,
} from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const ownOnly = new URL(request.url).searchParams.get("scope") === "mine";
  const authorization = await authorizeWorkspace(
    request,
    workspaceId,
    ownOnly ? "view" : "manage",
  );
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const rows = await db.select({
    id: knowledgeGrant.id,
    memberId: knowledgeGrant.memberId,
    projectId: knowledgeGrant.projectId,
    projectEnvironmentId: knowledgeGrant.projectEnvironmentId,
    environmentRevision: knowledgeGrant.environmentRevision,
    graphRevisionId: knowledgeGrantGraphRevision.graphRevisionId,
    sourceId: knowledgeGraphRevision.sourceId,
    expiresAt: knowledgeGrant.expiresAt,
    revokedAt: knowledgeGrant.revokedAt,
  }).from(knowledgeGrant).innerJoin(
    knowledgeGrantGraphRevision,
    and(
      eq(knowledgeGrantGraphRevision.organizationId, knowledgeGrant.organizationId),
      eq(knowledgeGrantGraphRevision.grantId, knowledgeGrant.id),
    ),
  ).innerJoin(
    knowledgeGraphRevision,
    and(
      eq(knowledgeGraphRevision.organizationId, knowledgeGrantGraphRevision.organizationId),
      eq(knowledgeGraphRevision.id, knowledgeGrantGraphRevision.graphRevisionId),
    ),
  ).where(and(
    eq(knowledgeGrant.organizationId, workspaceId),
    ownOnly ? eq(knowledgeGrant.memberId, authorization.membership.id) : undefined,
    isNull(knowledgeGrant.revokedAt),
    gt(knowledgeGrant.expiresAt, new Date()),
  )).orderBy(asc(knowledgeGrant.id), asc(knowledgeGraphRevision.sourceId));
  const grants = Array.from(rows.reduce((grouped, row) => {
    const current = grouped.get(row.id);
    if (current) {
      current.graphRevisionIds.push(row.graphRevisionId);
      current.graphScopes.push({
        sourceId: row.sourceId,
        graphRevisionId: row.graphRevisionId,
      });
      return grouped;
    }
    grouped.set(row.id, {
      id: row.id,
      memberId: row.memberId,
      projectId: row.projectId,
      projectEnvironmentId: row.projectEnvironmentId,
      environmentRevision: row.environmentRevision,
      graphRevisionIds: [row.graphRevisionId],
      graphScopes: [{ sourceId: row.sourceId, graphRevisionId: row.graphRevisionId }],
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
    graphScopes: Array<{ sourceId: string; graphRevisionId: string }>;
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
    await transaction.update(knowledgeGrant).set({ revokedAt: new Date() }).where(and(
      eq(knowledgeGrant.organizationId, workspaceId),
      eq(knowledgeGrant.memberId, scope.memberId),
      eq(knowledgeGrant.projectEnvironmentId, projectEnvironmentId),
      isNull(knowledgeGrant.revokedAt),
    ));
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
    await transaction.insert(workspaceAuditEvent).values({
      organizationId: workspaceId,
      actorUserId: authorization.session.user.id,
      action: "knowledge.grant.issue",
      resourceType: "knowledge_grant",
      resourceId: created.id,
      redactedSummary: {
        memberId: scope.memberId,
        projectEnvironmentId,
        environmentRevision: scope.environmentRevision,
        graphCount: graphRevisionIds.length,
        ttlSeconds,
      },
      requestId: crypto.randomUUID(),
    });
    return { ...created, graphRevisionIds };
  });
  return privateJson({ grant }, { status: 201 });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 4 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (!body || typeof body.grantId !== "string" || !isUuid(body.grantId)) {
    return jsonError("Invalid Knowledge grant revocation", 400);
  }
  const grantId = body.grantId;
  const revoked = await db.transaction(async (transaction) => {
    const rows = await transaction.update(knowledgeGrant).set({ revokedAt: new Date() }).where(and(
      eq(knowledgeGrant.organizationId, workspaceId),
      eq(knowledgeGrant.id, grantId),
      isNull(knowledgeGrant.revokedAt),
    )).returning({
      id: knowledgeGrant.id,
      memberId: knowledgeGrant.memberId,
      projectEnvironmentId: knowledgeGrant.projectEnvironmentId,
    });
    if (rows.length !== 1) return rows;
    await transaction.insert(workspaceAuditEvent).values({
      organizationId: workspaceId,
      actorUserId: authorization.session.user.id,
      action: "knowledge.grant.revoke",
      resourceType: "knowledge_grant",
      resourceId: rows[0]!.id,
      redactedSummary: {
        memberId: rows[0]!.memberId,
        projectEnvironmentId: rows[0]!.projectEnvironmentId,
      },
      requestId: crypto.randomUUID(),
    });
    return rows;
  });
  if (revoked.length !== 1) return jsonError("Knowledge grant was not found", 404);
  return privateJson({ revoked: true });
}
