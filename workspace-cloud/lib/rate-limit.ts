//! Shared, bounded request-budget storage for public and authenticated routes.

import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import { rateLimit } from "./schema";
import { canonicalHash } from "./workspace-versioning";

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_CLEANUP_ROWS = 1_000;

export function forwardedClientKey(headers: Pick<Headers, "get">) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || headers.get("x-real-ip")?.trim()
    || "unknown";
  return canonicalHash({ forwarded });
}

export async function consumeRateLimit(input: {
  namespace: string;
  discriminator: string;
  limit: number;
  windowMs?: number;
  retentionMs?: number;
}) {
  const now = Date.now();
  const windowMs = input.windowMs ?? 60_000;
  const retentionMs = input.retentionMs ?? DEFAULT_RETENTION_MS;
  if (
    !/^[a-z][a-z0-9-]{1,63}$/.test(input.namespace)
    || !input.discriminator
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || !Number.isSafeInteger(windowMs)
    || windowMs < 1_000
    || !Number.isSafeInteger(retentionMs)
    || retentionMs < windowMs
  ) {
    throw new Error("Invalid rate-limit boundary");
  }
  // A fixed-window bucket must encode the window itself. Reusing one row while
  // moving `last_request` on every hit turns low steady traffic into an eternal
  // lockout because the reset condition is never reached. Windowed keys let the
  // next interval start independently; bounded retention removes old buckets.
  const windowStartedAt = Math.floor(now / windowMs) * windowMs;
  const key = `${input.namespace}:${input.discriminator}:${windowStartedAt}`;
  const result = await db.execute<{ value: number }>(sql`
    INSERT INTO ${rateLimit} ("id", "key", "count", "last_request")
    VALUES (${crypto.randomUUID()}, ${key}, 1, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = ${rateLimit.count} + 1,
      "last_request" = ${now}
    RETURNING "count" AS "value"
  `);
  return Number(result.rows[0]?.value ?? Number.POSITIVE_INFINITY) <= input.limit;
}

/**
 * Retention is background maintenance, not part of the request hot path. Delete a
 * bounded oldest-first batch so an accumulated table can never turn one public
 * page request or one cron tick into an unbounded write transaction.
 */
export async function cleanupExpiredRateLimits(input?: {
  retentionMs?: number;
  limit?: number;
}) {
  const retentionMs = input?.retentionMs ?? DEFAULT_RETENTION_MS;
  const limit = input?.limit ?? MAX_CLEANUP_ROWS;
  if (
    !Number.isSafeInteger(retentionMs)
    || retentionMs < 60_000
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_CLEANUP_ROWS
  ) {
    throw new Error("Invalid rate-limit cleanup boundary");
  }
  const cutoff = Date.now() - retentionMs;
  const result = await db.execute<{ id: string }>(sql`
    WITH expired AS MATERIALIZED (
      SELECT ${rateLimit.id}
      FROM ${rateLimit}
      WHERE ${rateLimit.lastRequest} < ${cutoff}
      ORDER BY ${rateLimit.lastRequest} ASC, ${rateLimit.id} ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM ${rateLimit}
    USING expired
    WHERE ${rateLimit.id} = expired."id"
    RETURNING ${rateLimit.id} AS "id"
  `);
  return result.rows.length;
}
