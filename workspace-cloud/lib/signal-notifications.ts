//! Delivery and inbox projection for secret-free Signal transitions.

import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "./db";
import { env } from "./env";
import {
  member,
  organization,
  user,
  workspaceSignalEvaluationReceipt,
  workspaceSignalNotification,
  workspaceSignalRule,
  workspaceAuditEvent,
} from "./schema";

export async function deliverSignalEmailNotifications(
  organizationId: string,
  receiptId: string,
) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.WORKSPACE_SIGNAL_FROM?.trim()
    || process.env.WORKSPACE_INVITATION_FROM?.trim();
  if (!apiKey || !from) return;
  const rows = await db.select({
    id: workspaceSignalNotification.id,
    email: user.email,
    workspaceName: organization.name,
    ruleId: workspaceSignalRule.id,
    metricSemanticId: workspaceSignalRule.metricSemanticId,
    severity: workspaceSignalRule.definition,
    state: workspaceSignalEvaluationReceipt.state,
    evaluatedAt: workspaceSignalEvaluationReceipt.evaluatedAt,
  }).from(workspaceSignalNotification)
    .innerJoin(workspaceSignalEvaluationReceipt, and(
      eq(workspaceSignalEvaluationReceipt.organizationId, workspaceSignalNotification.organizationId),
      eq(workspaceSignalEvaluationReceipt.id, workspaceSignalNotification.receiptId),
    ))
    .innerJoin(workspaceSignalRule, and(
      eq(workspaceSignalRule.organizationId, workspaceSignalEvaluationReceipt.organizationId),
      eq(workspaceSignalRule.id, workspaceSignalEvaluationReceipt.ruleId),
    ))
    .innerJoin(member, and(
      eq(member.organizationId, workspaceSignalNotification.organizationId),
      eq(member.id, workspaceSignalNotification.recipientMemberId),
    ))
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, workspaceSignalNotification.organizationId))
    .where(and(
      eq(workspaceSignalNotification.organizationId, organizationId),
      eq(workspaceSignalNotification.receiptId, receiptId),
      eq(workspaceSignalNotification.channel, "email"),
      eq(workspaceSignalNotification.state, "pending"),
    ));
  for (const row of rows) {
    const definition = row.severity && typeof row.severity === "object"
      && !Array.isArray(row.severity) ? row.severity as Record<string, unknown> : {};
    const severity = typeof definition.severity === "string" ? definition.severity : "warning";
    const link = `${env.appOrigin()}/settings?workspace=${encodeURIComponent(
      organizationId,
    )}&section=monitoring&signal=${encodeURIComponent(row.ruleId)}`;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `dopedb-signal-${row.id}`,
      },
      body: JSON.stringify({
        from,
        to: [row.email],
        subject: `[${severity}] ${row.metricSemanticId} · ${row.state}`,
        text: [
          `${row.workspaceName} / ${row.metricSemanticId}`,
          `State: ${row.state}`,
          `Evaluated: ${row.evaluatedAt.toISOString()}`,
          "",
          "Metric values and result rows remain on the selected DopeDB Desktop runner.",
          link,
        ].join("\n"),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    await db.update(workspaceSignalNotification).set({
      state: response?.ok ? "delivered" : "failed",
      deliveryAttempt: 1,
      deliveredAt: response?.ok ? new Date() : null,
      errorKind: response?.ok ? null : "transport_failed",
    }).where(and(
      eq(workspaceSignalNotification.organizationId, organizationId),
      eq(workspaceSignalNotification.id, row.id),
      eq(workspaceSignalNotification.state, "pending"),
    ));
  }
}

export async function markSignalNotificationsRead(input: {
  organizationId: string;
  memberId: string;
  userId: string;
  notificationIds: readonly string[];
}) {
  if (input.notificationIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    const updated = await tx.update(workspaceSignalNotification).set({
      readAt: new Date(),
    }).where(and(
      eq(workspaceSignalNotification.organizationId, input.organizationId),
      eq(workspaceSignalNotification.recipientMemberId, input.memberId),
      inArray(workspaceSignalNotification.id, [...input.notificationIds]),
    )).returning({ id: workspaceSignalNotification.id });
    if (updated.length > 0) {
      await tx.insert(workspaceAuditEvent).values({
        organizationId: input.organizationId,
        actorUserId: input.userId,
        action: "signal.notifications.read",
        resourceType: "signal_notification",
        resourceId: input.memberId,
        redactedSummary: { count: updated.length },
        requestId: crypto.randomUUID(),
      });
    }
    return updated.length;
  });
}
