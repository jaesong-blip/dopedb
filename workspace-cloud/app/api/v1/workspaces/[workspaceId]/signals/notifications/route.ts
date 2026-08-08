import { and, desc, eq, inArray } from "drizzle-orm";

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
  workspaceSignalEvaluationReceipt,
  workspaceSignalNotification,
  workspaceSignalRule,
} from "../../../../../../../lib/schema";
import { markSignalNotificationsRead } from "../../../../../../../lib/signal-notifications";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const rows = await db.select({
    id: workspaceSignalNotification.id,
    ruleId: workspaceSignalRule.id,
    metricSemanticId: workspaceSignalRule.metricSemanticId,
    severity: workspaceSignalRule.definition,
    channel: workspaceSignalNotification.channel,
    deliveryState: workspaceSignalNotification.state,
    state: workspaceSignalEvaluationReceipt.state,
    observedState: workspaceSignalEvaluationReceipt.observedState,
    evaluatedAt: workspaceSignalEvaluationReceipt.evaluatedAt,
    createdAt: workspaceSignalNotification.createdAt,
    readAt: workspaceSignalNotification.readAt,
  }).from(workspaceSignalNotification)
    .innerJoin(workspaceSignalEvaluationReceipt, and(
      eq(workspaceSignalEvaluationReceipt.organizationId, workspaceSignalNotification.organizationId),
      eq(workspaceSignalEvaluationReceipt.id, workspaceSignalNotification.receiptId),
    ))
    .innerJoin(workspaceSignalRule, and(
      eq(workspaceSignalRule.organizationId, workspaceSignalEvaluationReceipt.organizationId),
      eq(workspaceSignalRule.id, workspaceSignalEvaluationReceipt.ruleId),
    ))
    .where(and(
      eq(workspaceSignalNotification.organizationId, workspaceId),
      eq(workspaceSignalNotification.recipientMemberId, authorization.membership.id),
      eq(workspaceSignalNotification.channel, "workspace_web"),
      inArray(workspaceSignalNotification.state, ["pending", "delivered"]),
    ))
    .orderBy(desc(workspaceSignalNotification.createdAt))
    .limit(100);
  return privateJson({
    workspaceId,
    notifications: rows.map((row) => {
      const definition = row.severity && typeof row.severity === "object"
        && !Array.isArray(row.severity) ? row.severity as Record<string, unknown> : {};
      return {
        id: row.id,
        ruleId: row.ruleId,
        metricSemanticId: row.metricSemanticId,
        severity: typeof definition.severity === "string" ? definition.severity : "warning",
        channel: row.channel,
        deliveryState: row.deliveryState,
        state: row.state,
        observedState: row.observedState,
        evaluatedAt: row.evaluatedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
      };
    }),
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const body = await boundedJsonBody(request, 8 * 1024);
  if (!body.ok || !body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return jsonError("Invalid notification command", 400);
  }
  const row = body.value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.action !== "mark_read"
    || !Array.isArray(row.notificationIds) || row.notificationIds.length > 100
    || row.notificationIds.some((id) => typeof id !== "string" || !isUuid(id))) {
    return jsonError("Invalid notification command", 400);
  }
  const updated = await markSignalNotificationsRead({
    organizationId: workspaceId,
    memberId: authorization.membership.id,
    userId: authorization.session.user.id,
    notificationIds: row.notificationIds as string[],
  });
  return privateJson({ updated });
}
