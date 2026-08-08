// Atomic authorization and persistence for local signal monitoring. The cloud
// owns scheduling metadata only; no statement or evaluated metric crosses this
// boundary.
import "server-only";

import { sql } from "drizzle-orm";

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
  workspaceSignalRunner,
} from "./schema";
import type { DashboardMutationAuthority } from "./workspace-dashboard-store";
import type { SignalRuleCreate, SignalRunnerRegistration } from "./workspace-signals";
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
         "enabled", "revision", "production_approved_by_member_id",
         "production_approved_at")
      SELECT ${input.rule.id}::uuid, ${input.organizationId}, environment."id",
        environment."revision", analysis."id", ${input.rule.sourceAnalysisRevision},
        ${input.rule.sourceTileId}, ${input.rule.metricSemanticId},
        ${JSON.stringify(definition)}::jsonb, authority."id", selected_runner."id",
        ${input.rule.enabled}, 1, ${productionApproval}, ${productionApprovedAt}
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
