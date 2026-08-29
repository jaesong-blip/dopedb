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

import { assertPlan, safeRedactedValue } from "./provider-operation-records";
import { assertExecutionIdentity, type ProviderOperationExecutionIdentity } from "./provider-operation-authority";

export type NeonBranchSwitchCompletionRecord = Readonly<{
  operationId: string;
  connectionId: string;
  contentRevision: number;
  authorityRevision: number;
  targetBranchId: string;
}>;

export type NeonBranchSwitchCompletionRow = {
  operationId: string;
  connectionId: string;
  contentRevision: number | string;
  authorityRevision: number | string;
  targetBranchId: string;
};

/**
 * Commits one already approved and provider-verified branch switch. The old
 * lease epoch must be empty and owned by the exact connection revocation claim.
 * Canonical target discovery, connection target/revision, immutable version,
 * operation completion, and both audits succeed or roll back together.
 */
export async function completeNeonBranchSwitch(
  input: ProviderOperationExecutionIdentity & {
    claimId: string;
    connectionClaimId: string;
    plan: NeonBranchSwitchPlan;
    targetProjection: ProviderImportProjection;
    now: Date;
  },
): Promise<NeonBranchSwitchCompletionRecord | null> {
  assertExecutionIdentity(input);
  assertPlan({
    organizationId: input.authority.organizationId,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration,
    operationId: input.operationId,
    planHash: input.planHash,
    ownershipMarker: input.ownershipMarker,
    plan: input.plan,
  });
  const projection = input.targetProjection;
  const resource = projection.resource;
  const metadata = projection.metadata;
  if (
    input.kind !== "neon.branch.switch"
    || input.plan.kind !== "neon.branch.switch"
    || Number.isNaN(input.now.valueOf())
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.claimId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.connectionClaimId)
    || input.plan.source.authorityRevision >= 9_007_199_254_740_991
    || projection.fingerprint !== input.plan.target.resourceFingerprint
    || projection.fingerprint !== providerResourceFingerprint("neon", resource)
    || resource.project !== input.plan.target.projectId
    || resource.branch !== input.plan.target.branchId
    || resource.databaseId !== input.plan.target.databaseId
    || resource.database !== input.plan.target.database
    || resource.engine !== "postgres"
    || !Array.isArray(resource.schemas)
    || resource.schemas.length !== input.plan.source.schemas.length
    || resource.schemas.some((schema, index) => schema !== input.plan.source.schemas[index])
    || metadata.production !== (input.plan.target.environment === "production")
    || projection.capabilities.discover !== true
    || projection.capabilities.importReadOnly !== true
    || projection.capabilities.managedLease !== true
    || projection.capabilities.write !== true
    || projection.host !== "neon.managed.invalid"
    || projection.port !== 5432
    || projection.database !== input.plan.target.database
    || projection.engine !== "postgres"
    || projection.sslmode !== "verify-full"
  ) {
    throw new Error("Invalid Neon branch switch completion");
  }
  safeRedactedValue({
    resource: projection.resource,
    metadata: projection.metadata,
    capabilities: projection.capabilities,
  });
  const expectedAuthorityRevision = input.plan.source.authorityRevision + 1;
  const nextContentRevision = input.plan.source.contentRevision + 1;
  const committedAt = input.now.toISOString();
  if (
    !Number.isSafeInteger(expectedAuthorityRevision)
    || !Number.isSafeInteger(nextContentRevision)
  ) {
    throw new Error("Invalid Neon branch switch revision");
  }
  const versionPayload = {
    name: input.plan.source.connectionName,
    engine: "postgres" as const,
    provider: "neon" as const,
    driverId: null,
    host: projection.host,
    port: projection.port,
    database: projection.database,
    sslmode: projection.sslmode,
    readonlyDefault: input.plan.source.readonlyDefault,
    allowWrites: input.plan.source.allowWrites,
    env: input.plan.target.environment,
    schemaGroup: input.plan.source.schemaGroup,
    deleted: false,
  };
  const redactedResult = {
    version: 1,
    status: "ready",
    branchId: input.plan.target.branchId,
    providerOperationId: null,
    providerOperationStatus: null,
    endpointId: input.plan.target.endpointId,
    databaseCount: 1,
    databaseFingerprint: input.plan.target.databaseFingerprint,
    retiredInheritedRoleCount: null,
    credentialFenceFingerprint: null,
    managedAccessState: "ready",
    resourceFingerprint: input.plan.target.resourceFingerprint,
    failureCode: null,
    observedAt: input.now.toISOString(),
  };
  safeRedactedValue(redactedResult);
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
  const connectionAuditId = workspaceAuditEventId(
    "connection:neon-branch-switch",
    input.operationId,
  );
  const operationAuditId = workspaceAuditEventId(
    "provider-operation:switch-complete",
    input.claimId,
  );
  const sourceLockId = input.plan.source.branchId < input.plan.target.branchId
    ? input.plan.source.branchId
    : input.plan.target.branchId;
  const targetLockId = input.plan.source.branchId < input.plan.target.branchId
    ? input.plan.target.branchId
    : input.plan.source.branchId;
  const result = await db.execute<NeonBranchSwitchCompletionRow>(sql`
    WITH operation_scope AS MATERIALIZED (
      SELECT operation."id", operation."organization_id",
        operation."integration_id", operation."risk",
        operation."approval_policy"
      FROM ${workspaceProviderOperation} AS operation
      WHERE operation."id" = ${input.operationId}::uuid
        AND operation."organization_id" = ${input.authority.organizationId}
        AND operation."integration_id" = ${input.integrationId}::uuid
        AND operation."integration_generation" = ${input.integrationGeneration}
        AND operation."provider" = 'neon'
        AND operation."kind" = 'neon.branch.switch'
        AND operation."state" IN ('remote_started', 'reconciling')
        AND operation."claim_id" = ${input.claimId}::uuid
        AND operation."plan_hash" = ${input.planHash}
        AND operation."ownership_marker" = ${input.ownershipMarker}
        AND operation."redacted_plan" = ${JSON.stringify(input.plan)}::jsonb
        AND ${authority}
      FOR UPDATE OF operation
    ), source_branch_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(
        'provider-branch:' || operation_scope."organization_id" || ':'
        || operation_scope."integration_id"::text || ':neon:'
        || ${input.plan.source.projectId} || ':' || ${sourceLockId},
        0
      ))
      FROM operation_scope
    ), target_branch_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(
        'provider-branch:' || operation_scope."organization_id" || ':'
        || operation_scope."integration_id"::text || ':neon:'
        || ${input.plan.source.projectId} || ':' || ${targetLockId},
        0
      ))
      FROM operation_scope
      JOIN source_branch_lock ON TRUE
    ), connection_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(
        'connection:' || operation_scope."organization_id" || ':'
        || ${input.plan.source.connectionId},
        0
      ))
      FROM operation_scope
      JOIN target_branch_lock ON TRUE
    ), connection_scope AS MATERIALIZED (
      SELECT connection."id", connection."organization_id",
        connection."content_revision", connection."revision",
        parent."id" AS "parentVersionId"
      FROM ${workspaceConnection} AS connection
      JOIN operation_scope
        ON operation_scope."organization_id" = connection."organization_id"
      JOIN connection_lock ON TRUE
      JOIN ${workspaceConnectionGrant} AS manager_grant
        ON manager_grant."organization_id" = connection."organization_id"
       AND manager_grant."connection_id" = connection."id"
       AND manager_grant."member_id" = ${input.authority.membershipId}
       AND manager_grant."capability" = 'manage'
      JOIN ${workspaceProviderResource} AS source_resource
        ON source_resource."organization_id" = connection."organization_id"
       AND source_resource."id" = connection."provider_resource_id"
       AND source_resource."provider" = 'neon'
      JOIN ${workspaceResourceVersion} AS parent
        ON parent."organization_id" = connection."organization_id"
       AND parent."resource_type" = 'connection'
       AND parent."resource_id" = connection."id"
       AND parent."branch" = 'main'
       AND parent."revision" = connection."content_revision"
      WHERE connection."id" = ${input.plan.source.connectionId}::uuid
        AND connection."provider" = 'neon'
        AND connection."credential_mode" = 'managed'
        AND connection."provider_integration_id" = operation_scope."integration_id"
        AND connection."provider_resource_id" = ${input.plan.source.providerResourceId}::uuid
        AND source_resource."resource" = connection."provider_resource"
        AND connection."provider_resource"->>'project' = ${input.plan.source.projectId}
        AND connection."provider_resource"->>'branch' = ${input.plan.source.branchId}
        AND connection."provider_resource"->>'databaseId' = ${input.plan.source.databaseId}
        AND connection."provider_resource"->>'database' = ${input.plan.source.database}
        AND connection."name" = ${input.plan.source.connectionName}
        AND connection."readonly_default" = ${input.plan.source.readonlyDefault}
        AND connection."allow_writes" = ${input.plan.source.allowWrites}
        AND connection."schema_group" IS NOT DISTINCT FROM ${input.plan.source.schemaGroup}
        AND connection."environment" = ${input.plan.source.environment}
        AND connection."content_revision" = ${input.plan.source.contentRevision}
        AND connection."revision" = ${expectedAuthorityRevision}
        AND connection."revocation_pending_at" IS NOT NULL
        AND connection."revocation_claim_id" = ${input.connectionClaimId}::uuid
        AND connection."deleted_at" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM ${workspaceCredentialLease} AS live_lease
          WHERE live_lease."organization_id" = connection."organization_id"
            AND live_lease."connection_id" = connection."id"
            AND live_lease."revoked_at" IS NULL
        )
      FOR UPDATE OF connection, manager_grant, source_resource, parent
    ), canonical_resource AS MATERIALIZED (
      INSERT INTO ${workspaceProviderResource} AS existing_resource
        ("organization_id", "provider", "resource_fingerprint", "resource",
         "redacted_metadata", "capability_manifest", "updated_at")
      SELECT connection_scope."organization_id", 'neon', ${projection.fingerprint},
        ${JSON.stringify(projection.resource)}::jsonb,
        ${JSON.stringify(projection.metadata)}::jsonb,
        ${JSON.stringify(projection.capabilities)}::jsonb, ${committedAt}::timestamptz
      FROM connection_scope
      ON CONFLICT ("organization_id", "provider", "resource_fingerprint")
      DO UPDATE SET
        "resource" = EXCLUDED."resource",
        "redacted_metadata" = EXCLUDED."redacted_metadata",
        "capability_manifest" = EXCLUDED."capability_manifest",
        "updated_at" = EXCLUDED."updated_at"
      WHERE existing_resource."resource" = EXCLUDED."resource"
      RETURNING "id", "organization_id"
    ), target_scope AS MATERIALIZED (
      SELECT canonical_resource."id", canonical_resource."organization_id"
      FROM canonical_resource
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${workspaceConnection} AS target_connection
        WHERE target_connection."organization_id" = canonical_resource."organization_id"
          AND target_connection."provider_resource_id" = canonical_resource."id"
          AND target_connection."id" <> ${input.plan.source.connectionId}::uuid
          AND target_connection."deleted_at" IS NULL
      )
    ), updated_connection AS MATERIALIZED (
      UPDATE ${workspaceConnection} AS connection
      SET "host" = ${projection.host},
        "port" = ${projection.port},
        "database_name" = ${projection.database},
        "sslmode" = ${projection.sslmode},
        "environment" = ${input.plan.target.environment},
        "provider_resource_id" = target_scope."id",
        "provider_resource" = ${JSON.stringify(projection.resource)}::jsonb,
        "content_revision" = connection."content_revision" + 1,
        "revocation_pending_at" = NULL,
        "revocation_claimed_at" = NULL,
        "revocation_claim_id" = NULL,
        "updated_at" = ${committedAt}::timestamptz
      FROM connection_scope, target_scope
      WHERE connection."id" = connection_scope."id"
        AND connection."organization_id" = connection_scope."organization_id"
        AND connection."content_revision" = connection_scope."content_revision"
        AND connection."revision" = connection_scope."revision"
        AND connection."revocation_claim_id" = ${input.connectionClaimId}::uuid
      RETURNING connection."id", connection."organization_id",
        connection."content_revision", connection."revision",
        connection_scope."parentVersionId"
    ), version AS MATERIALIZED (
      INSERT INTO ${workspaceResourceVersion}
        ("id", "organization_id", "resource_type", "resource_id", "revision",
         "base_revision", "parent_version_id", "branch", "operation", "payload",
         "payload_hash", "created_by_user_id")
      SELECT gen_random_uuid(), updated_connection."organization_id", 'connection',
        updated_connection."id", updated_connection."content_revision",
        ${input.plan.source.contentRevision}, updated_connection."parentVersionId",
        'main', 'update', ${JSON.stringify(versionPayload)}::jsonb,
        ${canonicalHash(versionPayload)}, ${input.authority.userId}
      FROM updated_connection
      RETURNING "resource_id"
    ), completed_operation AS MATERIALIZED (
      UPDATE ${workspaceProviderOperation} AS operation
      SET "state" = 'succeeded',
        "provider_resource_id" = ${input.plan.target.branchId},
        "redacted_result" = ${JSON.stringify(redactedResult)}::jsonb,
        "failure_code" = NULL,
        "reconcile_after" = NULL,
        "completed_at" = ${committedAt}::timestamptz,
        "updated_at" = ${committedAt}::timestamptz
      FROM operation_scope, updated_connection, version
      WHERE operation."id" = operation_scope."id"
        AND operation."organization_id" = operation_scope."organization_id"
        AND version."resource_id" = updated_connection."id"
        AND operation."state" IN ('remote_started', 'reconciling')
      RETURNING operation."id", operation."organization_id",
        operation."risk", operation."approval_policy"
    ), connection_audit AS (
      INSERT INTO ${workspaceAuditEvent} AS existing
        ("id", "organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${connectionAuditId}::uuid, updated_connection."organization_id",
        ${input.authority.userId}, 'connection.provider_target.switch', 'connection',
        updated_connection."id"::text,
        jsonb_build_object(
          'provider', 'neon',
          'sourceBranchId', ${input.plan.source.branchId}::text,
          'targetBranchId', ${input.plan.target.branchId}::text,
          'contentRevision', updated_connection."content_revision",
          'authorityRevision', updated_connection."revision",
          'activeLeaseCount', ${input.plan.impact.activeLeaseCount}::int
        ), ${input.claimId}::uuid
      FROM updated_connection
      JOIN completed_operation ON TRUE
      ON CONFLICT ("id") DO UPDATE SET "id" = existing."id"
      WHERE existing."organization_id" = EXCLUDED."organization_id"
        AND existing."actor_user_id" = EXCLUDED."actor_user_id"
        AND existing."action" = EXCLUDED."action"
        AND existing."resource_type" = EXCLUDED."resource_type"
        AND existing."resource_id" = EXCLUDED."resource_id"
        AND existing."redacted_summary" = EXCLUDED."redacted_summary"
        AND existing."request_id" = EXCLUDED."request_id"
      RETURNING "resource_id"
    ), operation_audit AS (
      INSERT INTO ${workspaceAuditEvent} AS existing
        ("id", "organization_id", "actor_user_id", "action", "resource_type",
         "resource_id", "redacted_summary", "request_id")
      SELECT ${operationAuditId}::uuid, completed_operation."organization_id",
        ${input.authority.userId}, 'provider.operation.succeeded',
        'provider_operation', completed_operation."id"::text,
        jsonb_build_object(
          'provider', 'neon',
          'kind', 'neon.branch.switch',
          'connectionId', updated_connection."id"::text,
          'sourceBranchId', ${input.plan.source.branchId}::text,
          'targetBranchId', ${input.plan.target.branchId}::text,
          'resourceFingerprint', ${input.plan.target.resourceFingerprint}::text,
          'risk', completed_operation."risk",
          'approvalPolicy', completed_operation."approval_policy"
        ), ${input.claimId}::uuid
      FROM completed_operation
      JOIN updated_connection ON TRUE
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
    SELECT completed_operation."id"::text AS "operationId",
      updated_connection."id"::text AS "connectionId",
      updated_connection."content_revision" AS "contentRevision",
      updated_connection."revision" AS "authorityRevision",
      ${input.plan.target.branchId}::text AS "targetBranchId"
    FROM completed_operation
    JOIN updated_connection ON TRUE
    JOIN connection_audit
      ON connection_audit."resource_id" = updated_connection."id"::text
    JOIN operation_audit
      ON operation_audit."resource_id" = completed_operation."id"::text
  `);
  const row = result.rows[0];
  const contentRevision = row ? Number(row.contentRevision) : Number.NaN;
  const authorityRevision = row ? Number(row.authorityRevision) : Number.NaN;
  if (
    !row
    || row.operationId !== input.operationId
    || row.connectionId !== input.plan.source.connectionId
    || row.targetBranchId !== input.plan.target.branchId
    || contentRevision !== nextContentRevision
    || authorityRevision !== expectedAuthorityRevision
  ) {
    return null;
  }
  return {
    operationId: row.operationId,
    connectionId: row.connectionId,
    contentRevision,
    authorityRevision,
    targetBranchId: row.targetBranchId,
  };
}
