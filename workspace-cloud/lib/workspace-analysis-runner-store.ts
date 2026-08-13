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
  workspaceAnalysisArticleQueryReceipt,
  workspaceAnalysisArticleRun,
  workspaceAnalysisArticleRevision,
  workspaceAnalysisRefreshLease,
  workspaceAnalysisResultFragment,
  workspaceAnalysisRunner,
  workspaceAnalysisSignal,
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
import {
  analysisRunnerCapabilityVersion,
  hashAnalysisRunnerCapability,
  issueAnalysisRunnerCapability,
} from "./workspace-analysis-runner-capability";
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
  runnerCapability: string | null;
  capabilityVersion: number | null;
  authority: AnalysisRunAuthority;
}) {
  if (input.runnerCapability && !/^[0-9a-f]{64}$/.test(input.runnerCapability)) {
    return { status: "invalid" } as const;
  }
  if (input.capabilityVersion !== analysisRunnerCapabilityVersion) {
    return { status: "unsupported" } as const;
  }
  const issuedCapability = issueAnalysisRunnerCapability();
  const issuedCapabilityHash = hashAnalysisRunnerCapability(issuedCapability);
  const providedCapabilityHash = input.runnerCapability
    ? hashAnalysisRunnerCapability(input.runnerCapability)
    : null;
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
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisRunner} AS inserted_runner
        ("organization_id", "member_id", "device_id", "display_name",
         "runner_capability_hash", "runner_capability_generation",
         "background_allowed", "last_seen_at", "revoked_at")
      SELECT ${input.organizationId}, authority."id", ${input.registration.deviceId},
        ${input.registration.displayName}, ${issuedCapabilityHash}, 1,
        ${input.registration.backgroundAllowed}, now(), NULL
      FROM authority
      WHERE NOT EXISTS (
        SELECT 1 FROM ${workspaceAnalysisRunner} historical
        WHERE historical."organization_id" = ${input.organizationId}
          AND historical."device_id" = ${input.registration.deviceId}
      )
      ON CONFLICT ("organization_id", "device_id") WHERE "revoked_at" IS NULL DO NOTHING
      RETURNING inserted_runner.*
    ), verified AS MATERIALIZED (
      UPDATE ${workspaceAnalysisRunner} runner
      SET "display_name" = ${input.registration.displayName},
        "background_allowed" = ${input.registration.backgroundAllowed},
        "last_seen_at" = now()
      FROM authority
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."device_id" = ${input.registration.deviceId}
        AND runner."member_id" = authority."id"
        AND runner."revoked_at" IS NULL
        AND runner."runner_capability_hash" = ${providedCapabilityHash}
        AND runner."runner_capability_generation" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM inserted)
      RETURNING runner.*
    ), stored AS MATERIALIZED (
      SELECT inserted.*, TRUE AS "created" FROM inserted
      UNION ALL
      SELECT verified.*, FALSE AS "created" FROM verified
    ), conflict AS MATERIALIZED (
      SELECT CASE
          WHEN runner."member_id" = authority."id"
            AND runner."revoked_at" IS NOT NULL THEN 'replacement_required'
          WHEN runner."member_id" = authority."id"
            AND (runner."runner_capability_hash" IS NULL
              OR runner."runner_capability_generation" IS NULL) THEN 'unbound'
          WHEN runner."member_id" = authority."id"
            AND ${providedCapabilityHash}::text IS NULL THEN 'missing'
          ELSE 'invalid'
        END AS "status"
      FROM ${workspaceAnalysisRunner} runner
      JOIN authority ON TRUE
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."device_id" = ${input.registration.deviceId}
        AND NOT EXISTS (SELECT 1 FROM stored)
      LIMIT 1
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_runner.register',
        'analysis_runner', stored."id"::text,
        jsonb_build_object('backgroundAllowed', stored."background_allowed",
          'capabilityGeneration', stored."runner_capability_generation",
          'created', stored."created"), ${requestId}::uuid
      FROM stored RETURNING "resource_id"
    )
    SELECT CASE WHEN stored."created" THEN 'created' ELSE 'verified' END AS "status",
      stored."id"::text AS "id", stored."device_id" AS "deviceId",
      stored."display_name" AS "displayName",
      stored."background_allowed" AS "backgroundAllowed",
      stored."runner_capability_generation"::double precision AS "runnerCapabilityGeneration",
      stored."created" AS "created",
      stored."last_seen_at" AS "lastSeenAt"
    FROM stored JOIN audit ON audit."resource_id" = stored."id"::text
    UNION ALL
    SELECT conflict."status", NULL, NULL, NULL, NULL, NULL, NULL, NULL
    FROM conflict
  `);
  const row = result.rows[0];
  if (row?.status === "missing" || row?.status === "unbound"
    || row?.status === "replacement_required" || row?.status === "invalid"
    || row?.status === "unsupported") {
    return { status: row.status } as const;
  }
  const lastSeenAt = row?.lastSeenAt instanceof Date
    ? row.lastSeenAt : new Date(String(row?.lastSeenAt));
  return row && typeof row.id === "string" && typeof row.deviceId === "string"
    && typeof row.displayName === "string" && typeof row.backgroundAllowed === "boolean"
    && (row.status === "created" || row.status === "verified")
    && Number.isSafeInteger(Number(row.runnerCapabilityGeneration))
    && Number(row.runnerCapabilityGeneration) >= 1
    && !Number.isNaN(lastSeenAt.valueOf())
    ? {
      status: row.status,
      id: row.id,
      deviceId: row.deviceId,
      displayName: row.displayName,
      backgroundAllowed: row.backgroundAllowed,
      runnerCapabilityGeneration: Number(row.runnerCapabilityGeneration),
      runnerCapability: row.status === "created" ? issuedCapability : null,
      lastSeenAt,
    }
    : row ? ({ status: "invalid" } as const) : null;
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
    ), stopped_runs AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticleRun} run
      SET "state" = 'stale', "finished_at" = now(),
        "error_kind" = 'runner_revoked',
        "error_message" = 'The Desktop runner was revoked before this run completed.'
      FROM revoked
      WHERE run."organization_id" = ${input.organizationId}
        AND run."runner_id" = revoked."id"
        AND run."state" IN ('queued', 'running')
      RETURNING run."id"
    ), discarded_fragments AS MATERIALIZED (
      DELETE FROM ${workspaceAnalysisResultFragment} fragment
      USING stopped_runs
      WHERE fragment."organization_id" = ${input.organizationId}
        AND fragment."run_id" = stopped_runs."id"
      RETURNING fragment."run_id"
    ), discarded_receipts AS MATERIALIZED (
      DELETE FROM ${workspaceAnalysisArticleQueryReceipt} receipt
      USING stopped_runs
      WHERE receipt."organization_id" = ${input.organizationId}
        AND receipt."run_id" = stopped_runs."id"
      RETURNING receipt."run_id"
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
          'activeLeaseCount', (SELECT count(*) FROM revoked_leases),
          'activeRunCount', (SELECT count(*) FROM stopped_runs),
          'discardedFragmentCount', (SELECT count(*) FROM discarded_fragments),
          'discardedReceiptCount', (SELECT count(*) FROM discarded_receipts)
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

/**
 * Remove a workspace member without deleting the historical Desktop runner or
 * its terminal evidence. The target revocation gate must already be claimed;
 * this transaction closes every runner-owned active resource before the member
 * foreign key clears runner ownership.
 */
export async function removeMemberAfterAnalysisRunnerCleanup(input: {
  organizationId: string;
  target: {
    memberId: string;
    userId: string;
    role: AnalysisRunAuthority["role"];
    claimId: string;
  };
  externalLeaseRevocation: { revoked: number; deferred: number };
  authority: AnalysisRunAuthority;
}) {
  const [actorGateLock, targetGateLock = actorGateLock] = [...new Set([
    memberLockKey(input),
    revocationGateLockKey({
      kind: "member",
      organizationId: input.organizationId,
      memberId: input.target.memberId,
      userId: input.target.userId,
    }),
  ])].sort();
  const requestId = crypto.randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH actor_gate_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${actorGateLock}, 0))
    ), target_gate_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${targetGateLock}, 0))
      FROM actor_gate_lock
    ), actor_authority AS MATERIALIZED (
      SELECT actor_member."id"
      FROM "workspace_control"."session" actor_session
      JOIN ${member} actor_member
        ON actor_member."id" = ${input.authority.membershipId}
       AND actor_member."organization_id" = ${input.organizationId}
       AND actor_member."user_id" = ${input.authority.userId}
      JOIN actor_gate_lock ON TRUE
      JOIN target_gate_lock ON TRUE
      WHERE actor_session."id" = ${input.authority.sessionId}
        AND actor_session."user_id" = ${input.authority.userId}
        AND actor_session."expires_at" > now()
        AND actor_member."role" = ${input.authority.role}
        AND actor_member."role" IN ('admin', 'owner')
        AND actor_member."revocation_pending_at" IS NULL
        AND actor_member."revocation_claim_id" IS NULL
      FOR UPDATE OF actor_session, actor_member
    ), target_authority AS MATERIALIZED (
      SELECT target."id", target."organization_id", target."role"
      FROM ${member} target
      JOIN actor_authority ON TRUE
      WHERE target."id" = ${input.target.memberId}
        AND target."organization_id" = ${input.organizationId}
        AND target."user_id" = ${input.target.userId}
        AND target."role" = ${input.target.role}
        AND target."role" <> 'owner'
        AND target."revocation_claim_id" = ${input.target.claimId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceAnalysisArticle} owned_article
          WHERE owned_article."organization_id" = target."organization_id"
            AND owned_article."owner_member_id" = target."id"
            AND owned_article."deleted_at" IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceAnalysisSignal} active_signal
          WHERE active_signal."organization_id" = target."organization_id"
            AND active_signal."enabled" = TRUE
            AND active_signal."deleted_at" IS NULL
            AND COALESCE(
              active_signal."definition"->'recipientMemberIds' ? target."id",
              FALSE
            )
        )
      FOR UPDATE OF target
    ), target_runners AS MATERIALIZED (
      SELECT runner."id"
      FROM ${workspaceAnalysisRunner} runner
      JOIN target_authority
        ON runner."organization_id" = target_authority."organization_id"
       AND runner."member_id" = target_authority."id"
      FOR UPDATE OF runner
    ), revoked_runners AS MATERIALIZED (
      UPDATE ${workspaceAnalysisRunner} runner
      SET "revoked_at" = COALESCE(runner."revoked_at", now())
      FROM target_runners
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = target_runners."id"
      RETURNING runner."id"
    ), stopped_articles AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticle} article
      SET "next_refresh_at" = NULL
      FROM revoked_runners
      WHERE article."organization_id" = ${input.organizationId}
        AND article."deleted_at" IS NULL
        AND article."definition"->'refresh'->>'mode' = 'scheduled'
        AND article."definition"->'refresh'->>'runnerId' = revoked_runners."id"::text
      RETURNING article."id"
    ), stopped_runs AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticleRun} run
      SET "state" = 'stale', "finished_at" = now(),
        "error_kind" = 'runner_revoked',
        "error_message" = 'The Desktop runner owner was removed before this run completed.'
      FROM revoked_runners
      WHERE run."organization_id" = ${input.organizationId}
        AND run."runner_id" = revoked_runners."id"
        AND run."state" IN ('queued', 'running')
      RETURNING run."id"
    ), discarded_fragments AS MATERIALIZED (
      DELETE FROM ${workspaceAnalysisResultFragment} fragment
      USING stopped_runs
      WHERE fragment."organization_id" = ${input.organizationId}
        AND fragment."run_id" = stopped_runs."id"
      RETURNING fragment."run_id"
    ), discarded_receipts AS MATERIALIZED (
      DELETE FROM ${workspaceAnalysisArticleQueryReceipt} receipt
      USING stopped_runs
      WHERE receipt."organization_id" = ${input.organizationId}
        AND receipt."run_id" = stopped_runs."id"
      RETURNING receipt."run_id"
    ), revoked_leases AS MATERIALIZED (
      UPDATE ${workspaceAnalysisRefreshLease} lease
      SET "revoked_at" = COALESCE(lease."revoked_at", now())
      FROM revoked_runners
      WHERE lease."organization_id" = ${input.organizationId}
        AND lease."runner_id" = revoked_runners."id"
        AND lease."completed_at" IS NULL
        AND lease."revoked_at" IS NULL
      RETURNING lease."id"
    ), cleanup_barrier AS MATERIALIZED (
      SELECT
        (SELECT count(*)::int FROM revoked_runners) AS "runnerCount",
        (SELECT count(*)::int FROM stopped_articles) AS "scheduledArticleCount",
        (SELECT count(*)::int FROM stopped_runs) AS "activeRunCount",
        (SELECT count(*)::int FROM discarded_fragments) AS "discardedFragmentCount",
        (SELECT count(*)::int FROM discarded_receipts) AS "discardedReceiptCount",
        (SELECT count(*)::int FROM revoked_leases) AS "activeLeaseCount"
    ), deleted_member AS MATERIALIZED (
      DELETE FROM ${member} target
      USING target_authority, cleanup_barrier
      WHERE target."id" = target_authority."id"
        AND target."organization_id" = target_authority."organization_id"
      RETURNING target."id", target."organization_id", target."role"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT deleted_member."organization_id", ${input.authority.userId},
        'member.remove', 'member', deleted_member."id",
        jsonb_build_object(
          'previousRole', deleted_member."role",
          'revokedLeases', ${input.externalLeaseRevocation.revoked}::integer,
          'deferredRevocations', ${input.externalLeaseRevocation.deferred}::integer,
          'analysisRunnerCount', cleanup_barrier."runnerCount",
          'analysisScheduledArticleCount', cleanup_barrier."scheduledArticleCount",
          'analysisActiveRunCount', cleanup_barrier."activeRunCount",
          'analysisDiscardedFragmentCount', cleanup_barrier."discardedFragmentCount",
          'analysisDiscardedReceiptCount', cleanup_barrier."discardedReceiptCount",
          'analysisActiveLeaseCount', cleanup_barrier."activeLeaseCount"
        ), ${requestId}::uuid
      FROM deleted_member CROSS JOIN cleanup_barrier
      RETURNING "resource_id"
    )
    SELECT deleted_member."id"::text AS "id",
      cleanup_barrier."runnerCount", cleanup_barrier."scheduledArticleCount",
      cleanup_barrier."activeRunCount", cleanup_barrier."discardedFragmentCount",
      cleanup_barrier."discardedReceiptCount", cleanup_barrier."activeLeaseCount"
    FROM deleted_member CROSS JOIN cleanup_barrier
    JOIN audit ON audit."resource_id" = deleted_member."id"
  `);
  const row = result.rows[0];
  if (!row || typeof row.id !== "string") return null;
  const counts = {
    runnerCount: Number(row.runnerCount),
    scheduledArticleCount: Number(row.scheduledArticleCount),
    activeRunCount: Number(row.activeRunCount),
    discardedFragmentCount: Number(row.discardedFragmentCount),
    discardedReceiptCount: Number(row.discardedReceiptCount),
    activeLeaseCount: Number(row.activeLeaseCount),
  };
  return Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0)
    ? { id: row.id, ...counts }
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
  runnerCapabilityHash: string;
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
          AND runner."runner_capability_hash" = ${input.runnerCapabilityHash}
          AND runner."runner_capability_generation" IS NOT NULL
        RETURNING runner."id", runner."runner_capability_generation"
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
           "runner_capability_generation", "idempotency_key", "parameter_hash",
           "lease_capability_hash", "scheduled_at", "expires_at")
        SELECT ${leaseId}::uuid, ${input.organizationId}, ${candidate.id}::uuid,
          ${candidate.liveRevision}, runner_authority."id",
          runner_authority."runner_capability_generation", ${idempotencyKey},
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
        inserted."expires_at" AS "expiresAt",
        inserted."runner_capability_generation"::double precision AS "runnerCapabilityGeneration"
      FROM inserted JOIN audit ON audit."resource_id" = inserted."id"::text
    `);
    const row = result.rows[0];
    const runnerCapabilityGeneration = Number(row?.runnerCapabilityGeneration);
    if (row && typeof row.id === "string" && typeof row.articleId === "string"
      && Number.isSafeInteger(runnerCapabilityGeneration) && runnerCapabilityGeneration >= 1) {
      return {
        id: row.id,
        articleId: row.articleId,
        articleRevision: Number(row.articleRevision),
        runnerId: String(row.runnerId),
        runnerCapabilityGeneration,
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
