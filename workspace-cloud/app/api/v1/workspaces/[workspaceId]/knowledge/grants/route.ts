import { and, asc, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
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
  ).innerJoin(
    knowledgeEnvironmentHead,
    and(
      eq(knowledgeEnvironmentHead.organizationId, knowledgeGraphRevision.organizationId),
      eq(knowledgeEnvironmentHead.projectEnvironmentId, knowledgeGraphRevision.projectEnvironmentId),
      eq(knowledgeEnvironmentHead.sourceId, knowledgeGraphRevision.sourceId),
      eq(knowledgeEnvironmentHead.graphRevisionId, knowledgeGraphRevision.id),
      eq(knowledgeEnvironmentHead.environmentRevision, knowledgeGraphRevision.environmentRevision),
    ),
  ).innerJoin(
    knowledgeSource,
    and(
      eq(knowledgeSource.organizationId, knowledgeGraphRevision.organizationId),
      eq(knowledgeSource.id, knowledgeGraphRevision.sourceId),
      isNull(knowledgeSource.revokedAt),
    ),
  ).where(and(
    eq(knowledgeGrant.organizationId, workspaceId),
    ownOnly ? eq(knowledgeGrant.memberId, authorization.membership.id) : undefined,
    isNull(knowledgeGrant.revokedAt),
    gt(knowledgeGrant.expiresAt, new Date()),
  )).orderBy(asc(knowledgeGrant.id), asc(knowledgeGraphRevision.sourceId));
  const activeGrantIds = Array.from(new Set(rows.map((row) => row.id)));
  const graphCounts = activeGrantIds.length > 0
    ? await db.select({
        grantId: knowledgeGrantGraphRevision.grantId,
        graphCount: count(),
      }).from(knowledgeGrantGraphRevision).where(and(
        eq(knowledgeGrantGraphRevision.organizationId, workspaceId),
        inArray(knowledgeGrantGraphRevision.grantId, activeGrantIds),
      )).groupBy(knowledgeGrantGraphRevision.grantId)
    : [];
  const expectedGraphCount = new Map(
    graphCounts.map((row) => [row.grantId, Number(row.graphCount)]),
  );
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
  }>()).values()).filter((grant) => (
    expectedGraphCount.get(grant.id) === grant.graphRevisionIds.length
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
  const grantId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
  const [, createdRows] = await db.batch([
    db.update(knowledgeGrant).set({ revokedAt: new Date() }).where(and(
      eq(knowledgeGrant.organizationId, workspaceId),
      eq(knowledgeGrant.memberId, scope.memberId),
      eq(knowledgeGrant.projectEnvironmentId, projectEnvironmentId),
      isNull(knowledgeGrant.revokedAt),
    )),
    db.insert(knowledgeGrant).values({
      id: grantId,
      organizationId: workspaceId,
      memberId: scope.memberId,
      projectId: scope.projectId,
      projectEnvironmentId,
      environmentRevision: scope.environmentRevision,
      // Kept as the compatibility anchor while the set table is authoritative.
      graphRevisionId: graphRevisionIds[0],
      expiresAt,
    }).returning({
      id: knowledgeGrant.id,
      expiresAt: knowledgeGrant.expiresAt,
    }),
    db.insert(knowledgeGrantGraphRevision).values(graphRevisionIds.map(
      (graphRevisionId) => ({
        organizationId: workspaceId,
        grantId,
        graphRevisionId,
      }),
    )),
    db.insert(workspaceAuditEvent).values({
      organizationId: workspaceId,
      actorUserId: authorization.session.user.id,
      action: "knowledge.grant.issue",
      resourceType: "knowledge_grant",
      resourceId: grantId,
      redactedSummary: {
        memberId: scope.memberId,
        projectEnvironmentId,
        environmentRevision: scope.environmentRevision,
        graphCount: graphRevisionIds.length,
        ttlSeconds,
      },
      requestId: crypto.randomUUID(),
    }),
  ]);
  const created = createdRows[0];
  if (!created) throw new Error("Knowledge grant insert returned no row");
  const grant = { ...created, graphRevisionIds };
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
  const revokedResult = await db.execute<{
    id: string;
    memberId: string;
    projectEnvironmentId: string;
  }>(sql`
    WITH revoked AS MATERIALIZED (
      UPDATE ${knowledgeGrant} AS issued_grant
      SET "revoked_at" = ${new Date()}
      WHERE issued_grant."organization_id" = ${workspaceId}
        AND issued_grant."id" = ${grantId}::uuid
        AND issued_grant."revoked_at" IS NULL
      RETURNING issued_grant."id"::text AS "id",
        issued_grant."member_id" AS "memberId",
        issued_grant."project_environment_id"::text AS "projectEnvironmentId"
    ), audited AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${workspaceId}, ${authorization.session.user.id},
        'knowledge.grant.revoke', 'knowledge_grant', revoked."id",
        jsonb_build_object(
          'memberId', revoked."memberId",
          'projectEnvironmentId', revoked."projectEnvironmentId"
        ), ${crypto.randomUUID()}::uuid
      FROM revoked
      RETURNING "id"
    )
    SELECT revoked.* FROM revoked, audited
  `);
  const revoked = revokedResult.rows;
  if (revoked.length !== 1) return jsonError("Knowledge grant was not found", 404);
  return privateJson({ revoked: true });
}
