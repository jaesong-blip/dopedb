//! Delivery and inbox projection for secret-free Signal transitions.

import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "./db";
import { env } from "./env";
import {
  member,
  organization,
  user,
  workspaceAnalysisArticle,
  workspaceAnalysisSignal,
  workspaceAnalysisSignalNotification,
  workspaceAnalysisSignalReceipt,
} from "./schema";

export async function deliverAnalysisSignalEmailNotifications(limit = 50) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.WORKSPACE_SIGNAL_FROM?.trim()
    || process.env.WORKSPACE_INVITATION_FROM?.trim();
  if (!apiKey || !from) return 0;
  const rows = await db.select({
    id: workspaceAnalysisSignalNotification.id,
    organizationId: workspaceAnalysisSignalNotification.organizationId,
    email: user.email,
    workspaceName: organization.name,
    articleId: workspaceAnalysisArticle.id,
    articleDefinition: workspaceAnalysisArticle.definition,
    blockId: workspaceAnalysisSignal.blockId,
    signalDefinition: workspaceAnalysisSignal.definition,
    state: workspaceAnalysisSignalReceipt.state,
    evaluatedAt: workspaceAnalysisSignalReceipt.evaluatedAt,
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
    .innerJoin(member, and(
      eq(member.organizationId, workspaceAnalysisSignalNotification.organizationId),
      eq(member.id, workspaceAnalysisSignalNotification.recipientMemberId),
    ))
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, workspaceAnalysisSignalNotification.organizationId))
    .where(and(
      eq(workspaceAnalysisSignalNotification.channel, "email"),
      eq(workspaceAnalysisSignalNotification.state, "pending"),
    )).limit(Math.max(1, Math.min(limit, 100)));
  for (const row of rows) {
    const articleDefinition = row.articleDefinition && typeof row.articleDefinition === "object"
      && !Array.isArray(row.articleDefinition)
      ? row.articleDefinition as Record<string, unknown> : {};
    const signalDefinition = row.signalDefinition && typeof row.signalDefinition === "object"
      && !Array.isArray(row.signalDefinition)
      ? row.signalDefinition as Record<string, unknown> : {};
    const articleTitle = typeof articleDefinition.title === "string"
      ? articleDefinition.title : "Analysis Article";
    const severity = typeof signalDefinition.severity === "string"
      ? signalDefinition.severity : "warning";
    const link = `${env.appOrigin()}/settings?workspace=${encodeURIComponent(
      row.organizationId,
    )}&section=analyses&article=${encodeURIComponent(row.articleId)}&block=${encodeURIComponent(row.blockId)}`;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `dopedb-analysis-signal-${row.id}`,
      },
      body: JSON.stringify({
        from,
        to: [row.email],
        subject: `[${severity}] ${articleTitle} · ${row.state}`,
        text: [
          `${row.workspaceName} / ${articleTitle}`,
          `Block: ${row.blockId}`,
          `State: ${row.state}`,
          `Evaluated: ${row.evaluatedAt.toISOString()}`,
          "",
          "Metric values and database rows are intentionally absent from this notification.",
          link,
        ].join("\n"),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    await db.update(workspaceAnalysisSignalNotification).set({
      state: response?.ok ? "delivered" : "failed",
      deliveryAttempt: 1,
      deliveredAt: response?.ok ? new Date() : null,
      errorKind: response?.ok ? null : "transport_failed",
    }).where(and(
      eq(workspaceAnalysisSignalNotification.organizationId, row.organizationId),
      eq(workspaceAnalysisSignalNotification.id, row.id),
      eq(workspaceAnalysisSignalNotification.state, "pending"),
    ));
  }
  return rows.length;
}
