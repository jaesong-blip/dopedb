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
  workspaceAuditEvent,
  workspaceProviderIntegration,
  workspaceProviderOperation,
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
] as const);

export type ProviderOperationPlanRecord = Readonly<{
  id: string;
  state: ProviderOperationState;
  planHash: string;
  planExpiresAt: Date;
  risk: "standard" | "production_data";
  approvalPolicy: "single_admin" | "separate_admin";
  plan: NeonBranchCreatePlan;
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
  // A replay returns the originally generated operation and marker. The caller
  // verifies the returned plan hash; marker verification for replays happens in
  // the execution transition against the durable row, not a discarded candidate.
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
    replayed: row.id !== input.operationId,
  };
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
