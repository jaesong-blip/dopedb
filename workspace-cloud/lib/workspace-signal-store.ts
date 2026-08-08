// Atomic authorization and persistence for local signal monitoring. The cloud
// owns scheduling metadata only; no statement or evaluated metric crosses this
// boundary.
import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "./db";
import {
  knowledgeEnvironmentConnection,
  knowledgeProjectEnvironment,
  member,
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceFunnelAnalysis,
  workspaceFunnelAnalysisConnection,
  workspaceSignalRule,
  workspaceSignalRuleConnection,
  workspaceSignalRuleRevision,
  workspaceSignalEvaluationReceipt,
  workspaceSignalNotification,
  workspaceSignalRunner,
  workspaceSignalRunnerLease,
} from "./schema";
import type { DashboardMutationAuthority } from "./workspace-dashboard-store";
import {
  nextSignalEvaluationAt,
  type SignalLeaseClaim,
  type SignalEvaluationReceiptInput,
  type SignalRuleMutation,
  type SignalRuleCreate,
  type SignalRunnerRegistration,
} from "./workspace-signals";
import { canonicalHash } from "./workspace-versioning";

export type StoredSignalRunner = Readonly<{
  id: string;
  deviceId: string;
  displayName: string;
  backgroundAllowed: boolean;
  lastSeenAt: Date;
}>;

export type StoredSignalRule = Readonly<{
  id: string;
  revision: number;
  enabled: boolean;
}>;

export type ClaimedSignalLease = Readonly<{
  id: string;
  capability: string;
  expiresAt: Date;
  scheduledAt: Date;
  ruleId: string;
  ruleRevision: number;
  projectEnvironmentId: string;
  environmentRevision: number;
  ruleDefinition: Readonly<Record<string, unknown>>;
  analysisDefinition: Readonly<Record<string, unknown>>;
  connectionIds: readonly string[];
  nextTransitionSequence: number;
}>;

export type StoredSignalEvaluationReceipt = Readonly<{
  id: string;
  state: string;
  notificationState: "none" | "pending" | "suppressed";
  transitionSequence: number;
}>;

export type MutatedSignalRule = Readonly<{
  id: string;
  revision: number;
  status: "active" | "paused" | "disabled";
  enabled: boolean;
  nextEvaluationAt: Date;
}>;

function authorityLockKey(input: { organizationId: string; authority: DashboardMutationAuthority }) {
  return `signal:${input.organizationId}:${input.authority.membershipId}:${input.authority.userId}`;
}

export async function registerSignalRunner(input: {
  organizationId: string;
  registration: SignalRunnerRegistration;
  authority: DashboardMutationAuthority;
}): Promise<StoredSignalRunner | null> {
  const requestId = crypto.randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${authorityLockKey(input)}, 0))
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
      INSERT INTO ${workspaceSignalRunner} runner
        ("organization_id", "member_id", "device_id", "display_name",
         "background_allowed", "last_seen_at", "revoked_at")
      SELECT ${input.organizationId}, authority."id", ${input.registration.deviceId},
        ${input.registration.displayName}, ${input.registration.backgroundAllowed}, now(), NULL
      FROM authority
      ON CONFLICT ("organization_id", "device_id") DO UPDATE SET
        "display_name" = excluded."display_name",
        "background_allowed" = excluded."background_allowed",
        "last_seen_at" = now(),
        "revoked_at" = NULL
      WHERE runner."member_id" = excluded."member_id"
      RETURNING runner.*
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'signal.runner.registered',
        'signal_runner', stored."id"::text,
        jsonb_build_object('backgroundAllowed', stored."background_allowed"),
        ${requestId}::uuid
      FROM stored
    )
    SELECT stored."id"::text AS "id", stored."device_id" AS "deviceId",
      stored."display_name" AS "displayName",
      stored."background_allowed" AS "backgroundAllowed",
      stored."last_seen_at" AS "lastSeenAt"
    FROM stored
  `);
  const row = result.rows[0];
  const seen = row?.lastSeenAt instanceof Date ? row.lastSeenAt : new Date(String(row?.lastSeenAt));
  if (!row || typeof row.id !== "string" || typeof row.deviceId !== "string"
    || typeof row.displayName !== "string" || typeof row.backgroundAllowed !== "boolean"
    || Number.isNaN(seen.valueOf())) return null;
  return {
    id: row.id,
    deviceId: row.deviceId,
    displayName: row.displayName,
    backgroundAllowed: row.backgroundAllowed,
    lastSeenAt: seen,
  };
}

export async function commitSignalRuleCreate(input: {
  organizationId: string;
  rule: SignalRuleCreate;
  authority: DashboardMutationAuthority;
}): Promise<StoredSignalRule | null> {
  const requestedConnections = input.rule.connections.map((connection) => ({
    connection_id: connection.connectionId,
    connection_revision: connection.connectionRevision,
  }));
  const productionApproval = input.rule.productionConfirmed
    ? input.authority.membershipId : null;
  const productionApprovedAt = productionApproval ? new Date() : null;
  const nextEvaluationAt = nextSignalEvaluationAt(
    input.rule.schedule,
    input.rule.timezone,
    new Date(),
  );
  const definition = {
    schemaVersion: 1,
    ruleId: input.rule.id,
    projectEnvironmentId: input.rule.projectEnvironmentId,
    environmentRevision: input.rule.environmentRevision,
    sourceAnalysisId: input.rule.sourceAnalysisId,
    sourceAnalysisRevision: input.rule.sourceAnalysisRevision,
    sourceTileId: input.rule.sourceTileId,
    metricSemanticId: input.rule.metricSemanticId,
    connectionIds: input.rule.connections.map((connection) => connection.connectionId),
    schedule: input.rule.schedule,
    timezone: input.rule.timezone,
    evaluationWindowSeconds: input.rule.evaluationWindowSeconds,
    condition: input.rule.condition,
    baselineWindowSeconds: input.rule.baselineWindowSeconds,
    minimumSampleCount: input.rule.minimumSampleCount,
    cooldownSeconds: input.rule.cooldownSeconds,
    rearmAfterNormalCount: input.rule.rearmAfterNormalCount,
    severity: input.rule.severity,
    recipientMemberIds: input.rule.recipientMemberIds,
    channels: input.rule.channels,
    enabled: input.rule.enabled,
    revision: 1,
    productionApprovedByMemberId: productionApproval,
    productionApprovedAt: productionApprovedAt?.toISOString() ?? null,
  };
  const payloadHash = canonicalHash(definition);
  const requestId = crypto.randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${authorityLockKey(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id", member."role"
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
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), environment AS MATERIALIZED (
      SELECT environment.*
      FROM ${knowledgeProjectEnvironment} environment
      JOIN authority ON TRUE
      WHERE environment."organization_id" = ${input.organizationId}
        AND environment."id" = ${input.rule.projectEnvironmentId}::uuid
        AND environment."revision" = ${input.rule.environmentRevision}
        AND (environment."risk_class" <> 'production'
          OR (authority."role" IN ('admin', 'owner') AND ${input.rule.productionConfirmed}))
      FOR UPDATE OF environment
    ), analysis AS MATERIALIZED (
      SELECT analysis."id"
      FROM ${workspaceFunnelAnalysis} analysis
      JOIN environment
        ON environment."id" = analysis."project_environment_id"
       AND environment."revision" = analysis."environment_revision"
      WHERE analysis."organization_id" = ${input.organizationId}
        AND analysis."id" = ${input.rule.sourceAnalysisId}::uuid
        AND analysis."revision" = ${input.rule.sourceAnalysisRevision}
        AND analysis."state" = 'published'
        AND analysis."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(analysis."definition"->'tiles') tile
          WHERE tile->>'id' = ${input.rule.sourceTileId}
            AND tile->>'kind' = 'metric'
        )
      FOR UPDATE OF analysis
    ), runner AS MATERIALIZED (
      SELECT runner."id"
      FROM ${workspaceSignalRunner} runner
      JOIN authority ON authority."id" = runner."member_id"
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = ${input.rule.runnerId}::uuid
        AND runner."revoked_at" IS NULL
        AND (NOT ${input.rule.enabled} OR runner."last_seen_at" > now() - interval '2 minutes')
      FOR UPDATE OF runner
    ), selected_runner AS MATERIALIZED (
      SELECT runner."id" FROM runner
      UNION ALL
      SELECT NULL::uuid WHERE ${input.rule.runnerId}::text IS NULL AND NOT ${input.rule.enabled}
    ), requested_connection AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(requestedConnections)}::jsonb)
        AS requested(connection_id uuid, connection_revision bigint)
    ), connection_authority AS MATERIALIZED (
      SELECT requested.connection_id, requested.connection_revision
      FROM requested_connection requested
      JOIN environment ON TRUE
      JOIN ${knowledgeEnvironmentConnection} binding
        ON binding."organization_id" = ${input.organizationId}
       AND binding."project_environment_id" = environment."id"
       AND binding."environment_revision" = environment."revision"
       AND binding."connection_id" = requested.connection_id
       AND binding."connection_revision" = requested.connection_revision
       AND binding."revoked_at" IS NULL
      JOIN ${workspaceConnection} connection
        ON connection."organization_id" = binding."organization_id"
       AND connection."id" = binding."connection_id"
       AND connection."revision" = binding."connection_revision"
       AND connection."readonly_default" = TRUE
       AND connection."allow_writes" = FALSE
       AND connection."deleted_at" IS NULL
       AND connection."revocation_pending_at" IS NULL
      JOIN ${workspaceConnectionGrant} grant
        ON grant."organization_id" = connection."organization_id"
       AND grant."connection_id" = connection."id"
       AND grant."member_id" = ${input.authority.membershipId}
       AND grant."capability" IN ('use', 'manage')
      JOIN analysis ON TRUE
      JOIN ${workspaceFunnelAnalysisConnection} analysis_connection
        ON analysis_connection."organization_id" = ${input.organizationId}
       AND analysis_connection."analysis_id" = analysis."id"
       AND analysis_connection."connection_id" = connection."id"
       AND analysis_connection."connection_revision" = connection."revision"
      FOR UPDATE OF binding, connection, grant
    ), requested_recipient AS MATERIALIZED (
      SELECT value AS member_id
      FROM jsonb_array_elements_text(${JSON.stringify(input.rule.recipientMemberIds)}::jsonb)
    ), recipient_authority AS MATERIALIZED (
      SELECT recipient."id"
      FROM requested_recipient requested
      JOIN ${member} recipient ON recipient."id" = requested.member_id
      JOIN authority ON TRUE
      WHERE recipient."organization_id" = ${input.organizationId}
        AND recipient."revocation_pending_at" IS NULL
        AND recipient."revocation_claim_id" IS NULL
      FOR UPDATE OF recipient
    ), stored AS MATERIALIZED (
      INSERT INTO ${workspaceSignalRule} rule
        ("id", "organization_id", "project_environment_id", "environment_revision",
         "source_analysis_id", "source_analysis_revision", "source_tile_id",
         "metric_semantic_id", "definition", "owner_member_id", "runner_id",
         "enabled", "status", "revision", "production_approved_by_member_id",
         "production_approved_at", "next_evaluation_at")
      SELECT ${input.rule.id}::uuid, ${input.organizationId}, environment."id",
        environment."revision", analysis."id", ${input.rule.sourceAnalysisRevision},
        ${input.rule.sourceTileId}, ${input.rule.metricSemanticId},
        ${JSON.stringify(definition)}::jsonb, authority."id", selected_runner."id",
        ${input.rule.enabled}, ${input.rule.enabled ? "active" : "disabled"}, 1,
        ${productionApproval}, ${productionApprovedAt},
        ${nextEvaluationAt}
      FROM authority, environment, analysis, selected_runner
      WHERE (SELECT count(*) FROM connection_authority) = ${requestedConnections.length}
        AND (SELECT count(*) FROM recipient_authority) = ${input.rule.recipientMemberIds.length}
      RETURNING rule.*
    ), stored_connections AS MATERIALIZED (
      INSERT INTO ${workspaceSignalRuleConnection}
        ("organization_id", "rule_id", "connection_id", "connection_revision")
      SELECT ${input.organizationId}, stored."id", connection_authority.connection_id,
        connection_authority.connection_revision
      FROM stored CROSS JOIN connection_authority
    ), stored_revision AS MATERIALIZED (
      INSERT INTO ${workspaceSignalRuleRevision}
        ("organization_id", "rule_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_member_id")
      SELECT ${input.organizationId}, stored."id", 1, 0, 'create',
        ${JSON.stringify(definition)}::jsonb, ${payloadHash}, authority."id"
      FROM stored CROSS JOIN authority
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'signal.rule.created',
        'signal_rule', stored."id"::text,
        jsonb_build_object('environmentId', stored."project_environment_id",
          'connectionCount', ${requestedConnections.length}, 'enabled', stored."enabled"),
        ${requestId}::uuid
      FROM stored
    )
    SELECT stored."id"::text AS "id", stored."revision" AS "revision",
      stored."enabled" AS "enabled"
    FROM stored
  `);
  const row = result.rows[0];
  const revision = Number(row?.revision);
  if (!row || typeof row.id !== "string" || !Number.isSafeInteger(revision)
    || revision < 1 || typeof row.enabled !== "boolean") return null;
  return { id: row.id, revision, enabled: row.enabled };
}

/**
 * Claim one due rule for a member-owned runner. The raw capability is returned
 * once and only its SHA-256 digest is persisted. Every authority edge is
 * rechecked in the same statement that creates the short lease.
 */
export async function claimSignalRunnerLease(input: {
  organizationId: string;
  claim: SignalLeaseClaim;
  authority: DashboardMutationAuthority;
}): Promise<ClaimedSignalLease | null> {
  const candidateResult = await db.execute<Record<string, unknown>>(sql`
    WITH authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN ${member} member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
    ), runner AS MATERIALIZED (
      UPDATE ${workspaceSignalRunner} runner SET "last_seen_at" = now()
      FROM authority
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = ${input.claim.runnerId}::uuid
        AND runner."member_id" = authority."id"
        AND runner."device_id" = ${input.claim.deviceId}
        AND runner."revoked_at" IS NULL
        AND (NOT ${input.claim.background} OR runner."background_allowed")
      RETURNING runner."id"
    )
    SELECT rule."id"::text AS "ruleId", rule."revision" AS "ruleRevision",
      rule."project_environment_id"::text AS "projectEnvironmentId",
      rule."environment_revision" AS "environmentRevision",
      rule."next_evaluation_at" AS "nextEvaluationAt",
      rule."definition" AS "ruleDefinition",
      analysis."definition" AS "analysisDefinition",
      COALESCE((SELECT max(receipt."transition_sequence")
        FROM ${workspaceSignalEvaluationReceipt} receipt
        WHERE receipt."organization_id" = rule."organization_id"
          AND receipt."rule_id" = rule."id"
          AND receipt."rule_revision" = rule."revision"), 0) + 1
        AS "nextTransitionSequence",
      COALESCE(jsonb_agg(rule_connection."connection_id"::text
        ORDER BY rule_connection."connection_id"), '[]'::jsonb) AS "connectionIds"
    FROM ${workspaceSignalRule} rule
    JOIN runner ON runner."id" = rule."runner_id"
    JOIN ${knowledgeProjectEnvironment} environment
      ON environment."organization_id" = rule."organization_id"
     AND environment."id" = rule."project_environment_id"
     AND environment."revision" = rule."environment_revision"
    JOIN ${workspaceFunnelAnalysis} analysis
      ON analysis."organization_id" = rule."organization_id"
     AND analysis."id" = rule."source_analysis_id"
     AND analysis."revision" = rule."source_analysis_revision"
     AND analysis."state" = 'published'
     AND analysis."deleted_at" IS NULL
    JOIN ${workspaceSignalRuleConnection} rule_connection
      ON rule_connection."organization_id" = rule."organization_id"
     AND rule_connection."rule_id" = rule."id"
    WHERE rule."organization_id" = ${input.organizationId}
      AND rule."enabled"
      AND rule."deleted_at" IS NULL
      AND rule."next_evaluation_at" <= now()
      AND NOT EXISTS (
        SELECT 1 FROM ${workspaceSignalRunnerLease} active_lease
        WHERE active_lease."organization_id" = rule."organization_id"
          AND active_lease."rule_id" = rule."id"
          AND active_lease."completed_at" IS NULL
          AND active_lease."revoked_at" IS NULL
          AND active_lease."expires_at" > now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${workspaceSignalRuleConnection} required
        LEFT JOIN ${knowledgeEnvironmentConnection} binding
          ON binding."organization_id" = required."organization_id"
         AND binding."project_environment_id" = rule."project_environment_id"
         AND binding."environment_revision" = rule."environment_revision"
         AND binding."connection_id" = required."connection_id"
         AND binding."connection_revision" = required."connection_revision"
         AND binding."revoked_at" IS NULL
        LEFT JOIN ${workspaceConnection} connection
          ON connection."organization_id" = required."organization_id"
         AND connection."id" = required."connection_id"
         AND connection."revision" = required."connection_revision"
         AND connection."readonly_default" = TRUE
         AND connection."allow_writes" = FALSE
         AND connection."deleted_at" IS NULL
         AND connection."revocation_pending_at" IS NULL
        LEFT JOIN ${workspaceConnectionGrant} grant_record
          ON grant_record."organization_id" = required."organization_id"
         AND grant_record."connection_id" = required."connection_id"
         AND grant_record."member_id" = ${input.authority.membershipId}
         AND grant_record."capability" IN ('use', 'manage')
        WHERE required."organization_id" = rule."organization_id"
          AND required."rule_id" = rule."id"
          AND (binding."connection_id" IS NULL OR connection."id" IS NULL
            OR grant_record."connection_id" IS NULL)
      )
    GROUP BY rule."id", analysis."definition"
    ORDER BY rule."next_evaluation_at", rule."id"
    LIMIT 1
  `);
  const candidate = candidateResult.rows[0];
  const scheduledAt = candidate?.nextEvaluationAt instanceof Date
    ? candidate.nextEvaluationAt : new Date(String(candidate?.nextEvaluationAt));
  const revision = Number(candidate?.ruleRevision);
  const environmentRevision = Number(candidate?.environmentRevision);
  const nextTransitionSequence = Number(candidate?.nextTransitionSequence);
  if (!candidate || typeof candidate.ruleId !== "string"
    || typeof candidate.projectEnvironmentId !== "string"
    || !Number.isSafeInteger(revision) || !Number.isSafeInteger(environmentRevision)
    || !Number.isSafeInteger(nextTransitionSequence) || nextTransitionSequence < 1
    || Number.isNaN(scheduledAt.valueOf())
    || !candidate.ruleDefinition || typeof candidate.ruleDefinition !== "object"
    || Array.isArray(candidate.ruleDefinition)
    || !candidate.analysisDefinition || typeof candidate.analysisDefinition !== "object"
    || Array.isArray(candidate.analysisDefinition)
    || !Array.isArray(candidate.connectionIds)
    || candidate.connectionIds.some((value) => typeof value !== "string")) return null;

  const definition = candidate.ruleDefinition as Record<string, unknown>;
  const schedule = typeof definition.schedule === "string" ? definition.schedule : "";
  const timezone = typeof definition.timezone === "string" ? definition.timezone : "";
  const nextEvaluationAt = nextSignalEvaluationAt(schedule, timezone, new Date());
  const capability = randomBytes(32).toString("base64url");
  const capabilityHash = createHash("sha256").update(capability).digest("hex");
  const idempotencyKey = `${candidate.ruleId}:${revision}:${scheduledAt.toISOString()}`;
  const leaseId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const claimed = await db.execute<Record<string, unknown>>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`signal-claim:${input.organizationId}:${candidate.ruleId}`}, 0))
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
    ), runner AS MATERIALIZED (
      UPDATE ${workspaceSignalRunner} runner SET "last_seen_at" = now()
      FROM authority
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = ${input.claim.runnerId}::uuid
        AND runner."member_id" = authority."id"
        AND runner."device_id" = ${input.claim.deviceId}
        AND runner."revoked_at" IS NULL
        AND (NOT ${input.claim.background} OR runner."background_allowed")
      RETURNING runner."id"
    ), expired AS MATERIALIZED (
      UPDATE ${workspaceSignalRunnerLease} lease SET "revoked_at" = now()
      WHERE lease."organization_id" = ${input.organizationId}
        AND lease."rule_id" = ${candidate.ruleId}::uuid
        AND lease."completed_at" IS NULL AND lease."revoked_at" IS NULL
        AND lease."expires_at" <= now()
      RETURNING lease."id"
    ), eligible AS MATERIALIZED (
      SELECT rule."id", rule."revision"
      FROM ${workspaceSignalRule} rule
      JOIN runner ON runner."id" = rule."runner_id"
      CROSS JOIN (SELECT count(*) FROM expired) expired_gate
      JOIN ${knowledgeProjectEnvironment} environment
        ON environment."organization_id" = rule."organization_id"
       AND environment."id" = rule."project_environment_id"
       AND environment."revision" = rule."environment_revision"
      JOIN ${workspaceFunnelAnalysis} analysis
        ON analysis."organization_id" = rule."organization_id"
       AND analysis."id" = rule."source_analysis_id"
       AND analysis."revision" = rule."source_analysis_revision"
       AND analysis."state" = 'published' AND analysis."deleted_at" IS NULL
      WHERE rule."organization_id" = ${input.organizationId}
        AND rule."id" = ${candidate.ruleId}::uuid
        AND rule."revision" = ${revision}
        AND rule."project_environment_id" = ${candidate.projectEnvironmentId}::uuid
        AND rule."environment_revision" = ${environmentRevision}
        AND rule."enabled" AND rule."deleted_at" IS NULL
        AND rule."next_evaluation_at" = ${scheduledAt}
        AND rule."next_evaluation_at" <= now()
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceSignalRunnerLease} active
          WHERE active."organization_id" = rule."organization_id"
            AND active."rule_id" = rule."id"
            AND active."completed_at" IS NULL AND active."revoked_at" IS NULL
            AND active."expires_at" > now()
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceSignalRuleConnection} required
          LEFT JOIN ${knowledgeEnvironmentConnection} binding
            ON binding."organization_id" = required."organization_id"
           AND binding."project_environment_id" = rule."project_environment_id"
           AND binding."environment_revision" = rule."environment_revision"
           AND binding."connection_id" = required."connection_id"
           AND binding."connection_revision" = required."connection_revision"
           AND binding."revoked_at" IS NULL
          LEFT JOIN ${workspaceConnection} connection
            ON connection."organization_id" = required."organization_id"
           AND connection."id" = required."connection_id"
           AND connection."revision" = required."connection_revision"
           AND connection."readonly_default" = TRUE
           AND connection."allow_writes" = FALSE
           AND connection."deleted_at" IS NULL
           AND connection."revocation_pending_at" IS NULL
          LEFT JOIN ${workspaceConnectionGrant} grant_record
            ON grant_record."organization_id" = required."organization_id"
           AND grant_record."connection_id" = required."connection_id"
           AND grant_record."member_id" = ${input.authority.membershipId}
           AND grant_record."capability" IN ('use', 'manage')
          WHERE required."organization_id" = rule."organization_id"
            AND required."rule_id" = rule."id"
            AND (binding."connection_id" IS NULL OR connection."id" IS NULL
              OR grant_record."connection_id" IS NULL)
        )
      FOR UPDATE OF rule
    ), stored AS MATERIALIZED (
      INSERT INTO ${workspaceSignalRunnerLease}
        ("id", "organization_id", "rule_id", "rule_revision", "runner_id",
         "idempotency_key", "lease_capability_hash", "scheduled_at", "expires_at")
      SELECT ${leaseId}::uuid, ${input.organizationId}, eligible."id", eligible."revision",
        runner."id", ${idempotencyKey}, ${capabilityHash}, ${scheduledAt},
        now() + interval '90 seconds'
      FROM eligible CROSS JOIN runner
      ON CONFLICT DO NOTHING
      RETURNING *
    ), advanced AS (
      UPDATE ${workspaceSignalRule} rule SET
        "next_evaluation_at" = ${nextEvaluationAt}, "updated_at" = now()
      FROM stored
      WHERE rule."organization_id" = stored."organization_id"
        AND rule."id" = stored."rule_id"
        AND rule."revision" = stored."rule_revision"
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'signal.lease.claimed',
        'signal_lease', stored."id"::text,
        jsonb_build_object('ruleId', stored."rule_id", 'background', ${input.claim.background}),
        ${requestId}::uuid
      FROM stored
    )
    SELECT stored."id"::text AS "id", stored."expires_at" AS "expiresAt"
    FROM stored
  `);
  const row = claimed.rows[0];
  const expiresAt = row?.expiresAt instanceof Date
    ? row.expiresAt : new Date(String(row?.expiresAt));
  if (!row || typeof row.id !== "string" || Number.isNaN(expiresAt.valueOf())) return null;
  return {
    id: row.id,
    capability,
    expiresAt,
    scheduledAt,
    ruleId: candidate.ruleId,
    ruleRevision: revision,
    projectEnvironmentId: candidate.projectEnvironmentId,
    environmentRevision,
    ruleDefinition: definition,
    analysisDefinition: candidate.analysisDefinition as Record<string, unknown>,
    connectionIds: candidate.connectionIds as string[],
    nextTransitionSequence,
  };
}

/** Commit a categorical receipt while rechecking the exact lease and grants. */
export async function commitSignalEvaluationReceipt(input: {
  organizationId: string;
  leaseId: string;
  leaseCapability: string;
  receipt: SignalEvaluationReceiptInput;
  authority: DashboardMutationAuthority;
}): Promise<StoredSignalEvaluationReceipt | null> {
  const capabilityHash = createHash("sha256")
    .update(input.leaseCapability)
    .digest("hex");
  const requestId = crypto.randomUUID();
  const connectionIds = JSON.stringify(input.receipt.connectionIds);
  const queryRunIds = JSON.stringify(input.receipt.queryRunIds);
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`signal-receipt:${input.organizationId}:${input.receipt.ruleId}`}, 0))
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
    ), lease_scope AS MATERIALIZED (
      SELECT lease."id" AS lease_id, lease."runner_id", rule."id" AS rule_id,
        rule."revision", rule."definition", rule."project_environment_id",
        rule."environment_revision"
      FROM ${workspaceSignalRunnerLease} lease
      JOIN ${workspaceSignalRunner} runner
        ON runner."organization_id" = lease."organization_id"
       AND runner."id" = lease."runner_id"
      JOIN authority ON authority."id" = runner."member_id"
      JOIN ${workspaceSignalRule} rule
        ON rule."organization_id" = lease."organization_id"
       AND rule."id" = lease."rule_id"
       AND rule."revision" = lease."rule_revision"
       AND rule."runner_id" = runner."id"
      JOIN ${knowledgeProjectEnvironment} environment
        ON environment."organization_id" = rule."organization_id"
       AND environment."id" = rule."project_environment_id"
       AND environment."revision" = rule."environment_revision"
      WHERE lease."organization_id" = ${input.organizationId}
        AND lease."id" = ${input.leaseId}::uuid
        AND lease."lease_capability_hash" = ${capabilityHash}
        AND lease."completed_at" IS NULL AND lease."revoked_at" IS NULL
        AND lease."expires_at" > now()
        AND lease."scheduled_at" = ${input.receipt.scheduledAt}
        AND runner."device_id" = ${input.receipt.runnerDeviceId}
        AND runner."revoked_at" IS NULL
        AND rule."id" = ${input.receipt.ruleId}::uuid
        AND rule."revision" = ${input.receipt.ruleRevision}
        AND rule."project_environment_id" = ${input.receipt.projectEnvironmentId}::uuid
        AND rule."environment_revision" = ${input.receipt.environmentRevision}
        AND rule."enabled" AND rule."deleted_at" IS NULL
        AND ${input.receipt.evaluatedAt} <= now() + interval '30 seconds'
        AND (SELECT count(*) FROM ${workspaceSignalRuleConnection} expected
          WHERE expected."organization_id" = rule."organization_id"
            AND expected."rule_id" = rule."id") = ${input.receipt.connectionIds.length}
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceSignalRuleConnection} expected
          LEFT JOIN ${knowledgeEnvironmentConnection} binding
            ON binding."organization_id" = expected."organization_id"
           AND binding."project_environment_id" = rule."project_environment_id"
           AND binding."environment_revision" = rule."environment_revision"
           AND binding."connection_id" = expected."connection_id"
           AND binding."connection_revision" = expected."connection_revision"
           AND binding."revoked_at" IS NULL
          LEFT JOIN ${workspaceConnection} connection
            ON connection."organization_id" = expected."organization_id"
           AND connection."id" = expected."connection_id"
           AND connection."revision" = expected."connection_revision"
           AND connection."readonly_default" = TRUE
           AND connection."allow_writes" = FALSE
           AND connection."deleted_at" IS NULL
           AND connection."revocation_pending_at" IS NULL
          LEFT JOIN ${workspaceConnectionGrant} grant_record
            ON grant_record."organization_id" = expected."organization_id"
           AND grant_record."connection_id" = expected."connection_id"
           AND grant_record."member_id" = authority."id"
           AND grant_record."capability" IN ('use', 'manage')
          WHERE expected."organization_id" = rule."organization_id"
            AND expected."rule_id" = rule."id"
            AND (binding."connection_id" IS NULL OR connection."id" IS NULL
              OR grant_record."connection_id" IS NULL
              OR NOT (${connectionIds}::jsonb @> jsonb_build_array(expected."connection_id"::text)))
        )
      FOR UPDATE OF lease, runner, rule
    ), previous AS MATERIALIZED (
      SELECT receipt."state", receipt."transition_sequence", receipt."evaluated_at"
      FROM ${workspaceSignalEvaluationReceipt} receipt
      JOIN lease_scope ON lease_scope.rule_id = receipt."rule_id"
        AND lease_scope.revision = receipt."rule_revision"
      WHERE receipt."organization_id" = ${input.organizationId}
      ORDER BY receipt."transition_sequence" DESC
      LIMIT 1
    ), trailing_normal AS MATERIALIZED (
      SELECT count(*)::bigint AS count
      FROM ${workspaceSignalEvaluationReceipt} receipt
      JOIN lease_scope ON lease_scope.rule_id = receipt."rule_id"
        AND lease_scope.revision = receipt."rule_revision"
      WHERE receipt."organization_id" = ${input.organizationId}
        AND receipt."observed_state" = 'normal'
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceSignalEvaluationReceipt} newer
          WHERE newer."organization_id" = receipt."organization_id"
            AND newer."rule_id" = receipt."rule_id"
            AND newer."rule_revision" = receipt."rule_revision"
            AND newer."transition_sequence" > receipt."transition_sequence"
            AND newer."observed_state" <> 'normal'
        )
    ), transitioned AS MATERIALIZED (
      SELECT CASE
        WHEN ${input.receipt.state} = 'normal' AND previous."state" = 'firing'
          AND trailing_normal.count + 1 <
            (lease_scope."definition"->>'rearmAfterNormalCount')::bigint
          THEN 'firing'
        WHEN ${input.receipt.state} = 'normal' AND previous."state" = 'firing'
          THEN 'recovered'
        ELSE ${input.receipt.state}
      END AS state,
      COALESCE(previous."transition_sequence", 0) + 1 AS expected_sequence,
      previous."state" AS previous_state, lease_scope.*
      FROM lease_scope
      LEFT JOIN previous ON TRUE
      CROSS JOIN trailing_normal
    ), last_same_notification AS MATERIALIZED (
      SELECT max(receipt."evaluated_at") AS evaluated_at
      FROM ${workspaceSignalNotification} notification
      JOIN ${workspaceSignalEvaluationReceipt} receipt
        ON receipt."organization_id" = notification."organization_id"
       AND receipt."id" = notification."receipt_id"
      JOIN transitioned ON transitioned.rule_id = receipt."rule_id"
        AND transitioned.revision = receipt."rule_revision"
        AND transitioned.state = receipt."state"
      WHERE notification."organization_id" = ${input.organizationId}
        AND notification."state" IN ('pending', 'delivered')
    ), delivery AS MATERIALIZED (
      SELECT CASE
        WHEN transitioned.state = 'recovered'
          AND transitioned.previous_state = 'firing' THEN 'pending'
        WHEN transitioned.state IN ('firing', 'no_data', 'error', 'stale', 'runner_offline')
          AND (transitioned.previous_state IS DISTINCT FROM transitioned.state
            OR last_same_notification.evaluated_at IS NULL
            OR last_same_notification.evaluated_at
              + make_interval(secs =>
                (transitioned."definition"->>'cooldownSeconds')::integer)
              <= ${input.receipt.evaluatedAt}) THEN 'pending'
        WHEN transitioned.state IN ('firing', 'no_data', 'error', 'stale', 'runner_offline')
          THEN 'suppressed'
        ELSE 'none'
      END AS notification_state, transitioned.*
      FROM transitioned CROSS JOIN last_same_notification
    ), stored AS MATERIALIZED (
      INSERT INTO ${workspaceSignalEvaluationReceipt}
        ("id", "organization_id", "rule_id", "rule_revision", "runner_id", "lease_id",
         "project_environment_id", "environment_revision", "scheduled_at", "evaluated_at",
         "observed_state", "state", "query_run_ids", "connection_ids", "duration_ms",
         "row_count_category", "schema_fingerprint", "dedupe_key", "transition_sequence",
         "error_kind")
      SELECT ${input.receipt.receiptId}::uuid, ${input.organizationId}, delivery.rule_id,
        delivery.revision, delivery.runner_id, delivery.lease_id,
        delivery.project_environment_id, delivery.environment_revision,
        ${input.receipt.scheduledAt}, ${input.receipt.evaluatedAt}, ${input.receipt.state},
        delivery.state, ${queryRunIds}::jsonb, ${connectionIds}::jsonb,
        ${input.receipt.durationMs}, ${input.receipt.rowCountCategory},
        ${input.receipt.schemaFingerprint}, ${input.receipt.dedupeKey},
        delivery.expected_sequence, ${input.receipt.errorKind}
      FROM delivery
      WHERE delivery.expected_sequence = ${input.receipt.transitionSequence}
      ON CONFLICT DO NOTHING
      RETURNING *
    ), notifications AS (
      INSERT INTO ${workspaceSignalNotification}
        ("organization_id", "receipt_id", "recipient_member_id", "channel", "state")
      SELECT ${input.organizationId}, stored."id", recipient.member_id, channel.channel,
        delivery.notification_state
      FROM stored
      JOIN delivery ON delivery.rule_id = stored."rule_id"
      CROSS JOIN LATERAL jsonb_array_elements_text(
        delivery."definition"->'recipientMemberIds') recipient(member_id)
      CROSS JOIN LATERAL jsonb_array_elements_text(
        delivery."definition"->'channels') channel(channel)
      WHERE delivery.notification_state <> 'none'
      ON CONFLICT DO NOTHING
    ), completed AS (
      UPDATE ${workspaceSignalRunnerLease} lease SET "completed_at" = now()
      FROM stored
      WHERE lease."organization_id" = stored."organization_id"
        AND lease."id" = stored."lease_id"
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'signal.receipt.committed',
        'signal_receipt', stored."id"::text,
        jsonb_build_object('ruleId', stored."rule_id", 'state', stored."state",
          'notification', delivery.notification_state), ${requestId}::uuid
      FROM stored JOIN delivery ON delivery.rule_id = stored."rule_id"
    )
    SELECT stored."id"::text AS "id", stored."state" AS "state",
      stored."transition_sequence" AS "transitionSequence",
      delivery.notification_state AS "notificationState"
    FROM stored JOIN delivery ON delivery.rule_id = stored."rule_id"
  `);
  const row = result.rows[0];
  const sequence = Number(row?.transitionSequence);
  if (!row || typeof row.id !== "string" || typeof row.state !== "string"
    || !["none", "pending", "suppressed"].includes(String(row.notificationState))
    || !Number.isSafeInteger(sequence) || sequence < 1) return null;
  return {
    id: row.id,
    state: row.state,
    notificationState: row.notificationState as StoredSignalEvaluationReceipt["notificationState"],
    transitionSequence: sequence,
  };
}

export async function commitSignalRuleMutation(input: {
  organizationId: string;
  ruleId: string;
  expectedRevision: number;
  mutation: SignalRuleMutation;
  authority: DashboardMutationAuthority;
}): Promise<MutatedSignalRule | null> {
  const currentRows = await db.select({
    definition: workspaceSignalRule.definition,
    enabled: workspaceSignalRule.enabled,
    status: workspaceSignalRule.status,
    runnerId: workspaceSignalRule.runnerId,
  }).from(workspaceSignalRule).where(and(
    eq(workspaceSignalRule.organizationId, input.organizationId),
    eq(workspaceSignalRule.id, input.ruleId),
    eq(workspaceSignalRule.revision, input.expectedRevision),
    isNull(workspaceSignalRule.deletedAt),
  )).limit(1);
  const current = currentRows[0];
  if (!current || !current.definition || typeof current.definition !== "object"
    || Array.isArray(current.definition)) return null;
  const bumpsRevision = input.mutation.action !== "run_now";
  const nextRevision = bumpsRevision ? input.expectedRevision + 1 : input.expectedRevision;
  const nextStatus = input.mutation.action === "enable" ? "active"
    : input.mutation.action === "pause" ? "paused"
      : input.mutation.action === "disable" ? "disabled"
        : current.status as MutatedSignalRule["status"];
  const nextEnabled = nextStatus === "active";
  const nextRunnerId = input.mutation.action === "runner_change"
    ? input.mutation.runnerId : current.runnerId;
  const nextDefinition = bumpsRevision ? {
    ...(current.definition as Record<string, unknown>),
    enabled: nextEnabled,
    revision: nextRevision,
  } : current.definition;
  const payloadHash = canonicalHash(nextDefinition);
  const requestId = crypto.randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`signal-command:${input.organizationId}:${input.ruleId}`}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id", member."role"
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
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), current_rule AS MATERIALIZED (
      SELECT rule.*
      FROM ${workspaceSignalRule} rule
      JOIN authority ON rule."owner_member_id" = authority."id"
        OR authority."role" IN ('admin', 'owner')
      WHERE rule."organization_id" = ${input.organizationId}
        AND rule."id" = ${input.ruleId}::uuid
        AND rule."revision" = ${input.expectedRevision}
        AND rule."deleted_at" IS NULL
        AND (${input.mutation.action} <> 'runner_change'
          OR rule."owner_member_id" = authority."id")
        AND (${input.mutation.action} <> 'run_now' OR rule."enabled")
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceSignalRunnerLease} active
          WHERE active."organization_id" = rule."organization_id"
            AND active."rule_id" = rule."id"
            AND active."completed_at" IS NULL AND active."revoked_at" IS NULL
            AND active."expires_at" > now()
        )
      FOR UPDATE OF rule
    ), runner AS MATERIALIZED (
      SELECT runner."id"
      FROM ${workspaceSignalRunner} runner
      JOIN current_rule ON current_rule."organization_id" = runner."organization_id"
      JOIN authority ON TRUE
      WHERE runner."id" = ${nextRunnerId}::uuid
        AND runner."revoked_at" IS NULL
        AND (NOT ${nextEnabled} OR runner."last_seen_at" > now() - interval '2 minutes')
        AND (${input.mutation.action} <> 'runner_change'
          OR runner."member_id" = authority."id")
      FOR UPDATE OF runner
    ), selected_runner AS MATERIALIZED (
      SELECT runner."id" FROM runner
      UNION ALL
      SELECT NULL::uuid FROM current_rule
      WHERE ${nextRunnerId}::text IS NULL AND NOT ${nextEnabled}
    ), stored AS MATERIALIZED (
      UPDATE ${workspaceSignalRule} rule SET
        "runner_id" = selected_runner."id",
        "enabled" = ${nextEnabled}, "status" = ${nextStatus},
        "revision" = ${nextRevision}, "definition" = ${JSON.stringify(nextDefinition)}::jsonb,
        "next_evaluation_at" = CASE WHEN ${input.mutation.action} = 'run_now'
          OR (${input.mutation.action} = 'enable' AND NOT current_rule."enabled")
          THEN now() ELSE rule."next_evaluation_at" END,
        "updated_at" = now()
      FROM current_rule CROSS JOIN selected_runner
      WHERE rule."organization_id" = current_rule."organization_id"
        AND rule."id" = current_rule."id"
      RETURNING rule.*
    ), stored_revision AS (
      INSERT INTO ${workspaceSignalRuleRevision}
        ("organization_id", "rule_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_member_id")
      SELECT ${input.organizationId}, stored."id", stored."revision",
        ${input.expectedRevision}, ${input.mutation.action},
        ${JSON.stringify(nextDefinition)}::jsonb, ${payloadHash}, authority."id"
      FROM stored CROSS JOIN authority
      WHERE ${bumpsRevision}
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        ${`signal.rule.${input.mutation.action}`}, 'signal_rule', stored."id"::text,
        jsonb_build_object('revision', stored."revision", 'status', stored."status"),
        ${requestId}::uuid
      FROM stored
    )
    SELECT stored."id"::text AS "id", stored."revision" AS "revision",
      stored."status" AS "status", stored."enabled" AS "enabled",
      stored."next_evaluation_at" AS "nextEvaluationAt"
    FROM stored
  `);
  const row = result.rows[0];
  const revision = Number(row?.revision);
  const nextEvaluationAt = row?.nextEvaluationAt instanceof Date
    ? row.nextEvaluationAt : new Date(String(row?.nextEvaluationAt));
  if (!row || typeof row.id !== "string" || !Number.isSafeInteger(revision)
    || !["active", "paused", "disabled"].includes(String(row.status))
    || typeof row.enabled !== "boolean" || Number.isNaN(nextEvaluationAt.valueOf())) return null;
  return {
    id: row.id,
    revision,
    status: row.status as MutatedSignalRule["status"],
    enabled: row.enabled,
    nextEvaluationAt,
  };
}
