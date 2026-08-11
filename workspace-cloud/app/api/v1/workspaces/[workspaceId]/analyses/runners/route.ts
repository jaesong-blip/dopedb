// Inventory and heartbeat registration for member-owned Analysis runners.
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../../../../../../lib/db";
import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import {
  workspaceAnalysisArticle,
  workspaceAnalysisRunner,
} from "../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { registerAnalysisRunner } from "../../../../../../../lib/workspace-analysis-runner-store";
import { parseAnalysisRunnerRegistration } from "../../../../../../../lib/workspace-analysis-runs";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const runners = await db.select({
    id: workspaceAnalysisRunner.id,
    deviceId: workspaceAnalysisRunner.deviceId,
    displayName: workspaceAnalysisRunner.displayName,
    backgroundAllowed: workspaceAnalysisRunner.backgroundAllowed,
    lastSeenAt: workspaceAnalysisRunner.lastSeenAt,
    scheduledArticleCount: sql<number>`(
      SELECT count(*)::int
      FROM ${workspaceAnalysisArticle} article
      WHERE article."organization_id" = ${workspaceAnalysisRunner.organizationId}
        AND article."deleted_at" IS NULL
        AND article."state" = 'live'
        AND article."definition"->'refresh'->>'mode' = 'scheduled'
        AND article."definition"->'refresh'->>'runnerId' = ${workspaceAnalysisRunner.id}::text
    )`,
  }).from(workspaceAnalysisRunner).where(and(
    eq(workspaceAnalysisRunner.organizationId, workspaceId),
    eq(workspaceAnalysisRunner.memberId, authorization.membership.id),
    isNull(workspaceAnalysisRunner.revokedAt),
  )).orderBy(desc(workspaceAnalysisRunner.lastSeenAt));
  return privateJson({
    workspaceId,
    runners: runners.map((runner) => ({
      ...runner,
      lastSeenAt: runner.lastSeenAt.toISOString(),
      online: runner.lastSeenAt.getTime() > Date.now() - 120_000,
    })),
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const body = await boundedJsonBody(request, 8 * 1024);
  if (!body.ok) return jsonError("Invalid Analysis runner request", 400);
  let registration;
  try {
    registration = parseAnalysisRunnerRegistration(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid Analysis runner", 400);
  }
  const runner = await registerAnalysisRunner({
    organizationId: workspaceId,
    registration,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
  });
  if (!runner) return jsonError("Analysis runner authority changed", 409);
  return privateJson({
    runner: { ...runner, lastSeenAt: runner.lastSeenAt.toISOString(), online: true },
  }, { status: 201 });
}
