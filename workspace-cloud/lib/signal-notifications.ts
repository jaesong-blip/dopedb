//! Durable, idempotent email delivery for secret-free Signal transitions.

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

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

const CLAIM_TIMEOUT_MS = 2 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;
// Resend retains an idempotency key for 24 hours. Keep ambiguous retries at
// least one hour inside that boundary so a lost success response cannot turn
// the next durable attempt into a duplicate email.
const IDEMPOTENT_RETRY_WINDOW_MS = 23 * 60 * 60_000;
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  6 * 60 * 60_000,
  6 * 60 * 60_000,
];

type ClaimedNotification = {
  id: string;
  organizationId: string;
  deliveryAttempt: number;
  createdAtMs: number | string;
};

function retryDelay(attempt: number) {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

async function claimEmailNotifications(limit: number, now: Date, claimId: string) {
  const rows = await db.execute<ClaimedNotification>(sql`
    WITH candidates AS (
      SELECT notification."id"
      FROM ${workspaceAnalysisSignalNotification} AS notification
      WHERE notification."channel" = 'email'
        AND notification."state" = 'pending'
        AND notification."next_attempt_at" <= ${now}
        AND (
          notification."claim_id" IS NULL
          OR notification."claimed_at" < ${new Date(now.getTime() - CLAIM_TIMEOUT_MS)}
        )
      ORDER BY notification."next_attempt_at" ASC, notification."id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE ${workspaceAnalysisSignalNotification} AS notification
    SET "claim_id" = ${claimId}::uuid, "claimed_at" = ${now}
    FROM candidates
    WHERE notification."id" = candidates."id"
    RETURNING notification."id"::text AS "id",
      notification."organization_id" AS "organizationId",
      notification."delivery_attempt" AS "deliveryAttempt",
      extract(epoch FROM notification."created_at") * 1000 AS "createdAtMs"
  `);
  return rows.rows;
}

async function completeDelivery(input: {
  notification: ClaimedNotification;
  claimId: string;
  delivered: boolean;
  errorKind: string | null;
  now: Date;
}) {
  const attempt = input.notification.deliveryAttempt + 1;
  const createdAtMs = Number(input.notification.createdAtMs);
  const retryAtMs = input.now.getTime() + retryDelay(attempt);
  const retryDeadlineMs = Number.isFinite(createdAtMs)
    ? createdAtMs + IDEMPOTENT_RETRY_WINDOW_MS
    : Number.NEGATIVE_INFINITY;
  const terminal = !input.delivered
    && (attempt >= MAX_DELIVERY_ATTEMPTS || retryAtMs > retryDeadlineMs);
  await db.update(workspaceAnalysisSignalNotification).set({
    state: input.delivered ? "delivered" : terminal ? "failed" : "pending",
    deliveryAttempt: attempt,
    claimId: null,
    claimedAt: null,
    nextAttemptAt: input.delivered || terminal
      ? input.now
      : new Date(retryAtMs),
    deliveredAt: input.delivered ? input.now : null,
    errorKind: input.delivered ? null : input.errorKind ?? "transport_failed",
  }).where(and(
    eq(workspaceAnalysisSignalNotification.organizationId, input.notification.organizationId),
    eq(workspaceAnalysisSignalNotification.id, input.notification.id),
    eq(workspaceAnalysisSignalNotification.state, "pending"),
    eq(workspaceAnalysisSignalNotification.claimId, input.claimId),
  ));
}

export async function deliverAnalysisSignalEmailNotifications(limit = 5) {
  const apiKey = env.resendApiKey();
  const from = env.workspaceSignalFrom();
  if (!apiKey || !from) return 0;
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const claimId = crypto.randomUUID();
  const claimed = await claimEmailNotifications(boundedLimit, new Date(), claimId);
  if (claimed.length === 0) return 0;
  const ids = claimed.map((notification) => notification.id);
  const details = await db.select({
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
      inArray(workspaceAnalysisSignalNotification.id, ids),
      eq(workspaceAnalysisSignalNotification.claimId, claimId),
    ));
  const byId = new Map(details.map((row) => [row.id, row]));
  for (const notification of claimed) {
    const attemptAt = new Date();
    const createdAtMs = Number(notification.createdAtMs);
    if (!Number.isFinite(createdAtMs)
      || attemptAt.getTime() >= createdAtMs + IDEMPOTENT_RETRY_WINDOW_MS) {
      await completeDelivery({
        notification,
        claimId,
        delivered: false,
        errorKind: "idempotency_window_expired",
        now: attemptAt,
      });
      continue;
    }
    const row = byId.get(notification.id);
    if (!row) {
      await completeDelivery({
        notification, claimId, delivered: false, errorKind: "projection_missing", now: new Date(),
      });
      continue;
    }
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
    let response: Response | null = null;
    try {
      response = await fetch("https://api.resend.com/emails", {
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
      });
    } catch {
      response = null;
    }
    await completeDelivery({
      notification,
      claimId,
      delivered: response?.ok === true,
      errorKind: response ? `upstream_${response.status}` : "transport_failed",
      now: new Date(),
    });
  }
  return claimed.length;
}
