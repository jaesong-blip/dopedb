// Workspace-web inbox for Analysis Article signal transitions. Entries carry
// categorical state and article/block identity only, never measured values.
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
  workspaceAnalysisSignal,
  workspaceAnalysisSignalNotification,
  workspaceAnalysisSignalReceipt,
  workspaceAuditEvent,
} from "../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const requestedChannel = new URL(request.url).searchParams.get("channel") ?? "workspace_web";
  if (!(requestedChannel === "workspace_web" || requestedChannel === "desktop")) {
    return jsonError("Invalid Analysis notification channel", 400);
  }
  const rows = await db.select({
    id: workspaceAnalysisSignalNotification.id,
    articleId: workspaceAnalysisArticle.id,
    articleTitle: workspaceAnalysisArticle.definition,
    signalId: workspaceAnalysisSignal.id,
    signalDefinition: workspaceAnalysisSignal.definition,
    blockId: workspaceAnalysisSignal.blockId,
    signalRevision: workspaceAnalysisSignalReceipt.signalRevision,
    state: workspaceAnalysisSignalReceipt.state,
    observedState: workspaceAnalysisSignalReceipt.observedState,
    severity: workspaceAnalysisSignal.definition,
    deliveryState: workspaceAnalysisSignalNotification.state,
    evaluatedAt: workspaceAnalysisSignalReceipt.evaluatedAt,
    createdAt: workspaceAnalysisSignalNotification.createdAt,
    readAt: workspaceAnalysisSignalNotification.readAt,
  }).from(workspaceAnalysisSignalNotification)
    .innerJoin(workspaceAnalysisSignalReceipt, and(
      eq(workspaceAnalysisSignalReceipt.organizationId, workspaceAnalysisSignalNotification.organizationId),
      eq(workspaceAnalysisSignalReceipt.id, workspaceAnalysisSignalNotification.receiptId),
    ))
    .innerJoin(workspaceAnalysisSignal, and(
      eq(workspaceAnalysisSignal.organizationId, workspaceAnalysisSignalReceipt.organizationId),
      eq(workspaceAnalysisSignal.id, workspaceAnalysisSignalReceipt.signalId),
    ))
    .innerJoin(workspaceAnalysisArticle, and(
      eq(workspaceAnalysisArticle.organizationId, workspaceAnalysisSignal.organizationId),
      eq(workspaceAnalysisArticle.id, workspaceAnalysisSignal.articleId),
    ))
    .where(and(
      eq(workspaceAnalysisSignalNotification.organizationId, workspaceId),
      eq(workspaceAnalysisSignalNotification.recipientMemberId, authorization.membership.id),
      eq(workspaceAnalysisSignalNotification.channel, requestedChannel),
      isNull(workspaceAnalysisArticle.deletedAt),
    ))
    .orderBy(desc(workspaceAnalysisSignalNotification.createdAt))
    .limit(200);
  return privateJson({
    notifications: rows.map((row) => {
      const articleDefinition = row.articleTitle as { title?: unknown };
      const signalDefinition = row.signalDefinition as { severity?: unknown };
      return {
        id: row.id,
        articleId: row.articleId,
        articleTitle: typeof articleDefinition?.title === "string"
          ? articleDefinition.title : "Analysis Article",
        signalId: row.signalId,
        blockId: row.blockId,
        signalRevision: row.signalRevision,
        state: row.state,
        observedState: row.observedState,
        severity: typeof signalDefinition?.severity === "string"
          ? signalDefinition.severity : "info",
        deliveryState: row.deliveryState,
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
  const requestedChannel = new URL(request.url).searchParams.get("channel") ?? "workspace_web";
  if (!(requestedChannel === "workspace_web" || requestedChannel === "desktop")) {
    return jsonError("Invalid Analysis notification channel", 400);
  }
  const body = await boundedJsonBody(request, 16 * 1024);
  const row = body.ok && body.value && typeof body.value === "object"
    && !Array.isArray(body.value) ? body.value as Record<string, unknown> : null;
  if (!row || Object.keys(row).length !== 1 || !Array.isArray(row.notificationIds)
    || row.notificationIds.length < 1 || row.notificationIds.length > 100
    || row.notificationIds.some((id) => typeof id !== "string" || !isUuid(id))
    || new Set(row.notificationIds).size !== row.notificationIds.length) {
    return jsonError("Invalid Analysis notification selection", 400);
  }
  const ids = row.notificationIds as string[];
  const updatedAt = new Date();
  const notificationIds = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const updatedResult = await db.execute<{ id: string }>(sql`
    WITH updated AS MATERIALIZED (
      UPDATE ${workspaceAnalysisSignalNotification} AS notification
      SET "read_at" = ${updatedAt}, "delivered_at" = ${updatedAt},
          "state" = 'delivered'
      WHERE notification."organization_id" = ${workspaceId}
        AND notification."recipient_member_id" = ${authorization.membership.id}
        AND notification."channel" = ${requestedChannel}
        AND notification."id" IN (${notificationIds})
      RETURNING notification."id"::text AS "id"
    ), audited AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${workspaceId}, ${authorization.session.user.id},
        'analysis_signal.notifications_read', 'analysis_signal_notification',
        ${authorization.membership.id},
        jsonb_build_object('count', (SELECT count(*)::integer FROM updated)),
        ${crypto.randomUUID()}::uuid
      WHERE EXISTS (SELECT 1 FROM updated)
      RETURNING "id"
    )
    SELECT updated."id" FROM updated, audited
  `);
  const updated = updatedResult.rows;
  return privateJson({ read: updated.map((notification) => notification.id) });
}
