import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { verifyGithubWebhook } from "@/lib/knowledge/github-app";
import {
  knowledgeGithubInstallation,
  knowledgeSource,
  knowledgeSourceEvent,
} from "@/lib/schema";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 10_000;

async function boundedBody(request: Request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
}

function safeDelivery(value: string | null) {
  return value && /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : null;
}

function safePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function changedFiles(payload: Record<string, unknown>) {
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const paths = new Set<string>();
  for (const value of commits) {
    if (!value || typeof value !== "object") continue;
    const commit = value as Record<string, unknown>;
    for (const key of ["added", "modified", "removed"] as const) {
      const values = Array.isArray(commit[key]) ? commit[key] : [];
      for (const path of values) {
        if (safePath(path)) paths.add(path);
        if (paths.size > MAX_CHANGED_FILES) return [];
      }
    }
  }
  return [...paths].sort();
}

function positiveInteger(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return BigInt(value);
}

export async function POST(request: Request) {
  const rawBody = await boundedBody(request);
  if (!rawBody || !verifyGithubWebhook(
    rawBody,
    request.headers.get("x-hub-signature-256"),
  )) {
    return new Response(null, { status: 401 });
  }
  const deliveryId = safeDelivery(request.headers.get("x-github-delivery"));
  const event = request.headers.get("x-github-event");
  if (!deliveryId || !event) return new Response(null, { status: 400 });
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400 });
  }
  const installationPayload = payload.installation;
  const installationId = installationPayload && typeof installationPayload === "object"
    ? positiveInteger((installationPayload as Record<string, unknown>).id)
    : null;
  if (!installationId) return new Response(null, { status: 202 });
  const installations = await db.select({
    id: knowledgeGithubInstallation.id,
    organizationId: knowledgeGithubInstallation.organizationId,
  }).from(knowledgeGithubInstallation).where(eq(
    knowledgeGithubInstallation.installationId,
    installationId,
  ));
  if (installations.length === 0) return new Response(null, { status: 202 });

  if (event === "push") {
    const repositoryPayload = payload.repository;
    const repositoryId = repositoryPayload && typeof repositoryPayload === "object"
      ? positiveInteger((repositoryPayload as Record<string, unknown>).id)
      : null;
    const refName = typeof payload.ref === "string" ? payload.ref : null;
    const before = typeof payload.before === "string" && /^[0-9a-f]{40}$/.test(payload.before)
      ? payload.before
      : null;
    const deleted = payload.deleted === true;
    const after = !deleted
      && typeof payload.after === "string"
      && /^[0-9a-f]{40}$/.test(payload.after)
      && !/^0{40}$/.test(payload.after)
      ? payload.after
      : null;
    if (!repositoryId || !refName || !before) return new Response(null, { status: 202 });
    const files = changedFiles(payload);
    await db.transaction(async (transaction) => {
      for (const installation of installations) {
        const sources = await transaction.select({ id: knowledgeSource.id }).from(knowledgeSource)
          .where(and(
            eq(knowledgeSource.organizationId, installation.organizationId),
            eq(knowledgeSource.githubInstallationId, installation.id),
            eq(knowledgeSource.repositoryId, repositoryId.toString()),
            eq(knowledgeSource.refName, refName),
          ));
        for (const source of sources) {
          await transaction.insert(knowledgeSourceEvent).values({
            organizationId: installation.organizationId,
            sourceId: source.id,
            deliveryId,
            eventKind: "push",
            beforeCommitSha: before,
            afterCommitSha: after,
            changedFiles: files,
          }).onConflictDoNothing();
          await transaction.update(knowledgeSource).set({
            ...(after ? { commitSha: after } : {}),
            syncState: after ? "pending" : "stale",
            syncRevision: sqlIncrement(knowledgeSource.syncRevision),
            lastFailureCode: after ? null : "tracked_ref_deleted",
            updatedAt: new Date(),
          }).where(and(
            eq(knowledgeSource.organizationId, installation.organizationId),
            eq(knowledgeSource.id, source.id),
          ));
        }
      }
    });
  } else if (event === "installation") {
    const action = typeof payload.action === "string" ? payload.action : "";
    const status = action === "deleted"
      ? "revoked"
      : action === "suspend"
        ? "suspended"
        : action === "unsuspend" || action === "created" || action === "new_permissions_accepted"
          ? "active"
          : null;
    if (status) {
      await db.transaction(async (transaction) => {
        await transaction.update(knowledgeGithubInstallation).set({
          status,
          updatedAt: new Date(),
        }).where(eq(knowledgeGithubInstallation.installationId, installationId));
        if (status !== "active") {
          for (const installation of installations) {
            await transaction.update(knowledgeSource).set({
              syncState: status === "revoked" ? "revoked" : "stale",
              lastFailureCode: status === "revoked"
                ? "github_installation_revoked"
                : "github_installation_suspended",
              revokedAt: status === "revoked" ? new Date() : null,
              updatedAt: new Date(),
            }).where(and(
              eq(knowledgeSource.organizationId, installation.organizationId),
              eq(knowledgeSource.githubInstallationId, installation.id),
            ));
          }
        }
      });
    }
  }
  return new Response(null, { status: 202 });
}

// Drizzle's SQL fragment preserves an atomic monotonic webhook cursor.
import { sql } from "drizzle-orm";
function sqlIncrement(column: typeof knowledgeSource.syncRevision) {
  return sql`${column} + 1`;
}
