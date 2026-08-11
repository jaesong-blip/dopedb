// Member-owned Desktop runner registration and scheduled Article refresh leases.
// The hosted service coordinates short capabilities only; the runner retains all
// database credentials and executes through the exact Desktop grant.
import "server-only";

import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";

import { db } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import {
  member,
  workspaceAnalysisArticle,
  workspaceAnalysisArticleConnection,
  workspaceAnalysisArticleRevision,
  workspaceAnalysisRefreshLease,
  workspaceAnalysisRunner,
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
} from "./schema";
import {
  nextAnalysisRefreshAt,
  parseAnalysisArticleVersionPayload,
} from "./workspace-analysis-articles";
import {
  parseAnalysisParameterValues,
  type AnalysisLeaseClaim,
  type AnalysisRunnerRegistration,
} from "./workspace-analysis-runs";
import type { AnalysisRunAuthority } from "./workspace-analysis-run-store";
import { canonicalHash } from "./workspace-versioning";

function memberLockKey(input: { organizationId: string; authority: AnalysisRunAuthority }) {
  return revocationGateLockKey({
    kind: "member",
    organizationId: input.organizationId,
    memberId: input.authority.membershipId,
    userId: input.authority.userId,
  });
}

export async function registerAnalysisRunner(input: {
  organizationId: string;
  registration: AnalysisRunnerRegistration;
  authority: AnalysisRunAuthority;
}) {
  const requestId = crypto.randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${memberLockKey(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN ${member} member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), stored AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisRunner} runner
        ("organization_id", "member_id", "device_id", "display_name",
         "background_allowed", "last_seen_at", "revoked_at")
      SELECT ${input.organizationId}, authority."id", ${input.registration.deviceId},
        ${input.registration.displayName}, ${input.registration.backgroundAllowed}, now(), NULL
      FROM authority
      ON CONFLICT ("organization_id", "device_id") DO UPDATE SET
        "display_name" = excluded."display_name",
        "background_allowed" = excluded."background_allowed",
        "last_seen_at" = now()
      WHERE runner."member_id" = excluded."member_id"
        AND runner."revoked_at" IS NULL
      RETURNING runner.*
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_runner.register',
        'analysis_runner', stored."id"::text,
        jsonb_build_object('backgroundAllowed', stored."background_allowed"), ${requestId}::uuid
      FROM stored RETURNING "resource_id"
    )
    SELECT stored."id"::text AS "id", stored."device_id" AS "deviceId",
      stored."display_name" AS "displayName",
      stored."background_allowed" AS "backgroundAllowed",
      stored."last_seen_at" AS "lastSeenAt"
    FROM stored JOIN audit ON audit."resource_id" = stored."id"::text
  `);
  const row = result.rows[0];
  const lastSeenAt = row?.lastSeenAt instanceof Date
    ? row.lastSeenAt : new Date(String(row?.lastSeenAt));
  return row && typeof row.id === "string" && typeof row.deviceId === "string"
    && typeof row.displayName === "string" && typeof row.backgroundAllowed === "boolean"
    && !Number.isNaN(lastSeenAt.valueOf())
    ? {
      id: row.id,
      deviceId: row.deviceId,
      displayName: row.displayName,
      backgroundAllowed: row.backgroundAllowed,
      lastSeenAt,
    }
    : null;
}

export async function revokeAnalysisRunner(input: {
  organizationId: string;
  runnerId: string;
  authority: AnalysisRunAuthority;
}) {
  const requestId = crypto.randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${memberLockKey(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN ${member} member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), revoked AS MATERIALIZED (
      UPDATE ${workspaceAnalysisRunner} runner
      SET "revoked_at" = now()
      FROM authority
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = ${input.runnerId}::uuid
        AND runner."member_id" = authority."id"
        AND runner."revoked_at" IS NULL
      RETURNING runner."id"
    ), stopped_articles AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticle} article
      SET "next_refresh_at" = NULL
      FROM revoked
      WHERE article."organization_id" = ${input.organizationId}
        AND article."deleted_at" IS NULL
        AND article."state" = 'live'
        AND article."definition"->'refresh'->>'mode' = 'scheduled'
        AND article."definition"->'refresh'->>'runnerId' = revoked."id"::text
      RETURNING article."id"
    ), revoked_leases AS MATERIALIZED (
      UPDATE ${workspaceAnalysisRefreshLease} lease
      SET "revoked_at" = COALESCE(lease."revoked_at", now())
      FROM revoked
      WHERE lease."organization_id" = ${input.organizationId}
        AND lease."runner_id" = revoked."id"
        AND lease."completed_at" IS NULL
        AND lease."revoked_at" IS NULL
      RETURNING lease."id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_runner.revoke',
        'analysis_runner', revoked."id"::text,
        jsonb_build_object(
          'scheduledArticleCount', (SELECT count(*) FROM stopped_articles),
          'activeLeaseCount', (SELECT count(*) FROM revoked_leases)
        ), ${requestId}::uuid
      FROM revoked
      RETURNING "resource_id"
    )
    SELECT revoked."id"::text AS "id",
      (SELECT count(*)::int FROM stopped_articles) AS "scheduledArticleCount",
      (SELECT count(*)::int FROM revoked_leases) AS "activeLeaseCount"
    FROM revoked JOIN audit ON audit."resource_id" = revoked."id"::text
  `);
  const row = result.rows[0];
  const scheduledArticleCount = Number(row?.scheduledArticleCount);
  const activeLeaseCount = Number(row?.activeLeaseCount);
  return row && typeof row.id === "string"
    && Number.isSafeInteger(scheduledArticleCount) && scheduledArticleCount >= 0
    && Number.isSafeInteger(activeLeaseCount) && activeLeaseCount >= 0
    ? { id: row.id, scheduledArticleCount, activeLeaseCount }
    : null;
}

function capabilityHash(capability: string) {
  return createHash("sha256").update(capability, "utf8").digest("hex");
}

export function hashAnalysisLeaseCapability(capability: string) {
  return capabilityHash(capability);
}

export async function claimAnalysisRefreshLease(input: {
  organizationId: string;
  claim: AnalysisLeaseClaim;
  authority: AnalysisRunAuthority;
}) {
  const candidates = await db.select({
    id: workspaceAnalysisArticle.id,
    liveRevision: workspaceAnalysisArticle.liveRevision,
    nextRefreshAt: workspaceAnalysisArticle.nextRefreshAt,
    payload: workspaceAnalysisArticleRevision.payload,
  }).from(workspaceAnalysisArticle).innerJoin(
    workspaceAnalysisArticleRevision,
    and(
      eq(workspaceAnalysisArticleRevision.organizationId, workspaceAnalysisArticle.organizationId),
      eq(workspaceAnalysisArticleRevision.articleId, workspaceAnalysisArticle.id),
      eq(workspaceAnalysisArticleRevision.revision, workspaceAnalysisArticle.liveRevision),
    ),
  ).where(and(
    eq(workspaceAnalysisArticle.organizationId, input.organizationId),
    isNull(workspaceAnalysisArticle.deletedAt),
    lte(workspaceAnalysisArticle.nextRefreshAt, new Date()),
  )).orderBy(asc(workspaceAnalysisArticle.nextRefreshAt)).limit(20);

  for (const candidate of candidates) {
    if (!candidate.liveRevision || !candidate.nextRefreshAt) continue;
    let article;
    try {
      article = parseAnalysisArticleVersionPayload(candidate.payload);
    } catch {
      continue;
    }
    if (article.deleted || article.definition.refresh.mode !== "scheduled"
      || article.definition.refresh.runnerId !== input.claim.runnerId) continue;
    const parameters = parseAnalysisParameterValues(article.definition, {});
    const parameterHash = canonicalHash(parameters);
    const nextRefreshAt = nextAnalysisRefreshAt(
      article.definition.refresh,
      new Date(),
    );
    if (!nextRefreshAt) continue;
    const capability = randomBytes(32).toString("hex");
    const leaseId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 120_000);
    const idempotencyKey = [
      candidate.id,
      candidate.liveRevision,
      candidate.nextRefreshAt.toISOString(),
    ].join(":");
    const requestId = crypto.randomUUID();
    const result = await db.execute<Record<string, unknown>>(sql`
      WITH authority_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended(${memberLockKey(input)}, 0))
      ), authority AS MATERIALIZED (
        SELECT member."id"
        FROM "workspace_control"."session" session
        JOIN ${member} member
          ON member."id" = ${input.authority.membershipId}
         AND member."organization_id" = ${input.organizationId}
         AND member."user_id" = ${input.authority.userId}
        JOIN authority_lock ON TRUE
        WHERE session."id" = ${input.authority.sessionId}
          AND session."user_id" = ${input.authority.userId}
          AND session."expires_at" > now()
          AND member."role" = ${input.authority.role}
          AND member."revocation_pending_at" IS NULL
          AND member."revocation_claim_id" IS NULL
        FOR UPDATE OF session, member
      ), runner_authority AS MATERIALIZED (
        UPDATE ${workspaceAnalysisRunner} runner
        SET "last_seen_at" = now()
        FROM authority
        WHERE runner."organization_id" = ${input.organizationId}
          AND runner."id" = ${input.claim.runnerId}::uuid
          AND runner."member_id" = authority."id"
          AND runner."device_id" = ${input.claim.deviceId}
          AND (${input.claim.background} = FALSE OR runner."background_allowed" = TRUE)
          AND runner."revoked_at" IS NULL
        RETURNING runner."id"
      ), current AS MATERIALIZED (
        SELECT article."id"
        FROM ${workspaceAnalysisArticle} article
        JOIN ${workspaceAnalysisArticleRevision} revision
          ON revision."organization_id" = article."organization_id"
         AND revision."article_id" = article."id"
         AND revision."revision" = article."live_revision"
        JOIN runner_authority ON TRUE
        WHERE article."organization_id" = ${input.organizationId}
          AND article."id" = ${candidate.id}::uuid
          AND article."live_revision" = ${candidate.liveRevision}
          AND article."next_refresh_at" = ${candidate.nextRefreshAt}
          AND article."deleted_at" IS NULL
          AND revision."payload_hash" = ${canonicalHash(candidate.payload)}
        FOR UPDATE OF article, revision
      ), connection_authority AS MATERIALIZED (
        SELECT pin."connection_id"
        FROM ${workspaceAnalysisArticleConnection} pin
        JOIN ${workspaceConnection} connection
          ON connection."organization_id" = pin."organization_id"
         AND connection."id" = pin."connection_id"
         AND connection."revision" = pin."connection_revision"
         AND connection."deleted_at" IS NULL
         AND connection."revocation_pending_at" IS NULL
        JOIN ${workspaceConnectionGrant} grant_record
          ON grant_record."organization_id" = connection."organization_id"
         AND grant_record."connection_id" = connection."id"
         AND grant_record."member_id" = ${input.authority.membershipId}
         AND grant_record."capability" IN ('use', 'manage')
        JOIN current ON current."id" = pin."article_id"
        WHERE pin."organization_id" = ${input.organizationId}
          AND pin."article_id" = ${candidate.id}::uuid
          AND pin."article_revision" = ${candidate.liveRevision}
        FOR UPDATE OF connection, grant_record
      ), inserted AS MATERIALIZED (
        INSERT INTO ${workspaceAnalysisRefreshLease}
          ("id", "organization_id", "article_id", "article_revision", "runner_id",
           "idempotency_key", "parameter_hash", "lease_capability_hash", "scheduled_at",
           "expires_at")
        SELECT ${leaseId}::uuid, ${input.organizationId}, ${candidate.id}::uuid,
          ${candidate.liveRevision}, runner_authority."id", ${idempotencyKey},
          ${parameterHash}, ${capabilityHash(capability)}, ${candidate.nextRefreshAt}, ${expiresAt}
        FROM runner_authority JOIN current ON TRUE
        WHERE (SELECT count(*) FROM connection_authority) = (
          SELECT count(*) FROM ${workspaceAnalysisArticleConnection} pin
          WHERE pin."organization_id" = ${input.organizationId}
            AND pin."article_id" = ${candidate.id}::uuid
            AND pin."article_revision" = ${candidate.liveRevision}
        )
        ON CONFLICT ("organization_id", "idempotency_key") DO NOTHING
        RETURNING *
      ), advanced AS MATERIALIZED (
        UPDATE ${workspaceAnalysisArticle} article
        SET "next_refresh_at" = ${nextRefreshAt}
        FROM inserted
        WHERE article."organization_id" = inserted."organization_id"
          AND article."id" = inserted."article_id"
          AND article."next_refresh_at" = inserted."scheduled_at"
        RETURNING article."id"
      ), audit AS MATERIALIZED (
        INSERT INTO ${workspaceAuditEvent}
          ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
           "redacted_summary", "request_id")
        SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_refresh.lease',
          'analysis_refresh_lease', inserted."id"::text,
          jsonb_build_object('articleId', inserted."article_id", 'articleRevision',
            inserted."article_revision", 'scheduledAt', inserted."scheduled_at"),
          ${requestId}::uuid
        FROM inserted JOIN advanced ON TRUE RETURNING "resource_id"
      )
      SELECT inserted."id"::text AS "id", inserted."article_id"::text AS "articleId",
        inserted."article_revision" AS "articleRevision",
        inserted."runner_id"::text AS "runnerId", inserted."scheduled_at" AS "scheduledAt",
        inserted."expires_at" AS "expiresAt"
      FROM inserted JOIN audit ON audit."resource_id" = inserted."id"::text
    `);
    const row = result.rows[0];
    if (row && typeof row.id === "string" && typeof row.articleId === "string") {
      return {
        id: row.id,
        articleId: row.articleId,
        articleRevision: Number(row.articleRevision),
        runnerId: String(row.runnerId),
        scheduledAt: row.scheduledAt instanceof Date
          ? row.scheduledAt : new Date(String(row.scheduledAt)),
        expiresAt: row.expiresAt instanceof Date
          ? row.expiresAt : new Date(String(row.expiresAt)),
        capability,
        parameterValues: parameters,
        article,
      };
    }
  }
  return null;
}
