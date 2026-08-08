import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "../../../../../../../lib/db";
import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import { workspaceSignalRunner } from "../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { registerSignalRunner } from "../../../../../../../lib/workspace-signal-store";
import { parseSignalRunnerRegistration } from "../../../../../../../lib/workspace-signals";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const runners = await db.select({
    id: workspaceSignalRunner.id,
    deviceId: workspaceSignalRunner.deviceId,
    displayName: workspaceSignalRunner.displayName,
    backgroundAllowed: workspaceSignalRunner.backgroundAllowed,
    lastSeenAt: workspaceSignalRunner.lastSeenAt,
  }).from(workspaceSignalRunner).where(and(
    eq(workspaceSignalRunner.organizationId, workspaceId),
    eq(workspaceSignalRunner.memberId, authorization.membership.id),
    isNull(workspaceSignalRunner.revokedAt),
  )).orderBy(desc(workspaceSignalRunner.lastSeenAt));
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
  if (!body.ok) return jsonError("Invalid signal runner request", 400);
  let registration;
  try {
    registration = parseSignalRunnerRegistration(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid signal runner", 400);
  }
  const runner = await registerSignalRunner({
    organizationId: workspaceId,
    registration,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
  });
  if (!runner) return jsonError("Signal runner authority changed", 409);
  return privateJson({
    runner: { ...runner, lastSeenAt: runner.lastSeenAt.toISOString(), online: true },
  }, { status: 201 });
}
