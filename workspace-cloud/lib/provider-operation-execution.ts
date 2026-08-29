import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import {
  providerMutationAuthoritySql,
  type ProviderMutationAuthority,
} from "./provider-integrations/authority";
import { verifyProviderOperationOwnershipMarker } from "./provider-operation-marker";
import {
  member,
  session,
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceCredentialLease,
  workspaceProviderIntegration,
  workspaceProviderOperation,
  workspaceProviderOperationApproval,
  workspaceProviderResource,
  workspaceResourceVersion,
} from "./schema";
import { workspaceAuditEventId } from "./workspace-audit-id";
import { canonicalHash, canonicalJson } from "./workspace-versioning";
import {
  MAX_PROVIDER_RESULTS,
  providerResourceFingerprint,
  type ProviderImportProjection,
} from "./providers/adapter-contract";
import type { NeonBranchCreatePlan } from "./providers/neon-branch-plan";
import type { NeonBranchDeletePlan } from "./providers/neon-branch-delete-plan";
import type { NeonBranchSwitchPlan } from "./providers/neon-branch-switch-plan";
import { NEON_OPERATION_STATUSES } from "./providers/neon-branch-mutation";
import { ProviderRequestError } from "./providers/provider-types";

import { type ProviderOperationCancellationRecord, type ProviderOperationExecutionClaim, type ProviderOperationRemoteStart, type ProviderOperationState } from "./provider-operation-records";
import { assertExecutionIdentity, currentExecutionAuthoritySql, type ProviderOperationExecutionIdentity } from "./provider-operation-authority";

export type ProviderOperationClaimRow = {
  id: string;
  state: string;
  claimId: string;
  previousState: string;
};

export type ProviderOperationCancellationRow = {
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
        AND operation."kind" = ${input.kind}
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
          'kind', ${input.kind}::text,
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
    retiredInheritedRoleCount: null,
    credentialFenceFingerprint: null,
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
        AND operation."kind" = ${input.kind}
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
          'kind', ${input.kind}::text,
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

export type ProviderOperationRemoteStartRow = ProviderOperationClaimRow;

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
    WITH authorized_operation AS MATERIALIZED (
      SELECT operation."id", operation."organization_id", operation."state",
        operation."claim_id", operation."risk", operation."approval_policy",
        operation."plan_expires_at", operation."integration_id",
        operation."provider", operation."kind", operation."resource_scope",
        operation."source_resource_id", operation."redacted_plan"
      FROM ${workspaceProviderOperation} AS operation
      WHERE operation."id" = ${input.operationId}::uuid
        AND operation."organization_id" = ${input.authority.organizationId}
        AND operation."integration_id" = ${input.integrationId}::uuid
        AND operation."provider" = 'neon'
        AND operation."kind" = ${input.kind}
        AND operation."integration_generation" = ${input.integrationGeneration}
        AND operation."plan_hash" = ${input.planHash}
        AND operation."ownership_marker" = ${input.ownershipMarker}
        AND operation."claim_id" = ${input.claimId}::uuid
        AND operation."state" IN ('claimed', 'remote_started', 'reconciling')
        AND ${authority}
      FOR UPDATE OF operation
    ), branch_lock AS MATERIALIZED (
      -- Managed imports take this same provider identity lock before their
      -- fresh snapshot. Whichever mutation wins becomes durable before the
      -- other can decide whether the branch is still safe to reference.
      SELECT pg_advisory_xact_lock(hashtextextended(
        'provider-branch:' || authorized_operation."organization_id"::text || ':'
        || authorized_operation."integration_id"::text || ':'
        || authorized_operation."provider" || ':'
        || authorized_operation."resource_scope" || ':'
        || CASE WHEN authorized_operation."kind" = 'neon.branch.switch'
          THEN LEAST(
            authorized_operation."source_resource_id",
            authorized_operation."redacted_plan"->'target'->>'branchId'
          )
          ELSE authorized_operation."source_resource_id"
        END,
        0
      ))
      FROM authorized_operation
    ), target_branch_lock AS MATERIALIZED (
      -- A connection switch owns both branch identities. Managed import uses
      -- the same target lock, so an approved switch cannot race a second
      -- connection into the destination between validation and commit.
      SELECT pg_advisory_xact_lock(hashtextextended(
        'provider-branch:' || authorized_operation."organization_id"::text || ':'
        || authorized_operation."integration_id"::text || ':'
        || authorized_operation."provider" || ':'
        || authorized_operation."resource_scope" || ':'
        || CASE WHEN authorized_operation."kind" = 'neon.branch.switch'
          THEN GREATEST(
            authorized_operation."source_resource_id",
            authorized_operation."redacted_plan"->'target'->>'branchId'
          )
          ELSE authorized_operation."source_resource_id"
        END,
        0
      ))
      FROM authorized_operation
      JOIN branch_lock ON TRUE
    ), switch_connection AS MATERIALIZED (
      SELECT branch_connection."id", authorized_operation."id" AS "operationId"
      FROM authorized_operation
      JOIN target_branch_lock ON TRUE
      JOIN ${workspaceConnection} AS branch_connection
        ON branch_connection."organization_id" = authorized_operation."organization_id"
       AND branch_connection."id" = (
         authorized_operation."redacted_plan"->'source'->>'connectionId'
       )::uuid
      JOIN ${workspaceConnectionGrant} AS manager_grant
        ON manager_grant."organization_id" = branch_connection."organization_id"
       AND manager_grant."connection_id" = branch_connection."id"
       AND manager_grant."member_id" = ${input.authority.membershipId}
       AND manager_grant."capability" = 'manage'
      WHERE authorized_operation."kind" = 'neon.branch.switch'
        AND branch_connection."provider" = 'neon'
        AND branch_connection."credential_mode" = 'managed'
        AND branch_connection."provider_integration_id" = authorized_operation."integration_id"
        AND branch_connection."provider_resource_id"::text
          = authorized_operation."redacted_plan"->'source'->>'providerResourceId'
        AND branch_connection."provider_resource"->>'project'
          = authorized_operation."resource_scope"
        AND branch_connection."provider_resource"->>'branch'
          = authorized_operation."source_resource_id"
        AND branch_connection."provider_resource"->>'databaseId'
          = authorized_operation."redacted_plan"->'source'->>'databaseId'
        AND branch_connection."content_revision" = (
          authorized_operation."redacted_plan"->'source'->>'contentRevision'
        )::bigint
        AND branch_connection."revision" = (
          authorized_operation."redacted_plan"->'source'->>'authorityRevision'
        )::bigint
        AND branch_connection."deleted_at" IS NULL
        AND branch_connection."revocation_pending_at" IS NULL
        AND branch_connection."revocation_claim_id" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM ${workspaceConnection} AS target_connection
          WHERE target_connection."organization_id" = branch_connection."organization_id"
            AND target_connection."id" <> branch_connection."id"
            AND target_connection."provider" = 'neon'
            AND target_connection."credential_mode" = 'managed'
            AND target_connection."provider_integration_id" = authorized_operation."integration_id"
            AND target_connection."provider_resource"->>'project'
              = authorized_operation."resource_scope"
            AND target_connection."provider_resource"->>'branch'
              = authorized_operation."redacted_plan"->'target'->>'branchId'
            AND target_connection."provider_resource"->>'databaseId'
              = authorized_operation."redacted_plan"->'target'->>'databaseId'
            AND target_connection."deleted_at" IS NULL
        )
      FOR UPDATE OF branch_connection, manager_grant
    ), candidate AS MATERIALIZED (
      SELECT authorized_operation.*
      FROM authorized_operation
      JOIN target_branch_lock ON TRUE
      LEFT JOIN switch_connection
        ON switch_connection."operationId" = authorized_operation."id"
      WHERE (
        authorized_operation."kind" <> 'neon.branch.delete'
        OR (
          NOT EXISTS (
            SELECT 1
            FROM ${workspaceConnection} AS branch_connection
            WHERE branch_connection."organization_id" = authorized_operation."organization_id"
              AND branch_connection."provider_integration_id" = authorized_operation."integration_id"
              AND branch_connection."provider" = authorized_operation."provider"
              AND branch_connection."credential_mode" = 'managed'
              AND branch_connection."provider_resource" ->> 'project'
                = authorized_operation."resource_scope"
              AND branch_connection."provider_resource" ->> 'branch'
                = authorized_operation."source_resource_id"
              AND branch_connection."deleted_at" IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${workspaceConnection} AS leased_connection
            JOIN ${workspaceCredentialLease} AS active_lease
              ON active_lease."organization_id" = leased_connection."organization_id"
             AND active_lease."connection_id" = leased_connection."id"
             AND active_lease."integration_id" = authorized_operation."integration_id"
             AND active_lease."revoked_at" IS NULL
             AND active_lease."expires_at" > now()
            WHERE leased_connection."organization_id" = authorized_operation."organization_id"
              AND leased_connection."provider_integration_id" = authorized_operation."integration_id"
              AND leased_connection."provider" = authorized_operation."provider"
              AND leased_connection."credential_mode" = 'managed'
              AND leased_connection."provider_resource" ->> 'project'
                = authorized_operation."resource_scope"
              AND leased_connection."provider_resource" ->> 'branch'
                = authorized_operation."source_resource_id"
          )
        )
      )
        AND (
          authorized_operation."kind" <> 'neon.branch.switch'
          OR switch_connection."id" IS NOT NULL
        )
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
          'kind', ${input.kind}::text,
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
