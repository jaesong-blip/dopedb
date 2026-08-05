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
import { NEON_OPERATION_STATUSES } from "./providers/neon-branch-mutation";

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
  "claimProviderOperationExecution",
  "cancelExpiredProviderOperationExecution",
  "markProviderOperationRemoteStarted",
  "applyProviderOperationReconciliation",
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

export type ProviderOperationExecutionClaim = Readonly<{
  id: string;
  state: ProviderOperationState;
  claimId: string;
  claimedNow: boolean;
}>;

export type ProviderOperationRemoteStart = Readonly<{
  id: string;
  state: "remote_started" | "reconciling" | "cancelled";
  claimId: string;
  startedNow: boolean;
}>;

export type ProviderOperationCancellationRecord = Readonly<{
  id: string;
  state: "cancelled";
  providerOperationId: null;
  providerResourceId: null;
  reconcileAfter: null;
  endpointId: null;
  databaseCount: null;
  databaseFingerprint: null;
  managedAccessState: "unavailable";
  failureCode: null;
}>;

export type ProviderOperationExecutionRecord = ProviderOperationPlanRecord & Readonly<{
  claimId: string | null;
  remoteStartedAt: Date | null;
  providerOperationId: string | null;
  providerResourceId: string | null;
  reconcileAfter: Date | null;
  endpointId: string | null;
  databaseCount: number | null;
  databaseFingerprint: string | null;
  managedAccessState: ProviderManagedAccessState | null;
  failureCode: string | null;
}>;

export type ProviderManagedAccessState =
  | "waiting_for_provider"
  | "not_requested"
  | "bootstrap_required"
  | "ready"
  | "needs_repair"
  | "unavailable";

const managedAccessStates: readonly ProviderManagedAccessState[] = [
  "waiting_for_provider",
  "not_requested",
  "bootstrap_required",
  "ready",
  "needs_repair",
  "unavailable",
];

export type ProviderOperationReconciliationInput = Readonly<{
  status: "missing" | "pending" | "ready" | "conflict" | "failed";
  branchId: string | null;
  providerOperationId: string | null;
  providerOperationStatus: string | null;
  endpointId: string | null;
  databaseCount: number | null;
  databaseFingerprint: string | null;
  managedAccessState: ProviderManagedAccessState;
  failureCode: string | null;
}>;

export type ProviderOperationReconciliationRecord = Readonly<{
  id: string;
  state: ProviderOperationState;
  claimId: string;
  providerOperationId: string | null;
  providerResourceId: string | null;
  reconcileAfter: Date | null;
  endpointId: string | null;
  databaseCount: number | null;
  databaseFingerprint: string | null;
  managedAccessState: ProviderManagedAccessState;
  failureCode: string | null;
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

type ProviderOperationExecutionRow = ProviderOperationPlanRow & {
  claimId: string | null;
  remoteStartedAt: Date | string | null;
  providerOperationId: string | null;
  providerResourceId: string | null;
  reconcileAfter: Date | string | null;
  redactedResult: unknown;
  failureCode: string | null;
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

function optionalDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = planDate(value);
  if (!date) throw new Error("Invalid provider operation execution state");
  return date;
}

function executionResultProjection(value: unknown): Readonly<{
  endpointId: string | null;
  databaseCount: number | null;
  databaseFingerprint: string | null;
  managedAccessState: ProviderManagedAccessState | null;
}> | null {
  if (value === null) {
    return {
      endpointId: null,
      databaseCount: null,
      databaseFingerprint: null,
      managedAccessState: null,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const endpointId = result.endpointId === undefined || result.endpointId === null
    ? null
    : result.endpointId;
  const databaseCount = result.databaseCount === undefined
    || result.databaseCount === null
    ? null
    : result.databaseCount;
  const databaseFingerprint = result.databaseFingerprint === undefined
    || result.databaseFingerprint === null
    ? null
    : result.databaseFingerprint;
  const managedAccessState = result.managedAccessState === undefined
    || result.managedAccessState === null
    ? null
    : result.managedAccessState;
  if (
    (endpointId !== null && (
      typeof endpointId !== "string"
      || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(endpointId)
    ))
    || (databaseCount !== null && (
      typeof databaseCount !== "number"
      || !Number.isInteger(databaseCount)
      || databaseCount < 0
      || databaseCount > 200
    ))
    || (databaseFingerprint !== null && (
      typeof databaseFingerprint !== "string"
      || !/^[0-9a-f]{64}$/.test(databaseFingerprint)
    ))
    || ((databaseCount === null) !== (databaseFingerprint === null))
    || (managedAccessState !== null && (
      typeof managedAccessState !== "string"
      || !managedAccessStates.includes(managedAccessState as ProviderManagedAccessState)
    ))
  ) {
    return null;
  }
  return {
    endpointId: endpointId as string | null,
    databaseCount: databaseCount as number | null,
    databaseFingerprint: databaseFingerprint as string | null,
    managedAccessState: managedAccessState as ProviderManagedAccessState | null,
  };
}

export async function loadProviderOperationExecution(input: {
  organizationId: string;
  integrationId: string;
  integrationGeneration: bigint;
  operationId: string;
}): Promise<ProviderOperationExecutionRecord | null> {
  const result = await db.execute<ProviderOperationExecutionRow>(sql`
    SELECT operation."id"::text AS "id", operation."state" AS "state",
      operation."plan_hash" AS "planHash",
      operation."plan_expires_at" AS "planExpiresAt",
      operation."risk" AS "risk",
      operation."approval_policy" AS "approvalPolicy",
      operation."redacted_plan" AS "redactedPlan",
      operation."ownership_marker" AS "ownershipMarker",
      operation."claim_id"::text AS "claimId",
      operation."remote_started_at" AS "remoteStartedAt",
      operation."provider_operation_id" AS "providerOperationId",
      operation."provider_resource_id" AS "providerResourceId",
      operation."reconcile_after" AS "reconcileAfter",
      operation."redacted_result" AS "redactedResult",
      operation."failure_code" AS "failureCode"
    FROM ${workspaceProviderOperation} AS operation
    WHERE operation."id" = ${input.operationId}::uuid
      AND operation."organization_id" = ${input.organizationId}
      AND operation."integration_id" = ${input.integrationId}::uuid
      AND operation."provider" = 'neon'
      AND operation."kind" = 'neon.branch.create'
      AND operation."integration_generation" = ${input.integrationGeneration}
    LIMIT 1
  `);
  const row = result.rows[0];
  const plan = planRecord(row, {
    organizationId: input.organizationId,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration,
    operationId: input.operationId,
  });
  const executionResult = row ? executionResultProjection(row.redactedResult) : null;
  if (
    !row
    || !plan
    || !executionResult
    || (row.claimId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(row.claimId))
    || (row.providerOperationId !== null
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(row.providerOperationId))
    || (row.providerResourceId !== null
      && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(row.providerResourceId))
    || (row.failureCode !== null
      && !/^[A-Z][A-Z0-9_]{0,95}$/.test(row.failureCode))
  ) {
    return null;
  }
  return {
    ...plan,
    claimId: row.claimId,
    remoteStartedAt: optionalDate(row.remoteStartedAt),
    providerOperationId: row.providerOperationId,
    providerResourceId: row.providerResourceId,
    reconcileAfter: optionalDate(row.reconcileAfter),
    ...executionResult,
    failureCode: row.failureCode,
  };
}

type ProviderOperationExecutionIdentity = {
  authority: ProviderMutationAuthority;
  integrationId: string;
  integrationGeneration: bigint;
  operationId: string;
  planHash: string;
  ownershipMarker: string;
};

function assertExecutionIdentity(input: ProviderOperationExecutionIdentity) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.integrationId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.operationId)
    || !/^[0-9a-f]{64}$/.test(input.planHash)
    || input.integrationGeneration < 1n
    || !verifyProviderOperationOwnershipMarker({
      organizationId: input.authority.organizationId,
      integrationId: input.integrationId,
      integrationGeneration: input.integrationGeneration,
      operationId: input.operationId,
      planHash: input.planHash,
      marker: input.ownershipMarker,
    })
  ) {
    throw new Error("Invalid provider operation execution identity");
  }
}

function currentExecutionAuthoritySql(input: ProviderOperationExecutionIdentity) {
  const actor = providerMutationAuthoritySql({
    ...input.authority,
    requireManager: true,
    integration: {
      id: input.integrationId,
      provider: "neon",
      generation: input.integrationGeneration,
      claimId: null,
    },
  });
  return sql`${actor} AND EXISTS (
    SELECT 1
    FROM ${workspaceProviderOperationApproval} AS operation_approval
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
    JOIN ${session} AS approver_session
      ON approver_session."id" = operation_approval."actor_session_id"
     AND approver_session."user_id" = operation_approval."actor_user_id"
     AND approver_session."expires_at" > now()
    JOIN ${member} AS approver_member
      ON approver_member."id" = operation_approval."actor_member_id"
     AND approver_member."organization_id" = operation_approval."organization_id"
     AND approver_member."user_id" = operation_approval."actor_user_id"
     AND approver_member."role" = operation_approval."actor_role"
     AND approver_member."role" IN ('admin', 'owner')
     AND approver_member."revocation_pending_at" IS NULL
     AND approver_member."revocation_claim_id" IS NULL
    WHERE operation_approval."organization_id" = operation."organization_id"
      AND operation_approval."operation_id" = operation."id"
      AND operation_approval."plan_hash" = operation."plan_hash"
      AND operation_approval."decision" = 'approved'
      AND (
        operation."approval_policy" <> 'separate_admin'
        OR (
          operation_approval."actor_member_id" <> operation."requested_by_member_id"
          AND operation_approval."actor_user_id" <> operation."requested_by_user_id"
        )
      )
    FOR UPDATE OF operation_approval, requester_session, requester_member,
      approver_session, approver_member
  )`;
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

type ProviderOperationClaimRow = {
  id: string;
  state: string;
  claimId: string;
  previousState: string;
};

type ProviderOperationCancellationRow = {
  id: string;
  state: string;
  providerOperationId: string | null;
  providerResourceId: string | null;
  reconcileAfter: Date | string | null;
  failureCode: string | null;
};

// A plan that expired before the remote-start fence can be closed by any
// current workspace manager. This path deliberately does not require the
// requester or approver sessions to remain live: it only removes authority and
// is what lets a claim recover after the process or original session exits.
export async function cancelExpiredProviderOperationExecution(
  input: ProviderOperationExecutionIdentity & { now: Date },
): Promise<ProviderOperationCancellationRecord | null> {
  assertExecutionIdentity(input);
  if (Number.isNaN(input.now.valueOf())) {
    throw new Error("Invalid provider operation cancellation time");
  }
  const auditId = workspaceAuditEventId(
    "provider-operation:cancel-expired",
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
  const result = await db.execute<ProviderOperationCancellationRow>(sql`
    WITH candidate AS MATERIALIZED (
      SELECT operation."id", operation."organization_id", operation."state",
        operation."risk", operation."approval_policy"
      FROM ${workspaceProviderOperation} AS operation
      WHERE operation."id" = ${input.operationId}::uuid
        AND operation."organization_id" = ${input.authority.organizationId}
        AND operation."integration_id" = ${input.integrationId}::uuid
        AND operation."provider" = 'neon'
        AND operation."kind" = 'neon.branch.create'
        AND operation."integration_generation" = ${input.integrationGeneration}
        AND operation."plan_hash" = ${input.planHash}
        AND operation."ownership_marker" = ${input.ownershipMarker}
        AND operation."state" IN ('approved', 'claimed')
        AND operation."remote_started_at" IS NULL
        AND operation."plan_expires_at" <= now()
        AND ${authority}
      FOR UPDATE OF operation
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceProviderOperation} AS operation
      SET "state" = 'cancelled',
        "reconcile_after" = NULL,
        "completed_at" = ${input.now},
        "updated_at" = ${input.now}
      FROM candidate
      WHERE operation."id" = candidate."id"
        AND operation."organization_id" = candidate."organization_id"
        AND operation."state" = candidate."state"
      RETURNING operation."id"::text AS "id", operation."state" AS "state",
        operation."provider_operation_id" AS "providerOperationId",
        operation."provider_resource_id" AS "providerResourceId",
        operation."reconcile_after" AS "reconcileAfter",
        operation."failure_code" AS "failureCode",
        operation."organization_id" AS "organizationId",
        candidate."risk" AS "risk",
        candidate."approval_policy" AS "approvalPolicy"
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent} AS existing
        ("id", "organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${auditId}::uuid, updated."organizationId",
        ${input.authority.userId}, 'provider.operation.cancelled',
        'provider_operation', updated."id",
        jsonb_build_object(
          'provider', 'neon',
          'kind', 'neon.branch.create',
          'reason', 'plan_expired_before_remote_start',
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
    SELECT updated."id", updated."state", updated."providerOperationId",
      updated."providerResourceId", updated."reconcileAfter",
      updated."failureCode"
    FROM updated
    JOIN audit ON audit."resource_id" = updated."id"
  `);
  const row = result.rows[0];
  if (
    !row
    || row.id !== input.operationId
    || row.state !== "cancelled"
    || row.providerOperationId !== null
    || row.providerResourceId !== null
    || row.reconcileAfter !== null
    || row.failureCode !== null
  ) {
    return null;
  }
  return {
    id: row.id,
    state: "cancelled",
    providerOperationId: null,
    providerResourceId: null,
    reconcileAfter: null,
    endpointId: null,
    databaseCount: null,
    databaseFingerprint: null,
    managedAccessState: "unavailable",
    failureCode: null,
  };
}

export async function claimProviderOperationExecution(
  input: ProviderOperationExecutionIdentity & { now: Date },
): Promise<ProviderOperationExecutionClaim | null> {
  assertExecutionIdentity(input);
  if (Number.isNaN(input.now.valueOf())) {
    throw new Error("Invalid provider operation claim time");
  }
  const claimId = crypto.randomUUID();
  const auditId = workspaceAuditEventId("provider-operation:claim", claimId);
  const authority = currentExecutionAuthoritySql(input);
  const result = await db.execute<ProviderOperationClaimRow>(sql`
    WITH candidate AS MATERIALIZED (
      SELECT operation."id", operation."organization_id", operation."state",
        operation."claim_id", operation."risk", operation."approval_policy"
      FROM ${workspaceProviderOperation} AS operation
      WHERE operation."id" = ${input.operationId}::uuid
        AND operation."organization_id" = ${input.authority.organizationId}
        AND operation."integration_id" = ${input.integrationId}::uuid
        AND operation."provider" = 'neon'
        AND operation."kind" = 'neon.branch.create'
        AND operation."integration_generation" = ${input.integrationGeneration}
        AND operation."plan_hash" = ${input.planHash}
        AND operation."ownership_marker" = ${input.ownershipMarker}
        AND operation."state" IN (
          'approved', 'claimed', 'remote_started', 'reconciling'
        )
        AND (
          operation."state" <> 'approved'
          OR operation."plan_expires_at" > now()
        )
        AND ${authority}
      FOR UPDATE OF operation
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceProviderOperation} AS operation
      SET "state" = CASE
          WHEN candidate."state" = 'approved' THEN 'claimed'
          ELSE operation."state"
        END,
        "claim_id" = CASE
          WHEN candidate."state" = 'approved' THEN ${claimId}::uuid
          ELSE operation."claim_id"
        END,
        "claimed_at" = CASE
          WHEN candidate."state" = 'approved' THEN ${input.now}
          ELSE operation."claimed_at"
        END,
        "updated_at" = CASE
          WHEN candidate."state" = 'approved' THEN ${input.now}
          ELSE operation."updated_at"
        END
      FROM candidate
      WHERE operation."id" = candidate."id"
        AND operation."organization_id" = candidate."organization_id"
        AND operation."state" = candidate."state"
      RETURNING operation."id"::text AS "id", operation."state" AS "state",
        operation."claim_id"::text AS "claimId",
        candidate."state" AS "previousState",
        operation."organization_id" AS "organizationId",
        candidate."risk" AS "risk",
        candidate."approval_policy" AS "approvalPolicy"
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent} AS existing
        ("id", "organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${auditId}::uuid, updated."organizationId",
        ${input.authority.userId}, 'provider.operation.claim',
        'provider_operation', updated."id",
        jsonb_build_object(
          'provider', 'neon',
          'kind', 'neon.branch.create',
          'risk', updated."risk",
          'approvalPolicy', updated."approvalPolicy"
        ), updated."claimId"::uuid
      FROM updated
      WHERE updated."previousState" = 'approved'
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
    SELECT updated."id", updated."state", updated."claimId",
      updated."previousState"
    FROM updated
    LEFT JOIN audit ON audit."resource_id" = updated."id"
    WHERE updated."previousState" <> 'approved' OR audit."resource_id" IS NOT NULL
  `);
  const row = result.rows[0];
  if (
    !row
    || row.id !== input.operationId
    || !["claimed", "remote_started", "reconciling"].includes(row.state)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(row.claimId)
  ) {
    return null;
  }
  return {
    id: row.id,
    state: row.state as ProviderOperationState,
    claimId: row.claimId,
    claimedNow: row.previousState === "approved",
  };
}

type ProviderOperationRemoteStartRow = ProviderOperationClaimRow;

export async function markProviderOperationRemoteStarted(
  input: ProviderOperationExecutionIdentity & { claimId: string; now: Date },
): Promise<ProviderOperationRemoteStart | null> {
  assertExecutionIdentity(input);
  if (
    Number.isNaN(input.now.valueOf())
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.claimId)
  ) {
    throw new Error("Invalid provider operation remote-start context");
  }
  const auditId = workspaceAuditEventId(
    "provider-operation:remote-start",
    input.claimId,
  );
  const authority = currentExecutionAuthoritySql(input);
  const result = await db.execute<ProviderOperationRemoteStartRow>(sql`
    WITH candidate AS MATERIALIZED (
      SELECT operation."id", operation."organization_id", operation."state",
        operation."claim_id", operation."risk", operation."approval_policy",
        operation."plan_expires_at"
      FROM ${workspaceProviderOperation} AS operation
      WHERE operation."id" = ${input.operationId}::uuid
        AND operation."organization_id" = ${input.authority.organizationId}
        AND operation."integration_id" = ${input.integrationId}::uuid
        AND operation."provider" = 'neon'
        AND operation."kind" = 'neon.branch.create'
        AND operation."integration_generation" = ${input.integrationGeneration}
        AND operation."plan_hash" = ${input.planHash}
        AND operation."ownership_marker" = ${input.ownershipMarker}
        AND operation."claim_id" = ${input.claimId}::uuid
        AND operation."state" IN ('claimed', 'remote_started', 'reconciling')
        AND ${authority}
      FOR UPDATE OF operation
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceProviderOperation} AS operation
      SET "state" = CASE
          WHEN candidate."state" = 'claimed'
            AND candidate."plan_expires_at" <= now() THEN 'cancelled'
          WHEN candidate."state" = 'claimed' THEN 'remote_started'
          ELSE operation."state"
        END,
        "remote_started_at" = CASE
          WHEN candidate."state" = 'claimed'
            AND candidate."plan_expires_at" > now() THEN ${input.now}
          ELSE operation."remote_started_at"
        END,
        "completed_at" = CASE
          WHEN candidate."state" = 'claimed'
            AND candidate."plan_expires_at" <= now() THEN ${input.now}
          ELSE operation."completed_at"
        END,
        "updated_at" = CASE
          WHEN candidate."state" = 'claimed' THEN ${input.now}
          ELSE operation."updated_at"
        END
      FROM candidate
      WHERE operation."id" = candidate."id"
        AND operation."organization_id" = candidate."organization_id"
        AND operation."state" = candidate."state"
      RETURNING operation."id"::text AS "id", operation."state" AS "state",
        operation."claim_id"::text AS "claimId",
        candidate."state" AS "previousState",
        operation."organization_id" AS "organizationId",
        candidate."risk" AS "risk",
        candidate."approval_policy" AS "approvalPolicy"
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent} AS existing
        ("id", "organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${auditId}::uuid, updated."organizationId",
        ${input.authority.userId}, CASE
          WHEN updated."state" = 'cancelled' THEN 'provider.operation.cancelled'
          ELSE 'provider.operation.remote_started'
        END,
        'provider_operation', updated."id",
        jsonb_build_object(
          'provider', 'neon',
          'kind', 'neon.branch.create',
          'reason', CASE
            WHEN updated."state" = 'cancelled'
              THEN 'plan_expired_before_remote_start'
            ELSE NULL
          END,
          'risk', updated."risk",
          'approvalPolicy', updated."approvalPolicy"
        ), updated."claimId"::uuid
      FROM updated
      WHERE updated."previousState" = 'claimed'
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
    SELECT updated."id", updated."state", updated."claimId",
      updated."previousState"
    FROM updated
    LEFT JOIN audit ON audit."resource_id" = updated."id"
    WHERE updated."previousState" <> 'claimed' OR audit."resource_id" IS NOT NULL
  `);
  const row = result.rows[0];
  if (
    !row
    || row.id !== input.operationId
    || !["remote_started", "reconciling", "cancelled"].includes(row.state)
    || row.claimId !== input.claimId
  ) {
    return null;
  }
  return {
    id: row.id,
    state: row.state as ProviderOperationRemoteStart["state"],
    claimId: row.claimId,
    startedNow: row.previousState === "claimed" && row.state === "remote_started",
  };
}

type ProviderOperationReconciliationRow = {
  id: string;
  state: string;
  claimId: string;
  providerOperationId: string | null;
  providerResourceId: string | null;
  reconcileAfter: Date | string | null;
  redactedResult: unknown;
  failureCode: string | null;
};

function validProviderReconciliation(input: ProviderOperationReconciliationInput) {
  const branchValid = input.branchId === null
    || /^[a-z0-9][a-z0-9-]{0,59}$/.test(input.branchId);
  const endpointValid = input.endpointId === null
    || /^[a-z0-9][a-z0-9-]{0,59}$/.test(input.endpointId);
  const operationValid = input.providerOperationId === null
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.providerOperationId);
  const statusValid = input.providerOperationStatus === null
    || NEON_OPERATION_STATUSES.includes(
      input.providerOperationStatus as typeof NEON_OPERATION_STATUSES[number],
    );
  const failureValid = input.failureCode === null
    || /^[A-Z][A-Z0-9_]{0,95}$/.test(input.failureCode);
  const databaseValid = (
    input.databaseCount === null
    && input.databaseFingerprint === null
  ) || (
    Number.isInteger(input.databaseCount)
    && input.databaseCount !== null
    && input.databaseCount >= 0
    && input.databaseCount <= 200
    && typeof input.databaseFingerprint === "string"
    && /^[0-9a-f]{64}$/.test(input.databaseFingerprint)
  );
  return ["missing", "pending", "ready", "conflict", "failed"].includes(input.status)
    && branchValid
    && endpointValid
    && operationValid
    && statusValid
    && failureValid
    && databaseValid
    && managedAccessStates.includes(input.managedAccessState)
    && (input.status !== "missing" || input.branchId === null)
    && (input.status !== "pending" || input.branchId !== null)
    && (input.status !== "ready" || (
      input.branchId !== null
      && input.failureCode === null
      && input.databaseCount !== null
      && input.databaseCount > 0
      && input.databaseFingerprint !== null
      && (input.managedAccessState === "not_requested"
        || input.managedAccessState === "bootstrap_required")
    ))
    && (input.status !== "missing"
      || input.managedAccessState === "waiting_for_provider")
    && (input.status !== "pending" || (
      input.managedAccessState === "waiting_for_provider"
      && input.databaseCount === null
      && input.databaseFingerprint === null
    ))
    && (input.status !== "conflict"
      || input.managedAccessState === "needs_repair")
    && (input.status !== "failed" || input.managedAccessState === (
      input.branchId === null ? "unavailable" : "needs_repair"
    ))
    && ((input.status !== "conflict" && input.status !== "failed")
      || input.failureCode !== null)
    && ((input.status === "conflict" || input.status === "failed")
      || input.failureCode === null);
}

export async function applyProviderOperationReconciliation(
  input: ProviderOperationExecutionIdentity & {
    claimId: string;
    result: ProviderOperationReconciliationInput;
    now: Date;
  },
): Promise<ProviderOperationReconciliationRecord | null> {
  assertExecutionIdentity(input);
  if (
    Number.isNaN(input.now.valueOf())
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.claimId)
    || !validProviderReconciliation(input.result)
  ) {
    throw new Error("Invalid provider operation reconciliation");
  }
  const redactedResult = {
    version: 1,
    status: input.result.status,
    branchId: input.result.branchId,
    providerOperationId: input.result.providerOperationId,
    providerOperationStatus: input.result.providerOperationStatus,
    endpointId: input.result.endpointId,
    databaseCount: input.result.databaseCount,
    databaseFingerprint: input.result.databaseFingerprint,
    managedAccessState: input.result.managedAccessState,
    failureCode: input.result.failureCode,
    observedAt: input.now.toISOString(),
  };
  safeRedactedValue(redactedResult);
  const reconcileAuditId = workspaceAuditEventId(
    "provider-operation:reconcile",
    input.claimId,
  );
  const completionAuditId = workspaceAuditEventId(
    "provider-operation:complete",
    input.claimId,
  );
  const missingCutoff = new Date(input.now.valueOf() - 2 * 60 * 1_000);
  const targetState = sql`CASE
    WHEN ${input.result.status} = 'ready' THEN 'succeeded'
    WHEN ${input.result.status} = 'conflict' THEN 'needs_repair'
    WHEN ${input.result.status} = 'failed' AND ${input.result.branchId}::text IS NULL
      THEN 'failed'
    WHEN ${input.result.status} = 'failed' THEN 'needs_repair'
    WHEN ${input.result.status} = 'missing'
      AND operation."remote_started_at" <= ${missingCutoff} THEN 'needs_repair'
    ELSE 'reconciling'
  END`;
  const targetFailureCode = sql`CASE
    WHEN ${input.result.status} IN ('conflict', 'failed')
      THEN ${input.result.failureCode}::text
    WHEN ${input.result.status} = 'missing'
      AND operation."remote_started_at" <= ${missingCutoff}
      THEN 'NEON_CREATE_RESULT_AMBIGUOUS'
    ELSE NULL
  END`;
  // Once the remote-start fence exists, reconciliation is recovery work: no
  // Provider mutation is issued here. A current manager may therefore finish
  // observing and recording the exact fenced operation even if the original
  // requester or approver session has since expired or been revoked.
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
  const result = await db.execute<ProviderOperationReconciliationRow>(sql`
    WITH candidate AS MATERIALIZED (
      SELECT operation."id", operation."organization_id", operation."state",
        operation."claim_id", operation."risk", operation."approval_policy"
      FROM ${workspaceProviderOperation} AS operation
      WHERE operation."id" = ${input.operationId}::uuid
        AND operation."organization_id" = ${input.authority.organizationId}
        AND operation."integration_id" = ${input.integrationId}::uuid
        AND operation."provider" = 'neon'
        AND operation."kind" = 'neon.branch.create'
        AND operation."integration_generation" = ${input.integrationGeneration}
        AND operation."plan_hash" = ${input.planHash}
        AND operation."ownership_marker" = ${input.ownershipMarker}
        AND operation."claim_id" = ${input.claimId}::uuid
        AND operation."state" IN ('remote_started', 'reconciling')
        AND (
          operation."provider_operation_id" IS NULL
          OR ${input.result.providerOperationId}::text IS NULL
          OR operation."provider_operation_id" = ${input.result.providerOperationId}
        )
        AND (
          operation."provider_resource_id" IS NULL
          OR ${input.result.branchId}::text IS NULL
          OR operation."provider_resource_id" = ${input.result.branchId}
        )
        AND (
          operation."redacted_result" IS NULL
          OR operation."redacted_result"->>'endpointId' IS NULL
          OR ${input.result.endpointId}::text IS NULL
          OR operation."redacted_result"->>'endpointId' = ${input.result.endpointId}
        )
        AND (
          operation."redacted_result" IS NULL
          OR operation."redacted_result"->>'databaseFingerprint' IS NULL
          OR ${input.result.databaseFingerprint}::text IS NULL
          OR operation."redacted_result"->>'databaseFingerprint'
            = ${input.result.databaseFingerprint}
        )
        AND ${authority}
      FOR UPDATE OF operation
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceProviderOperation} AS operation
      SET "state" = ${targetState},
        "provider_operation_id" = COALESCE(
          operation."provider_operation_id", ${input.result.providerOperationId}
        ),
        "provider_resource_id" = COALESCE(
          operation."provider_resource_id", ${input.result.branchId}
        ),
        "redacted_result" = ${JSON.stringify(redactedResult)}::jsonb
          || jsonb_build_object(
            'endpointId', COALESCE(
              ${input.result.endpointId}::text,
              operation."redacted_result"->>'endpointId'
            )
          ),
        "failure_code" = ${targetFailureCode},
        "reconcile_after" = CASE
          WHEN ${targetState} = 'reconciling'
            THEN ${new Date(input.now.valueOf() + 3_000)}
          ELSE NULL
        END,
        "completed_at" = CASE
          WHEN ${targetState} = 'reconciling' THEN NULL
          ELSE ${input.now}
        END,
        "updated_at" = ${input.now}
      FROM candidate
      WHERE operation."id" = candidate."id"
        AND operation."organization_id" = candidate."organization_id"
        AND operation."state" = candidate."state"
      RETURNING operation."id"::text AS "id", operation."state" AS "state",
        operation."claim_id"::text AS "claimId",
        operation."provider_operation_id" AS "providerOperationId",
        operation."provider_resource_id" AS "providerResourceId",
        operation."reconcile_after" AS "reconcileAfter",
        operation."redacted_result" AS "redactedResult",
        operation."failure_code" AS "failureCode",
        operation."organization_id" AS "organizationId",
        candidate."state" AS "previousState",
        candidate."risk" AS "risk",
        candidate."approval_policy" AS "approvalPolicy"
    ), reconcile_audit AS (
      INSERT INTO ${workspaceAuditEvent} AS existing
        ("id", "organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${reconcileAuditId}::uuid, updated."organizationId",
        ${input.authority.userId}, 'provider.operation.reconciling',
        'provider_operation', updated."id",
        jsonb_build_object(
          'provider', 'neon',
          'kind', 'neon.branch.create',
          'observation', ${input.result.status}::text,
          'branchId', ${input.result.branchId}::text,
          'providerOperationId', ${input.result.providerOperationId}::text,
          'risk', updated."risk",
          'approvalPolicy', updated."approvalPolicy"
        ), updated."claimId"::uuid
      FROM updated
      WHERE updated."previousState" = 'remote_started'
      ON CONFLICT ("id") DO UPDATE SET "id" = existing."id"
      WHERE existing."organization_id" = EXCLUDED."organization_id"
        AND existing."actor_user_id" = EXCLUDED."actor_user_id"
        AND existing."action" = EXCLUDED."action"
        AND existing."resource_type" = EXCLUDED."resource_type"
        AND existing."resource_id" = EXCLUDED."resource_id"
        AND existing."redacted_summary" = EXCLUDED."redacted_summary"
        AND existing."request_id" = EXCLUDED."request_id"
      RETURNING "resource_id"
    ), completion_audit AS (
      INSERT INTO ${workspaceAuditEvent} AS existing
        ("id", "organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${completionAuditId}::uuid, updated."organizationId",
        ${input.authority.userId},
        'provider.operation.' || updated."state",
        'provider_operation', updated."id",
        jsonb_build_object(
          'provider', 'neon',
          'kind', 'neon.branch.create',
          'state', updated."state",
          'branchId', updated."providerResourceId",
          'providerOperationId', updated."providerOperationId",
          'endpointId', updated."redactedResult"->>'endpointId',
          'databaseCount', updated."redactedResult"->'databaseCount',
          'databaseFingerprint', updated."redactedResult"->>'databaseFingerprint',
          'managedAccessState', updated."redactedResult"->>'managedAccessState',
          'failureCode', updated."failureCode",
          'risk', updated."risk",
          'approvalPolicy', updated."approvalPolicy"
        ), updated."claimId"::uuid
      FROM updated
      WHERE updated."state" <> 'reconciling'
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
    SELECT updated."id", updated."state", updated."claimId",
      updated."providerOperationId", updated."providerResourceId",
      updated."reconcileAfter", updated."redactedResult",
      updated."failureCode"
    FROM updated
    LEFT JOIN reconcile_audit
      ON reconcile_audit."resource_id" = updated."id"
    LEFT JOIN completion_audit
      ON completion_audit."resource_id" = updated."id"
    WHERE (
      updated."previousState" <> 'remote_started'
      OR reconcile_audit."resource_id" IS NOT NULL
    ) AND (
      updated."state" = 'reconciling'
      OR completion_audit."resource_id" IS NOT NULL
    )
  `);
  const row = result.rows[0];
  const reconcileAfter = row ? optionalDate(row.reconcileAfter) : null;
  const executionResult = row ? executionResultProjection(row.redactedResult) : null;
  if (
    !row
    || !executionResult
    || row.id !== input.operationId
    || row.claimId !== input.claimId
    || !operationStates.includes(row.state as ProviderOperationState)
    || (row.providerOperationId !== null
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(row.providerOperationId))
    || (row.providerResourceId !== null
      && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(row.providerResourceId))
    || (row.failureCode !== null && !/^[A-Z][A-Z0-9_]{0,95}$/.test(row.failureCode))
  ) {
    return null;
  }
  return {
    id: row.id,
    state: row.state as ProviderOperationState,
    claimId: row.claimId,
    providerOperationId: row.providerOperationId,
    providerResourceId: row.providerResourceId,
    reconcileAfter,
    ...executionResult,
    managedAccessState: executionResult.managedAccessState ?? "unavailable",
    failureCode: row.failureCode,
  };
}
