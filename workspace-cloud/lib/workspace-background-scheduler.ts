//! Event-driven wake-up boundary for durable workspace background work.

import "server-only";

import { boundedJsonResponse } from "./bounded-json-response";
import { neonSql } from "./db";
import { env } from "./env";

const CONTRACT_VERSION = "1";
const KICK_TIMEOUT_MS = 5_000;
const MAX_KICK_RESPONSE_BYTES = 1_024;
const MIN_WAKE_DELAY_MS = 60_000;
const IDLE_RECONCILIATION_MS = 60 * 60_000;
const MAX_SCHEDULE_AHEAD_MS = 24 * 60 * 60_000;

export type WorkspaceBackgroundTask = "knowledge" | "maintenance";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function acceptedKick(value: unknown) {
  return record(value)
    && Object.keys(value).length === 1
    && value.accepted === true;
}

function checkedNotBefore(value: Date) {
  const now = Date.now();
  const epoch = value.valueOf();
  if (!Number.isFinite(epoch) || epoch < now - MIN_WAKE_DELAY_MS || epoch > now + MAX_SCHEDULE_AHEAD_MS) {
    throw new Error("Invalid workspace background wake time");
  }
  return value.toISOString();
}

/**
 * Best-effort producer wake-up. PostgreSQL has already committed the durable
 * work before this call; the Worker's one-hour reconciliation receipt repairs a
 * missed kick without making a user mutation depend on Cloudflare availability.
 */
export async function kickWorkspaceBackgroundTask(input: {
  task: WorkspaceBackgroundTask;
  notBefore?: Date;
}) {
  try {
    if (!env.workspaceBackgroundSchedulerEnabled()) return false;
    const url = env.workspaceBackgroundSchedulerUrl();
    const token = env.workspaceBackgroundSchedulerToken();
    if (!url || !token) return false;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dopedb-background-scheduler-contract": CONTRACT_VERSION,
        "x-dopedb-background-token": token,
      },
      body: JSON.stringify({
        task: input.task,
        notBefore: checkedNotBefore(input.notBefore ?? new Date()),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
    });
    const body = await boundedJsonResponse(response, MAX_KICK_RESPONSE_BYTES)
      .catch(() => null);
    return response.status === 202 && acceptedKick(body);
  } catch {
    return false;
  }
}

export function workspaceSchedulerBoundedWakeAt(candidate: unknown, now = new Date()) {
  // Align idle reconciliation for every task to one wall-clock boundary so an
  // empty system wakes Neon once, rather than once per independently completed
  // task. A real due time remains earlier and wins below.
  const idleReconciliationAt = Math.ceil(
    (now.getTime() + MIN_WAKE_DELAY_MS) / IDLE_RECONCILIATION_MS,
  ) * IDLE_RECONCILIATION_MS;
  const parsed = candidate instanceof Date
    ? candidate
    : typeof candidate === "string" || typeof candidate === "number"
      ? new Date(candidate)
      : null;
  const epoch = parsed?.valueOf();
  const bounded = epoch !== undefined && Number.isFinite(epoch)
    ? Math.min(Math.max(epoch, now.getTime() + MIN_WAKE_DELAY_MS), idleReconciliationAt)
    : idleReconciliationAt;
  return new Date(bounded);
}

export async function nextKnowledgeBackgroundRunAt() {
  const rows = await neonSql.query(
    `SELECT min(CASE
         WHEN job."state" = 'queued' THEN job."available_at"
         ELSE job."lease_expires_at"
       END) AS "nextRunAt"
     FROM "workspace_control"."knowledge_source_sync_job" job
     JOIN "workspace_control"."knowledge_source" source
       ON source."organization_id" = job."organization_id"
      AND source."id" = job."source_id"
     JOIN "workspace_control"."knowledge_github_installation" installation
       ON installation."organization_id" = source."organization_id"
      AND installation."id" = source."github_installation_id"
     WHERE job."state" IN ('queued', 'claimed')
       AND job."attempt" < 20
       AND source."provider" = 'github'
       AND source."visibility" = 'shared_graph'
       AND source."revoked_at" IS NULL
       AND source."sync_state" IN ('pending', 'syncing')
       AND source."commit_sha" = job."desired_commit_sha"
       AND source."sync_revision" = job."source_sync_revision"
       AND installation."status" = 'active'`,
  );
  return workspaceSchedulerBoundedWakeAt(rows[0]?.nextRunAt);
}

export async function nextMaintenanceBackgroundRunAt() {
  const emailConfigured = Boolean(env.resendApiKey() && env.workspaceSignalFrom());
  const rows = await neonSql.query(
    `SELECT min(due."nextRunAt") AS "nextRunAt"
     FROM (
       SELECT CASE
         WHEN lease."cleanup_claimed_at" IS NOT NULL
           AND lease."cleanup_claimed_at" > now() - interval '2 minutes'
           THEN lease."cleanup_claimed_at" + interval '2 minutes'
         ELSE COALESCE(lease."cleanup_next_attempt_at", lease."expires_at")
       END AS "nextRunAt"
       FROM "workspace_control"."workspace_credential_lease" lease
       WHERE lease."revoked_at" IS NULL
       UNION ALL
       SELECT CASE
         WHEN notification."claimed_at" IS NOT NULL
           AND notification."claimed_at" > now() - interval '2 minutes'
           THEN notification."claimed_at" + interval '2 minutes'
         ELSE notification."next_attempt_at"
       END AS "nextRunAt"
       FROM "workspace_control"."workspace_analysis_signal_notification" notification
       WHERE $1::boolean
         AND notification."channel" = 'email'
         AND notification."state" = 'pending'
       UNION ALL
       SELECT receipt."expires_at"
       FROM "workspace_control"."workspace_provider_discovery_receipt" receipt
       WHERE receipt."consumed_at" IS NULL
       UNION ALL
       SELECT receipt."consumed_at" + interval '10 minutes'
       FROM "workspace_control"."workspace_provider_discovery_receipt" receipt
       WHERE receipt."consumed_at" IS NOT NULL
       UNION ALL
       SELECT fragment."expires_at"
       FROM "workspace_control"."workspace_analysis_result_fragment" fragment
       UNION ALL
       SELECT backup."purge_after"
       FROM "workspace_control"."workspace_metadata_backup" backup
       WHERE backup."deleted_at" IS NOT NULL
       UNION ALL
       SELECT profile."purge_after"
       FROM "workspace_control"."workspace_profile" profile
       WHERE profile."lifecycle_state" = 'deletion_pending'
     ) due`,
    [emailConfigured],
  );
  return workspaceSchedulerBoundedWakeAt(rows[0]?.nextRunAt);
}

export function workspaceSchedulerRequest(request: Request) {
  return request.headers.get("x-dopedb-background-scheduler-contract") === CONTRACT_VERSION;
}

export function workspaceSchedulerReceipt(nextRunAt: Date) {
  return {
    contractVersion: 1 as const,
    nextRunAt: nextRunAt.toISOString(),
  };
}

export function workspaceSchedulerResponseHeaders() {
  return { "x-dopedb-background-scheduler-contract": CONTRACT_VERSION };
}
