// Durable provider-operation planning boundary. Every inserted or replayed plan
// is conditional on one current member/session/integration snapshot and creates
// the matching audit consequence in the same statement.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import {
  providerMutationAuthoritySql,
  type ProviderMutationAuthority,
} from "./provider-integrations";
import { verifyProviderOperationOwnershipMarker } from "./provider-operation-marker";
import {
  member,
  session,
  workspaceAuditEvent,
  workspaceProviderIntegration,
  workspaceProviderOperation,
  workspaceProviderOperationApproval,
} from "./schema";
import { workspaceAuditEventId } from "./workspace-audit-id";
import { canonicalHash, canonicalJson } from "./workspace-versioning";
import type { NeonBranchCreatePlan } from "./providers/neon-branch-plan";

const MAX_REDACTED_PLAN_BYTES = 32 * 1_024;
const operationStates = [
  "awaiting_approval",
  "approved",
  "claimed",
  "remote_started",
  "reconciling",
  "succeeded",
  "failed",
  "needs_repair",
  "cancelled",
] as const;

export type ProviderOperationState = typeof operationStates[number];

// Keep every durable provider-operation write visible in one review surface.
// Approval, claim, remote-start, reconciliation, and completion transitions
// must be added here when their authority-bound store entrypoints are added.
export const PROVIDER_OPERATION_DURABLE_MUTATION_ENTRYPOINTS = Object.freeze([
  "recordProviderOperationPlan",
  "decideProviderOperation",
] as const);

export type ProviderOperationPlanRecord = Readonly<{
  id: string;
  state: ProviderOperationState;
  planHash: string;
  planExpiresAt: Date;
  risk: "standard" | "production_data";
  approvalPolicy: "single_admin" | "separate_admin";
  plan: NeonBranchCreatePlan;
  ownershipMarker: string;
  replayed: boolean;
}>;

export type ProviderOperationDecision = "approved" | "rejected";

export type ProviderOperationDecisionRecord = Readonly<{
  id: string;
  state: ProviderOperationState;
  decision: ProviderOperationDecision;
  approvalId: string;
  replayed: boolean;
}>;

type ProviderOperationPlanRow = {
  id: string;
  state: string;
  planHash: string;
  planExpiresAt: Date | string;
  risk: string;
  approvalPolicy: string;
  redactedPlan: unknown;
  ownershipMarker: string;
};

function safeRedactedValue(value: unknown, depth = 0): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid provider operation plan");
    return;
  }
  if (typeof value === "string") {
    if (
      value.length > 2_048
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    ) {
      throw new Error("Invalid provider operation plan");
    }
    return;
  }
  if (depth >= 8) throw new Error("Invalid provider operation plan");
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error("Invalid provider operation plan");
    value.forEach((item) => safeRedactedValue(item, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Invalid provider operation plan");
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)
      || /token|secret|password|credential|authorization|connectionuri|connectionurl|host/i
        .test(key)
    ) {
      throw new Error("Provider operation plan contains secret-bearing data");
    }
    safeRedactedValue(child, depth + 1);
  }
}

function assertPlan(input: {
  organizationId: string;
  integrationId: string;
  integrationGeneration: bigint;
  operationId: string;
  planHash: string;
  ownershipMarker: string;
  plan: NeonBranchCreatePlan;
}) {
  safeRedactedValue(input.plan);
  if (
    Buffer.byteLength(canonicalJson(input.plan), "utf8") > MAX_REDACTED_PLAN_BYTES
    || canonicalHash(input.plan) !== input.planHash
    || input.plan.operationId !== input.operationId
    || input.plan.integrationId !== input.integrationId
    || input.plan.integrationGeneration !== input.integrationGeneration.toString()
    || !verifyProviderOperationOwnershipMarker({
      organizationId: input.organizationId,
      integrationId: input.integrationId,
      integrationGeneration: input.integrationGeneration,
      operationId: input.operationId,
      planHash: input.planHash,
      marker: input.ownershipMarker,
    })
  ) {
    throw new Error("Invalid provider operation plan");
  }
}

function planDate(value: Date | string): Date | null {
  const date = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function planRecord(
  row: ProviderOperationPlanRow | undefined,
  input: {
    organizationId: string;
    integrationId: string;
    integrationGeneration: bigint;
    operationId: string;
  },
): ProviderOperationPlanRecord | null {
  const expiresAt = row ? planDate(row.planExpiresAt) : null;
  if (
    !row
    || !expiresAt
    || !operationStates.includes(row.state as ProviderOperationState)
    || !/^[0-9a-f]{64}$/.test(row.planHash)
    || (row.risk !== "standard" && row.risk !== "production_data")
    || (row.approvalPolicy !== "single_admin" && row.approvalPolicy !== "separate_admin")
    || !row.redactedPlan
    || typeof row.redactedPlan !== "object"
    || Array.isArray(row.redactedPlan)
  ) {
    return null;
  }
  const plan = row.redactedPlan as NeonBranchCreatePlan;
  // A replay verifies the originally persisted operation and marker, never the
  // newly generated candidate that lost the idempotency conflict.
  safeRedactedValue(plan);
  if (
    canonicalHash(plan) !== row.planHash
    || plan.operationId !== row.id
    || plan.version !== 1
    || plan.kind !== "neon.branch.create"
    || plan.integrationId !== input.integrationId
    || plan.integrationGeneration !== input.integrationGeneration.toString()
    || plan.expiresAt !== expiresAt.toISOString()
    || plan.risk !== row.risk
    || plan.approvalPolicy !== row.approvalPolicy
    || !verifyProviderOperationOwnershipMarker({
      organizationId: input.organizationId,
      integrationId: input.integrationId,
      integrationGeneration: input.integrationGeneration,
      operationId: row.id,
      planHash: row.planHash,
      marker: row.ownershipMarker,
    })
  ) {
    return null;
  }
  return {
    id: row.id,
    state: row.state as ProviderOperationState,
    planHash: row.planHash,
    planExpiresAt: expiresAt,
    risk: row.risk,
    approvalPolicy: row.approvalPolicy,
    plan,
    ownershipMarker: row.ownershipMarker,
    replayed: row.id !== input.operationId,
  };
}

export async function loadProviderOperationPlan(input: {
  organizationId: string;
  integrationId: string;
  integrationGeneration: bigint;
  operationId: string;
}): Promise<ProviderOperationPlanRecord | null> {
  const result = await db.execute<ProviderOperationPlanRow>(sql`
    SELECT operation."id"::text AS "id", operation."state" AS "state",
      operation."plan_hash" AS "planHash",
      operation."plan_expires_at" AS "planExpiresAt",
      operation."risk" AS "risk",
      operation."approval_policy" AS "approvalPolicy",
      operation."redacted_plan" AS "redactedPlan",
      operation."ownership_marker" AS "ownershipMarker"
    FROM ${workspaceProviderOperation} AS operation
    WHERE operation."id" = ${input.operationId}::uuid
      AND operation."organization_id" = ${input.organizationId}
      AND operation."integration_id" = ${input.integrationId}::uuid
      AND operation."provider" = 'neon'
      AND operation."kind" = 'neon.branch.create'
      AND operation."integration_generation" = ${input.integrationGeneration}
    LIMIT 1
  `);
  return planRecord(result.rows[0], {
    organizationId: input.organizationId,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration,
    operationId: input.operationId,
  });
}

export async function recordProviderOperationPlan(input: {
  authority: ProviderMutationAuthority;
  integrationId: string;
  integrationGeneration: bigint;
  operationId: string;
  idempotencyKey: string;
  requestHash: string;
  planHash: string;
  ownershipMarker: string;
  plan: NeonBranchCreatePlan;
  now: Date;
}): Promise<ProviderOperationPlanRecord | null> {
  assertPlan({
    organizationId: input.authority.organizationId,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration,
    operationId: input.operationId,
    planHash: input.planHash,
    ownershipMarker: input.ownershipMarker,
    plan: input.plan,
  });
  if (
    !/^[0-9a-f]{64}$/.test(input.requestHash)
    || input.plan.risk !== (input.plan.target.copiesData
      && input.plan.source.environment === "production" ? "production_data" : "standard")
    || input.plan.approvalPolicy !== (input.plan.risk === "production_data"
      ? "separate_admin" : "single_admin")
    || input.plan.expiresAt !== new Date(
      input.now.valueOf() + 10 * 60 * 1_000,
    ).toISOString()
  ) {
    throw new Error("Invalid provider operation plan");
  }

  const auditId = workspaceAuditEventId(
    "provider-operation:plan",
    input.idempotencyKey,
  );
  const authority = providerMutationAuthoritySql({
    ...input.authority,
    requireManager: true,
    integration: {
      id: input.integrationId,
      provider: "neon",
      generation: input.integrationGeneration,
      claimId: null,
    },
  });
  const result = await db.execute<ProviderOperationPlanRow>(sql`
    WITH live_integration AS MATERIALIZED (
      SELECT integration."id"
      FROM ${workspaceProviderIntegration} AS integration
      WHERE integration."id" = ${input.integrationId}::uuid
        AND integration."organization_id" = ${input.authority.organizationId}
        AND integration."provider" = 'neon'
        AND integration."generation" = ${input.integrationGeneration}
        AND integration."status" = 'active'
        AND integration."refresh_phase" = 'idle'
        AND integration."revoked_at" IS NULL
        AND integration."revocation_pending_at" IS NULL
        AND integration."revocation_claim_id" IS NULL
        AND ${authority}
      FOR UPDATE OF integration
    ), recorded AS (
      INSERT INTO ${workspaceProviderOperation} AS existing
        ("id", "organization_id", "integration_id", "provider",
         "integration_generation", "kind", "state", "idempotency_key",
         "request_hash", "plan_hash", "plan_version", "plan_expires_at",
         "risk", "approval_policy", "requested_by_member_id",
         "requested_by_user_id", "requested_by_session_id", "requested_by_role",
         "resource_scope", "source_resource_id", "target_name",
         "ownership_marker", "redacted_plan", "created_at", "updated_at")
      SELECT ${input.operationId}::uuid, ${input.authority.organizationId},
        live_integration."id", 'neon', ${input.integrationGeneration},
        'neon.branch.create', 'awaiting_approval', ${input.idempotencyKey}::uuid,
        ${input.requestHash}, ${input.planHash}, 1,
        ${new Date(input.plan.expiresAt)}, ${input.plan.risk},
        ${input.plan.approvalPolicy}, ${input.authority.membershipId},
        ${input.authority.userId}, ${input.authority.sessionId},
        ${input.authority.role}, ${input.plan.source.projectId},
        ${input.plan.source.branchId}, ${input.plan.target.name},
        ${input.ownershipMarker}, ${JSON.stringify(input.plan)}::jsonb,
        ${input.now}, ${input.now}
      FROM live_integration
      ON CONFLICT ("organization_id", "idempotency_key") DO UPDATE
      SET "id" = existing."id"
      WHERE existing."request_hash" = EXCLUDED."request_hash"
        AND existing."provider" = EXCLUDED."provider"
        AND existing."kind" = EXCLUDED."kind"
        AND existing."integration_id" = EXCLUDED."integration_id"
        AND existing."integration_generation" = EXCLUDED."integration_generation"
      RETURNING existing."id"::text AS "id", existing."state" AS "state",
        existing."plan_hash" AS "planHash",
        existing."plan_expires_at" AS "planExpiresAt",
        existing."risk" AS "risk",
        existing."approval_policy" AS "approvalPolicy",
        existing."redacted_plan" AS "redactedPlan",
        existing."ownership_marker" AS "ownershipMarker"
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent} AS existing
        ("id", "organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${auditId}::uuid, ${input.authority.organizationId},
        ${input.authority.userId}, 'provider.operation.plan',
        'provider_operation', recorded."id",
        jsonb_build_object(
          'provider', 'neon',
          'kind', 'neon.branch.create',
          'planHash', recorded."planHash",
          'risk', recorded."risk",
          'approvalPolicy', recorded."approvalPolicy",
          'projectId', ${input.plan.source.projectId}::text,
          'sourceBranchId', ${input.plan.source.branchId}::text,
          'targetName', ${input.plan.target.name}::text,
          'initSource', ${input.plan.target.initSource}::text,
          'sourcePoint', ${input.plan.source.point.kind}::text,
          'endpoint', ${input.plan.target.endpoint}::text
        ), ${input.idempotencyKey}::uuid
      FROM recorded
      ON CONFLICT ("id") DO UPDATE SET "id" = existing."id"
      WHERE existing."organization_id" = EXCLUDED."organization_id"
        AND existing."actor_user_id" = EXCLUDED."actor_user_id"
        AND existing."action" = EXCLUDED."action"
        AND existing."resource_type" = EXCLUDED."resource_type"
        AND existing."resource_id" = EXCLUDED."resource_id"
        AND existing."redacted_summary" = EXCLUDED."redacted_summary"
        AND existing."request_id" = EXCLUDED."request_id"
      RETURNING "resource_id"
    )
    SELECT recorded.* FROM recorded JOIN audit
      ON audit."resource_id" = recorded."id"
  `);
  return planRecord(result.rows[0], {
    organizationId: input.authority.organizationId,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration,
    operationId: input.operationId,
  });
}

type ProviderOperationDecisionRow = {
  id: string;
  state: string;
  decision: string;
  approvalId: string;
};

/**
 * Records one terminal approval decision and its audit consequence while the
 * requester, approver, integration generation, plan, and ownership marker are
 * all still authoritative. Production-data approval must come from another
 * administrator identity. Exact retries return the original approval row.
 */
export async function decideProviderOperation(input: {
  authority: ProviderMutationAuthority;
  integrationId: string;
  integrationGeneration: bigint;
  operationId: string;
  planHash: string;
  ownershipMarker: string;
  decision: ProviderOperationDecision;
  now: Date;
}): Promise<ProviderOperationDecisionRecord | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.integrationId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.operationId)
    || !/^[0-9a-f]{64}$/.test(input.planHash)
    || (input.decision !== "approved" && input.decision !== "rejected")
    || input.integrationGeneration < 1n
    || Number.isNaN(input.now.valueOf())
    || !verifyProviderOperationOwnershipMarker({
      organizationId: input.authority.organizationId,
      integrationId: input.integrationId,
      integrationGeneration: input.integrationGeneration,
      operationId: input.operationId,
      planHash: input.planHash,
      marker: input.ownershipMarker,
    })
  ) {
    throw new Error("Invalid provider operation decision");
  }

  const approvalId = crypto.randomUUID();
  const expectedState = input.decision === "approved" ? "approved" : "cancelled";
  const auditId = workspaceAuditEventId(
    "provider-operation:decision",
    input.operationId,
  );
  const authority = providerMutationAuthoritySql({
    ...input.authority,
    requireManager: true,
    integration: {
      id: input.integrationId,
      provider: "neon",
      generation: input.integrationGeneration,
      claimId: null,
    },
  });
  const result = await db.execute<ProviderOperationDecisionRow>(sql`
    WITH live_operation AS MATERIALIZED (
      SELECT operation.*
      FROM ${workspaceProviderOperation} AS operation
      JOIN ${session} AS requester_session
        ON requester_session."id" = operation."requested_by_session_id"
       AND requester_session."user_id" = operation."requested_by_user_id"
       AND requester_session."expires_at" > now()
      JOIN ${member} AS requester_member
        ON requester_member."id" = operation."requested_by_member_id"
       AND requester_member."organization_id" = operation."organization_id"
       AND requester_member."user_id" = operation."requested_by_user_id"
       AND requester_member."role" = operation."requested_by_role"
       AND requester_member."role" IN ('admin', 'owner')
       AND requester_member."revocation_pending_at" IS NULL
       AND requester_member."revocation_claim_id" IS NULL
      WHERE operation."id" = ${input.operationId}::uuid
        AND operation."organization_id" = ${input.authority.organizationId}
        AND operation."integration_id" = ${input.integrationId}::uuid
        AND operation."provider" = 'neon'
        AND operation."kind" = 'neon.branch.create'
        AND operation."integration_generation" = ${input.integrationGeneration}
        AND operation."plan_hash" = ${input.planHash}
        AND operation."ownership_marker" = ${input.ownershipMarker}
        AND (
          operation."state" = 'awaiting_approval'
          OR EXISTS (
            SELECT 1
            FROM ${workspaceProviderOperationApproval} AS prior_approval
            WHERE prior_approval."organization_id" = operation."organization_id"
              AND prior_approval."operation_id" = operation."id"
              AND prior_approval."plan_hash" = operation."plan_hash"
              AND prior_approval."decision" = ${input.decision}
              AND prior_approval."actor_member_id" = ${input.authority.membershipId}
              AND prior_approval."actor_user_id" = ${input.authority.userId}
              AND prior_approval."actor_session_id" = ${input.authority.sessionId}
              AND prior_approval."actor_role" = ${input.authority.role}
          )
        )
        AND (
          ${input.decision} = 'approved'
          OR operation."state" IN ('awaiting_approval', 'cancelled')
        )
        AND (
          ${input.decision} <> 'approved'
          OR operation."state" <> 'awaiting_approval'
          OR operation."plan_expires_at" > now()
        )
        AND (
          ${input.decision} <> 'approved'
          OR operation."approval_policy" <> 'separate_admin'
          OR (
            operation."requested_by_member_id" <> ${input.authority.membershipId}
            AND operation."requested_by_user_id" <> ${input.authority.userId}
          )
        )
        AND ${authority}
      FOR UPDATE OF operation, requester_session, requester_member
    ), recorded_approval AS MATERIALIZED (
      INSERT INTO ${workspaceProviderOperationApproval} AS existing
        ("id", "organization_id", "operation_id", "plan_hash", "decision",
         "actor_member_id", "actor_user_id", "actor_session_id", "actor_role",
         "created_at")
      SELECT ${approvalId}::uuid, live_operation."organization_id",
        live_operation."id", live_operation."plan_hash", ${input.decision},
        ${input.authority.membershipId}, ${input.authority.userId},
        ${input.authority.sessionId}, ${input.authority.role}, ${input.now}
      FROM live_operation
      ON CONFLICT ("organization_id", "operation_id") DO UPDATE
      SET "id" = existing."id"
      WHERE existing."plan_hash" = EXCLUDED."plan_hash"
        AND existing."decision" = EXCLUDED."decision"
        AND existing."actor_member_id" = EXCLUDED."actor_member_id"
        AND existing."actor_user_id" = EXCLUDED."actor_user_id"
        AND existing."actor_session_id" = EXCLUDED."actor_session_id"
        AND existing."actor_role" = EXCLUDED."actor_role"
      RETURNING existing."id"::text AS "approvalId",
        existing."operation_id" AS "operationId",
        existing."decision" AS "decision"
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceProviderOperation} AS operation
      SET "state" = CASE
          WHEN operation."state" = 'awaiting_approval' THEN ${expectedState}
          ELSE operation."state"
        END,
        "completed_at" = CASE
          WHEN operation."state" = 'awaiting_approval'
            AND ${input.decision} = 'rejected' THEN ${input.now}
          ELSE operation."completed_at"
        END,
        "updated_at" = CASE
          WHEN operation."state" = 'awaiting_approval' THEN ${input.now}
          ELSE operation."updated_at"
        END
      FROM live_operation, recorded_approval
      WHERE operation."id" = live_operation."id"
        AND operation."organization_id" = live_operation."organization_id"
        AND recorded_approval."operationId" = operation."id"
        AND (
          operation."state" = 'awaiting_approval'
          OR ${input.decision} = 'approved'
          OR operation."state" = 'cancelled'
        )
      RETURNING operation."id"::text AS "id", operation."state" AS "state",
        operation."organization_id" AS "organizationId",
        operation."plan_hash" AS "planHash",
        operation."risk" AS "risk",
        operation."approval_policy" AS "approvalPolicy"
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent} AS existing
        ("id", "organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${auditId}::uuid, updated."organizationId",
        ${input.authority.userId}, 'provider.operation.decision',
        'provider_operation', updated."id",
        jsonb_build_object(
          'provider', 'neon',
          'kind', 'neon.branch.create',
          'decision', ${input.decision}::text,
          'planHash', updated."planHash",
          'risk', updated."risk",
          'approvalPolicy', updated."approvalPolicy"
        ), ${input.operationId}::uuid
      FROM updated
      ON CONFLICT ("id") DO UPDATE SET "id" = existing."id"
      WHERE existing."organization_id" = EXCLUDED."organization_id"
        AND existing."actor_user_id" = EXCLUDED."actor_user_id"
        AND existing."action" = EXCLUDED."action"
        AND existing."resource_type" = EXCLUDED."resource_type"
        AND existing."resource_id" = EXCLUDED."resource_id"
        AND existing."redacted_summary" = EXCLUDED."redacted_summary"
        AND existing."request_id" = EXCLUDED."request_id"
      RETURNING "resource_id"
    )
    SELECT updated."id", updated."state", recorded_approval."decision",
      recorded_approval."approvalId"
    FROM updated
    JOIN recorded_approval ON recorded_approval."operationId" = updated."id"::uuid
    JOIN audit ON audit."resource_id" = updated."id"
  `);
  const row = result.rows[0];
  if (
    !row
    || row.id !== input.operationId
    || !operationStates.includes(row.state as ProviderOperationState)
    || row.decision !== input.decision
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(row.approvalId)
  ) {
    return null;
  }
  return {
    id: row.id,
    state: row.state as ProviderOperationState,
    decision: row.decision,
    approvalId: row.approvalId,
    replayed: row.approvalId !== approvalId,
  };
}
