// Durable Neon branch-operation boundary. Planning performs no Provider
// mutation; approval revalidates one fresh complete inventory before recording
// the exact decision. Execution owns the later remote-start fence.
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";

import { db } from "../../../../../../../../../lib/db";
import { env } from "../../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../../lib/http";
import {
  activeProviderIntegration,
  revokeActiveLeases,
  type ActiveProviderIntegration,
  verifiedNeonProjectCredential,
} from "../../../../../../../../../lib/provider-integrations";
import type { ProviderMutationAuthority } from "../../../../../../../../../lib/provider-integrations/authority";
import { providerOperationOwnershipMarker } from "../../../../../../../../../lib/provider-operation-marker";
import {
  applyProviderOperationReconciliation,
  cancelExpiredProviderOperationExecution,
  claimProviderOperationExecution,
  completeNeonBranchSwitch,
  decideProviderOperation,
  listProviderOperationExecutions,
  loadProviderOperationExecution,
  loadProviderOperationPlan,
  markProviderOperationRemoteStarted,
  neonBranchManagedAccessBoundaryFor,
  recordProviderOperationPlan,
  type ProviderOperationDecision,
  type ProviderOperationExecutionRecord,
  type ProviderOperationReconciliationInput,
} from "../../../../../../../../../lib/provider-operation-store";
import { MAX_PROVIDER_RESULTS } from "../../../../../../../../../lib/providers/adapter-contract";
import {
  buildNeonBranchCreatePlan,
  NeonBranchPlanError,
  parseNeonBranchCreatePlanRequest,
  revalidateNeonBranchCreatePlan,
} from "../../../../../../../../../lib/providers/neon-branch-plan";
import {
  buildNeonBranchDeletePlan,
  NeonBranchDeletePlanError,
  parseNeonBranchDeletePlanRequest,
  revalidateNeonBranchDeletePlan,
} from "../../../../../../../../../lib/providers/neon-branch-delete-plan";
import {
  buildNeonBranchSwitchPlan,
  NeonBranchSwitchPlanError,
  parseNeonBranchSwitchPlanRequest,
  revalidateNeonBranchSwitchPlan,
  revalidateNeonBranchSwitchTarget,
  type NeonBranchSwitchPlan,
} from "../../../../../../../../../lib/providers/neon-branch-switch-plan";
import {
  createNeonBranch,
  deleteNeonBranch,
  listNeonBranchEndpointIds,
  listNeonBranchInventory,
  listNeonDatabases,
  neonBranchDatabaseFingerprint,
  NeonBranchMutationRequestError,
  reconcileNeonBranchCreate,
  reconcileNeonBranchDelete,
  validateNeonResource,
  verifyNeonBranchOwnership,
} from "../../../../../../../../../lib/providers/neon";
import { parseNeonResource } from "../../../../../../../../../lib/providers/neon-core";
import { providerImportProjection } from "../../../../../../../../../lib/providers/import-projection";
import { ProviderRequestError } from "../../../../../../../../../lib/providers/provider-types";
import {
  workspaceConnection,
  workspaceCredentialLease,
  workspaceProviderResource,
} from "../../../../../../../../../lib/schema";
import {
  clearRevocationGate,
  claimRevocationGate,
  releaseRevocationGateClaim,
} from "../../../../../../../../../lib/revocation-gates";
import {
  authorizeWorkspace,
  authorizeWorkspaceConnection,
} from "../../../../../../../../../lib/workspace-authorization";
import { providerResourceSupportsWrite } from "../../../../../../../../../lib/workspace-connections";
import { canonicalHash } from "../../../../../../../../../lib/workspace-versioning";

type RouteContext = {
  params: Promise<{ workspaceId: string; integrationId: string }>;
};

type OperationBody =
  | Readonly<{ action: "planCreate"; request: unknown }>
  | Readonly<{
    action: "decideCreate";
    operationId: string;
    planHash: string;
    decision: ProviderOperationDecision;
  }>
  | Readonly<{
    action: "executeCreate";
    operationId: string;
    planHash: string;
  }>
  | Readonly<{ action: "planDelete"; request: unknown }>
  | Readonly<{
    action: "decideDelete";
    operationId: string;
    planHash: string;
    decision: ProviderOperationDecision;
  }>
  | Readonly<{
    action: "executeDelete";
    operationId: string;
    planHash: string;
  }>
  | Readonly<{ action: "planSwitch"; request: unknown }>
  | Readonly<{
    action: "decideSwitch";
    operationId: string;
    planHash: string;
    decision: ProviderOperationDecision;
  }>
  | Readonly<{
    action: "executeSwitch";
    operationId: string;
    planHash: string;
  }>;

export const maxDuration = 60;

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, integrationId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(integrationId)) {
    return jsonError("Invalid workspace or integration id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Workspace access denied", 403);
  }
  const integration = await activeProviderIntegration(workspaceId, integrationId);
  if (!integration || integration.provider !== "neon") {
    return jsonError("Neon integration not found", 404);
  }
  try {
    const operations = await listProviderOperationExecutions({
      organizationId: workspaceId,
      integrationId,
      integrationGeneration: integration.generation,
      currentMemberId: authorization.membership.id,
      currentUserId: authorization.session.user.id,
    });
    const now = Date.now();
    return privateJson({
      integrationGeneration: integration.generation.toString(),
      operations: operations.map((operation) => {
        const expired = operation.planExpiresAt.valueOf() <= now;
        const needsCredentialFenceRecovery = operation.state === "succeeded"
          && operation.plan.kind === "neon.branch.create"
          && operation.plan.target.endpoint === "read_write"
          && (
            operation.retiredInheritedRoleCount === null
            || operation.credentialFenceFingerprint === null
          );
        const canApprove = operation.state === "awaiting_approval"
          && !expired
          && (
            operation.approvalPolicy === "single_admin"
            || !operation.requestedByCurrentActor
          );
        const canExecute = needsCredentialFenceRecovery
          || operation.state === "remote_started"
          || operation.state === "reconciling"
          || (
            (operation.state === "approved" || operation.state === "claimed")
            && operation.executionAuthorityLive
          );
        return {
          id: operation.id,
          state: operation.state,
          planHash: operation.planHash,
          planExpiresAt: operation.planExpiresAt.toISOString(),
          expired,
          risk: operation.risk,
          approvalPolicy: operation.approvalPolicy,
          requestedByCurrentActor: operation.requestedByCurrentActor,
          canApprove,
          canReject: operation.state === "awaiting_approval",
          canExecute,
          needsCredentialFenceRecovery,
          providerOperationId: operation.providerOperationId,
          branchId: operation.providerResourceId,
          reconcileAfter: operation.reconcileAfter?.toISOString() ?? null,
          endpointId: operation.endpointId,
          databaseCount: operation.databaseCount,
          retiredInheritedRoleCount: operation.retiredInheritedRoleCount,
          managedAccessState: operation.managedAccessState,
          failureCode: operation.failureCode,
          plan: operation.plan,
        };
      }),
    });
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Neon branch operation inventory failed", 502);
  }
}

function exactOperationBody(value: unknown): OperationBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    (body.action === "planCreate"
      || body.action === "planDelete"
      || body.action === "planSwitch")
    && Object.keys(body).length === 2
    && Object.prototype.hasOwnProperty.call(body, "request")
  ) {
    return { action: body.action, request: body.request };
  }
  if (
    (body.action === "decideCreate"
      || body.action === "decideDelete"
      || body.action === "decideSwitch")
    && Object.keys(body).length === 4
    && Object.prototype.hasOwnProperty.call(body, "operationId")
    && Object.prototype.hasOwnProperty.call(body, "planHash")
    && Object.prototype.hasOwnProperty.call(body, "decision")
    && typeof body.operationId === "string"
    && isUuid(body.operationId)
    && typeof body.planHash === "string"
    && /^[0-9a-f]{64}$/.test(body.planHash)
    && (body.decision === "approved" || body.decision === "rejected")
  ) {
    return {
      action: body.action,
      operationId: body.operationId,
      planHash: body.planHash,
      decision: body.decision,
    };
  }
  if (
    (body.action === "executeCreate"
      || body.action === "executeDelete"
      || body.action === "executeSwitch")
    && Object.keys(body).length === 3
    && Object.prototype.hasOwnProperty.call(body, "operationId")
    && Object.prototype.hasOwnProperty.call(body, "planHash")
    && typeof body.operationId === "string"
    && isUuid(body.operationId)
    && typeof body.planHash === "string"
    && /^[0-9a-f]{64}$/.test(body.planHash)
  ) {
    return {
      action: body.action,
      operationId: body.operationId,
      planHash: body.planHash,
    };
  }
  return null;
}

async function livePlanContext(input: {
  workspaceId: string;
  integrationId: string;
  integration: ActiveProviderIntegration;
  projectId: string;
  sourceBranchId: string;
}) {
  const credential = await verifiedNeonProjectCredential(
    input.integration,
    input.projectId,
  );
  const [inventory, connectionRows] = await Promise.all([
    listNeonBranchInventory(credential, input.projectId),
    db.select({
      environment: workspaceConnection.environment,
      resource: workspaceConnection.providerResource,
    }).from(workspaceConnection).where(and(
      eq(workspaceConnection.organizationId, input.workspaceId),
      eq(workspaceConnection.providerIntegrationId, input.integrationId),
      eq(workspaceConnection.credentialMode, "managed"),
      isNull(workspaceConnection.deletedAt),
      isNull(workspaceConnection.revocationPendingAt),
    )).limit(MAX_PROVIDER_RESULTS + 1),
  ]);
  if (connectionRows.length > MAX_PROVIDER_RESULTS) {
    throw new ProviderRequestError(
      "neon",
      "Workspace Neon connection scope is too large to plan safely",
      409,
    );
  }
  let workspaceProductionReference = false;
  for (const row of connectionRows) {
    let resource;
    try {
      resource = parseNeonResource(row.resource);
    } catch {
      throw new ProviderRequestError(
        "neon",
        "Workspace Neon connection target is invalid",
        409,
      );
    }
    if (
      resource.project === input.projectId
      && resource.branch === input.sourceBranchId
      && row.environment === "production"
    ) {
      workspaceProductionReference = true;
    }
  }
  return { credential, inventory, workspaceProductionReference };
}

async function liveDeletePlanContext(input: {
  workspaceId: string;
  integrationId: string;
  integration: ActiveProviderIntegration;
  projectId: string;
  branchId: string;
}) {
  const credential = await verifiedNeonProjectCredential(
    input.integration,
    input.projectId,
  );
  const now = new Date();
  const [inventory, connectionRows, activeLeaseRows, ownership, endpointIds] = await Promise.all([
    listNeonBranchInventory(credential, input.projectId),
    db.select({
      id: workspaceConnection.id,
      resource: workspaceConnection.providerResource,
      deletedAt: workspaceConnection.deletedAt,
    }).from(workspaceConnection).where(and(
      eq(workspaceConnection.organizationId, input.workspaceId),
      eq(workspaceConnection.providerIntegrationId, input.integrationId),
      eq(workspaceConnection.credentialMode, "managed"),
    )).limit(MAX_PROVIDER_RESULTS + 1),
    db.select({
      connectionId: workspaceCredentialLease.connectionId,
      activeLeaseCount: count(),
    }).from(workspaceCredentialLease).where(and(
      eq(workspaceCredentialLease.organizationId, input.workspaceId),
      eq(workspaceCredentialLease.integrationId, input.integrationId),
      isNull(workspaceCredentialLease.revokedAt),
      gt(workspaceCredentialLease.expiresAt, now),
    )).groupBy(workspaceCredentialLease.connectionId).limit(MAX_PROVIDER_RESULTS + 1),
    neonBranchManagedAccessBoundaryFor({
      organizationId: input.workspaceId,
      integrationId: input.integrationId,
      integrationGeneration: input.integration.generation,
      projectId: input.projectId,
      branchId: input.branchId,
    }),
    listNeonBranchEndpointIds(credential, input.projectId, input.branchId),
  ]);
  if (
    connectionRows.length > MAX_PROVIDER_RESULTS
    || activeLeaseRows.length > MAX_PROVIDER_RESULTS
  ) {
    throw new ProviderRequestError(
      "neon",
      "Workspace Neon reference scope is too large to plan safely",
      409,
    );
  }
  if (!ownership) {
    throw new ProviderRequestError(
      "neon",
      "Only a DopeDB-owned Neon branch can be deleted",
      409,
    );
  }
  const owned = await verifyNeonBranchOwnership({
    credential,
    projectId: input.projectId,
    branchId: input.branchId,
    operationId: ownership.operationId,
    planHash: ownership.planHash,
    ownershipMarker: ownership.ownershipMarker,
  });
  if (!owned) {
    throw new ProviderRequestError(
      "neon",
      "Neon branch ownership marker changed",
      409,
    );
  }
  const activeLeases = new Map(
    activeLeaseRows.map((row) => [row.connectionId, row.activeLeaseCount]),
  );
  let connectionCount = 0;
  let activeLeaseCount = 0;
  for (const row of connectionRows) {
    let resource;
    try {
      resource = parseNeonResource(row.resource);
    } catch {
      throw new ProviderRequestError(
        "neon",
        "Workspace Neon connection target is invalid",
        409,
      );
    }
    if (
      resource.project !== input.projectId
      || resource.branch !== input.branchId
    ) {
      continue;
    }
    if (row.deletedAt === null) connectionCount += 1;
    activeLeaseCount += activeLeases.get(row.id) ?? 0;
  }
  return {
    credential,
    inventory,
    ownership,
    references: {
      connectionCount,
      activeLeaseCount,
      endpointIds,
    },
  };
}

async function liveSwitchTargetContext(input: {
  workspaceId: string;
  integrationId: string;
  integration: ActiveProviderIntegration;
  projectId: string;
  targetBranchId: string;
  database: string;
  schemas: readonly string[];
  targetEnvironment: "development" | "production";
}) {
  const credential = await verifiedNeonProjectCredential(
    input.integration,
    input.projectId,
  );
  const [inventory, databases, boundary] = await Promise.all([
    listNeonBranchInventory(credential, input.projectId),
    listNeonDatabases(credential, input.projectId, input.targetBranchId),
    neonBranchManagedAccessBoundaryFor({
      organizationId: input.workspaceId,
      integrationId: input.integrationId,
      integrationGeneration: input.integration.generation,
      projectId: input.projectId,
      branchId: input.targetBranchId,
    }),
  ]);
  const targetBranches = inventory.branches.filter(
    (branch) => branch.id === input.targetBranchId,
  );
  const targetBranch = targetBranches.length === 1 ? targetBranches[0] : null;
  const matchingDatabases = databases.filter(
    (database) => database.name === input.database,
  );
  const targetDatabase = matchingDatabases.length === 1 ? matchingDatabases[0] : null;
  const databaseFingerprint = neonBranchDatabaseFingerprint(databases);
  if (
    !targetBranch
    || !targetDatabase
    || (boundary !== null && (
      boundary.state !== "succeeded"
      || boundary.managedAccessState !== "ready"
      || boundary.branchId !== input.targetBranchId
      || boundary.endpointId === null
      || boundary.databaseFingerprint !== databaseFingerprint
    ))
  ) {
    throw new ProviderRequestError(
      "neon",
      "Neon target branch managed access is not ready",
      409,
    );
  }
  const resource = parseNeonResource({
    project: input.projectId,
    branch: input.targetBranchId,
    databaseId: targetDatabase.id,
    database: targetDatabase.name,
    engine: "postgres",
    schemas: [...input.schemas],
  });
  const verification = await validateNeonResource(
    credential,
    resource,
    "write",
    input.targetEnvironment === "production",
  );
  if (boundary && verification.endpointId !== boundary.endpointId) {
    throw new ProviderRequestError(
      "neon",
      "Neon target endpoint identity changed",
      409,
    );
  }
  const projection = providerImportProjection("neon", resource, {
    production: input.targetEnvironment === "production",
    writeAvailable: true,
    neonBranchTarget: {
      provider: "neon",
      projectId: input.projectId,
      branchId: targetBranch.id,
      name: targetBranch.name,
      currentState: targetBranch.currentState,
      pendingState: targetBranch.pendingState,
      default: targetBranch.default,
      protected: targetBranch.protected,
    },
  });
  return {
    credential,
    inventory,
    projection,
    target: {
      branch: targetBranch,
      databaseId: targetDatabase.id,
      database: targetDatabase.name,
      endpointId: verification.endpointId,
      databaseFingerprint,
      resourceFingerprint: projection.fingerprint,
      managedAccessOperationId: boundary?.operationId ?? null,
    },
  };
}

async function liveSwitchPlanContext(input: {
  workspaceId: string;
  integrationId: string;
  integration: ActiveProviderIntegration;
  connectionId: string;
  projectId: string;
  targetBranchId: string;
  targetEnvironment: "development" | "production";
}) {
  const now = new Date();
  const [connectionRows, activeLeaseRows] = await Promise.all([
    db.select({
      id: workspaceConnection.id,
      name: workspaceConnection.name,
      providerResourceId: workspaceConnection.providerResourceId,
      resource: workspaceConnection.providerResource,
      canonicalResource: workspaceProviderResource.resource,
      capabilityManifest: workspaceProviderResource.capabilityManifest,
      environment: workspaceConnection.environment,
      readonlyDefault: workspaceConnection.readonlyDefault,
      allowWrites: workspaceConnection.allowWrites,
      schemaGroup: workspaceConnection.schemaGroup,
      contentRevision: workspaceConnection.contentRevision,
      authorityRevision: workspaceConnection.revision,
      revocationPendingAt: workspaceConnection.revocationPendingAt,
    }).from(workspaceConnection).innerJoin(
      workspaceProviderResource,
      and(
        eq(workspaceProviderResource.organizationId, workspaceConnection.organizationId),
        eq(workspaceProviderResource.id, workspaceConnection.providerResourceId),
        eq(workspaceProviderResource.provider, workspaceConnection.provider),
      ),
    ).where(and(
      eq(workspaceConnection.organizationId, input.workspaceId),
      eq(workspaceConnection.id, input.connectionId),
      eq(workspaceConnection.providerIntegrationId, input.integrationId),
      eq(workspaceConnection.provider, "neon"),
      eq(workspaceConnection.credentialMode, "managed"),
      isNull(workspaceConnection.deletedAt),
    )).limit(2),
    db.select({ activeLeaseCount: count() }).from(workspaceCredentialLease).where(and(
      eq(workspaceCredentialLease.organizationId, input.workspaceId),
      eq(workspaceCredentialLease.connectionId, input.connectionId),
      eq(workspaceCredentialLease.integrationId, input.integrationId),
      isNull(workspaceCredentialLease.revokedAt),
      gt(workspaceCredentialLease.expiresAt, now),
    )),
  ]);
  const connection = connectionRows.length === 1 ? connectionRows[0] : null;
  const connectionEnvironment = connection?.environment;
  if (
    !connection
    || !connection.providerResourceId
    || connection.revocationPendingAt !== null
    || (connectionEnvironment !== "development" && connectionEnvironment !== "production")
    || canonicalHash(connection.resource) !== canonicalHash(connection.canonicalResource)
    || (connection.allowWrites
      && !providerResourceSupportsWrite(connection.capabilityManifest))
  ) {
    throw new ProviderRequestError(
      "neon",
      "Neon source connection is not ready for a target switch",
      409,
    );
  }
  const stableEnvironment: "development" | "production" = connectionEnvironment;
  const source = parseNeonResource(connection.resource);
  if (source.project !== input.projectId || source.branch === input.targetBranchId) {
    throw new ProviderRequestError(
      "neon",
      "Neon connection target does not match the switch request",
      409,
    );
  }
  const targetReferences = await db.select({ id: workspaceConnection.id })
    .from(workspaceConnection).where(and(
      eq(workspaceConnection.organizationId, input.workspaceId),
      eq(workspaceConnection.providerIntegrationId, input.integrationId),
      eq(workspaceConnection.provider, "neon"),
      eq(workspaceConnection.credentialMode, "managed"),
      isNull(workspaceConnection.deletedAt),
      sql`${workspaceConnection.id} <> ${input.connectionId}::uuid`,
      sql`${workspaceConnection.providerResource} ->> 'project' = ${input.projectId}`,
      sql`${workspaceConnection.providerResource} ->> 'branch' = ${input.targetBranchId}`,
      sql`${workspaceConnection.providerResource} ->> 'database' = ${source.database}`,
    )).limit(1);
  if (targetReferences.length > 0) {
    throw new ProviderRequestError(
      "neon",
      "Neon target database is already shared by another connection",
      409,
    );
  }
  const target = await liveSwitchTargetContext({
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    integration: input.integration,
    projectId: input.projectId,
    targetBranchId: input.targetBranchId,
    database: source.database,
    schemas: source.schemas,
    targetEnvironment: input.targetEnvironment,
  });
  const activeLeaseCount = activeLeaseRows[0]?.activeLeaseCount ?? 0;
  return {
    ...target,
    connection: {
      connectionId: connection.id,
      connectionName: connection.name,
      providerResourceId: connection.providerResourceId,
      projectId: source.project,
      sourceBranchId: source.branch,
      databaseId: source.databaseId,
      database: source.database,
      schemas: source.schemas,
      environment: stableEnvironment,
      readonlyDefault: connection.readonlyDefault,
      allowWrites: connection.allowWrites,
      schemaGroup: connection.schemaGroup,
      contentRevision: connection.contentRevision,
      authorityRevision: connection.authorityRevision,
      activeLeaseCount,
    },
  };
}

async function authorizeSwitchConnection(
  request: Request,
  workspaceId: string,
  connectionId: string,
) {
  const authorization = await authorizeWorkspaceConnection(
    request,
    workspaceId,
    connectionId,
    "manage",
  );
  return authorization.ok ? null : jsonError(authorization.error, authorization.status);
}

async function recordSwitchFailure(input: {
  authority: ProviderMutationAuthority;
  integrationId: string;
  integrationGeneration: bigint;
  operation: ProviderOperationExecutionRecord & { plan: NeonBranchSwitchPlan };
  claimId: string;
  failureCode: string;
}) {
  return applyProviderOperationReconciliation({
    authority: input.authority,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration,
    operationId: input.operation.id,
    kind: "neon.branch.switch",
    planHash: input.operation.planHash,
    ownershipMarker: input.operation.ownershipMarker,
    claimId: input.claimId,
    result: {
      status: "conflict",
      branchId: input.operation.plan.target.branchId,
      providerOperationId: null,
      providerOperationStatus: null,
      endpointId: null,
      databaseCount: null,
      databaseFingerprint: null,
      retiredInheritedRoleCount: null,
      credentialFenceFingerprint: null,
      managedAccessState: "needs_repair",
      failureCode: input.failureCode,
    },
    now: new Date(),
  });
}

function executionResponse(operation: ProviderOperationExecutionRecord | {
  id: string;
  state: string;
  providerOperationId: string | null;
  providerResourceId: string | null;
  reconcileAfter: Date | null;
  endpointId: string | null;
  databaseCount: number | null;
  databaseFingerprint: string | null;
  retiredInheritedRoleCount: number | null;
  credentialFenceFingerprint: string | null;
  managedAccessState: string | null;
  failureCode: string | null;
}) {
  return {
    operation: {
      id: operation.id,
      state: operation.state,
      providerOperationId: operation.providerOperationId,
      branchId: operation.providerResourceId,
      reconcileAfter: operation.reconcileAfter?.toISOString() ?? null,
      endpointId: operation.endpointId,
      databaseCount: operation.databaseCount,
      databaseFingerprint: operation.databaseFingerprint,
      retiredInheritedRoleCount: operation.retiredInheritedRoleCount,
      credentialFenceFingerprint: operation.credentialFenceFingerprint,
      managedAccessState: operation.managedAccessState,
      failureCode: operation.failureCode,
    },
  };
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, integrationId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(integrationId)) {
    return jsonError("Invalid workspace or integration id", 400);
  }
  const parsedBody = await boundedJsonBody(request, 16 * 1_024);
  const body = parsedBody.ok ? exactOperationBody(parsedBody.value) : null;
  if (!body) return jsonError("Invalid Neon branch operation request", 400);

  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Workspace access denied", 403);
  }
  const integration = await activeProviderIntegration(workspaceId, integrationId);
  if (!integration || integration.provider !== "neon") {
    return jsonError("Neon integration not found", 404);
  }
  const authority = {
    organizationId: workspaceId,
    membershipId: authorization.membership.id,
    userId: authorization.session.user.id,
    sessionId: authorization.session.session.id,
    role: authorization.role,
  };

  try {
    if (body.action === "executeSwitch") {
      const operation = await loadProviderOperationExecution({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: body.operationId,
        kind: "neon.branch.switch",
      });
      if (
        !operation
        || operation.plan.kind !== "neon.branch.switch"
        || operation.planHash !== body.planHash
      ) {
        return jsonError("Neon branch switch plan changed or is unavailable", 409);
      }
      const connectionAuthorization = await authorizeSwitchConnection(
        request,
        workspaceId,
        operation.plan.source.connectionId,
      );
      if (connectionAuthorization) return connectionAuthorization;
      if (["succeeded", "failed", "needs_repair", "cancelled"].includes(operation.state)) {
        return privateJson(executionResponse(operation));
      }
      if (operation.state === "awaiting_approval") {
        return jsonError("Neon branch switch is awaiting approval", 409);
      }
      const identity = {
        authority,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: operation.id,
        kind: "neon.branch.switch" as const,
        planHash: operation.planHash,
        ownershipMarker: operation.ownershipMarker,
      };
      if (
        (operation.state === "approved" || operation.state === "claimed")
        && operation.planExpiresAt.valueOf() <= Date.now()
      ) {
        const cancelled = await cancelExpiredProviderOperationExecution({
          ...identity,
          now: new Date(),
        });
        if (!cancelled) {
          return jsonError("Neon branch switch authority or operation changed", 409);
        }
        return privateJson(executionResponse(cancelled));
      }

      let claimId = operation.claimId;
      if (operation.state === "approved" || operation.state === "claimed") {
        const live = await liveSwitchPlanContext({
          workspaceId,
          integrationId,
          integration,
          connectionId: operation.plan.source.connectionId,
          projectId: operation.plan.source.projectId,
          targetBranchId: operation.plan.target.branchId,
          targetEnvironment: operation.plan.target.environment,
        });
        revalidateNeonBranchSwitchPlan({
          plan: operation.plan,
          inventory: live.inventory,
          connection: live.connection,
          target: live.target,
          now: new Date(),
        });
        const claim = await claimProviderOperationExecution({
          ...identity,
          now: new Date(),
        });
        if (!claim) {
          return jsonError("Neon branch switch authority or operation changed", 409);
        }
        const remoteStart = await markProviderOperationRemoteStarted({
          ...identity,
          claimId: claim.claimId,
          now: new Date(),
        });
        if (!remoteStart) {
          return jsonError("Neon branch switch remote-start fence changed", 409);
        }
        if (remoteStart.state === "cancelled") {
          return privateJson(executionResponse({
            id: remoteStart.id,
            state: remoteStart.state,
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
          }));
        }
        claimId = claim.claimId;
      }
      if (!claimId) {
        return jsonError("Neon branch switch execution claim is unavailable", 409);
      }

      const connectionClaim = await claimRevocationGate({
        kind: "connection",
        organizationId: workspaceId,
        connectionId: operation.plan.source.connectionId,
      });
      if (!connectionClaim || connectionClaim.connectionRevision === undefined) {
        return jsonError("Connection access is already changing. Retry shortly.", 409);
      }
      const expectedAuthorityRevision = operation.plan.source.authorityRevision + 1;
      if (connectionClaim.connectionRevision !== expectedAuthorityRevision) {
        await (connectionClaim.firstPending
          ? clearRevocationGate(connectionClaim)
          : releaseRevocationGateClaim(connectionClaim)).catch(() => false);
        await recordSwitchFailure({
          authority,
          integrationId,
          integrationGeneration: integration.generation,
          operation: operation as ProviderOperationExecutionRecord & { plan: NeonBranchSwitchPlan },
          claimId,
          failureCode: "NEON_SWITCH_CONNECTION_REVISION_CHANGED",
        }).catch(() => null);
        return jsonError("Neon connection changed after switch approval", 409);
      }

      let revocation;
      try {
        revocation = await revokeActiveLeases({
          organizationId: workspaceId,
          connectionId: operation.plan.source.connectionId,
        });
      } catch (error) {
        await releaseRevocationGateClaim(connectionClaim).catch(() => false);
        throw error;
      }
      if (revocation.deferred > 0) {
        await releaseRevocationGateClaim(connectionClaim).catch(() => false);
        return privateJson({
          operation: {
            id: operation.id,
            state: "remote_started",
            branchId: operation.plan.target.branchId,
            retryingLeaseRevocation: true,
          },
        }, { status: 202 });
      }

      let target;
      try {
        target = await liveSwitchTargetContext({
          workspaceId,
          integrationId,
          integration,
          projectId: operation.plan.target.projectId,
          targetBranchId: operation.plan.target.branchId,
          database: operation.plan.source.database,
          schemas: operation.plan.source.schemas,
          targetEnvironment: operation.plan.target.environment,
        });
        revalidateNeonBranchSwitchTarget({
          plan: operation.plan,
          inventory: target.inventory,
          target: target.target,
        });
      } catch (error) {
        await clearRevocationGate(connectionClaim).catch(() => false);
        await recordSwitchFailure({
          authority,
          integrationId,
          integrationGeneration: integration.generation,
          operation: operation as ProviderOperationExecutionRecord & { plan: NeonBranchSwitchPlan },
          claimId,
          failureCode: "NEON_SWITCH_TARGET_CHANGED",
        }).catch(() => null);
        if (error instanceof ProviderRequestError) {
          return jsonError(error.message, error.status);
        }
        if (error instanceof NeonBranchSwitchPlanError) {
          return jsonError(error.message, error.status);
        }
        throw error;
      }
      const completed = await completeNeonBranchSwitch({
        ...identity,
        claimId,
        connectionClaimId: connectionClaim.claimId,
        plan: operation.plan,
        targetProjection: target.projection,
        now: new Date(),
      }).catch(async (error) => {
        // The database response can be lost after an atomic commit. Preserve
        // the pending epoch and release only this worker claim so a retry can
        // observe either the committed operation or the exact same revision.
        await releaseRevocationGateClaim(connectionClaim).catch(() => false);
        throw error;
      });
      if (!completed) {
        await clearRevocationGate(connectionClaim).catch(() => false);
        await recordSwitchFailure({
          authority,
          integrationId,
          integrationGeneration: integration.generation,
          operation: operation as ProviderOperationExecutionRecord & { plan: NeonBranchSwitchPlan },
          claimId,
          failureCode: "NEON_SWITCH_COMMIT_CHANGED",
        }).catch(() => null);
        return jsonError("Neon branch switch authority changed before commit", 409);
      }
      return privateJson({
        operation: {
          id: completed.operationId,
          state: "succeeded",
          branchId: completed.targetBranchId,
          connectionId: completed.connectionId,
          contentRevision: completed.contentRevision,
          authorityRevision: completed.authorityRevision,
        },
      });
    }

    if (body.action === "executeDelete") {
      const operation = await loadProviderOperationExecution({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: body.operationId,
        kind: "neon.branch.delete",
      });
      if (
        !operation
        || operation.plan.kind !== "neon.branch.delete"
        || operation.planHash !== body.planHash
      ) {
        return jsonError("Neon branch delete plan changed or is unavailable", 409);
      }
      if (["succeeded", "failed", "needs_repair", "cancelled"].includes(operation.state)) {
        return privateJson(executionResponse(operation));
      }
      if (operation.state === "awaiting_approval") {
        return jsonError("Neon branch deletion is awaiting approval", 409);
      }
      const identity = {
        authority,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: operation.id,
        kind: "neon.branch.delete" as const,
        planHash: operation.planHash,
        ownershipMarker: operation.ownershipMarker,
      };
      if (
        (operation.state === "approved" || operation.state === "claimed")
        && operation.planExpiresAt.valueOf() <= Date.now()
      ) {
        const cancelled = await cancelExpiredProviderOperationExecution({
          ...identity,
          now: new Date(),
        });
        if (!cancelled) {
          return jsonError("Neon branch deletion authority or operation changed", 409);
        }
        return privateJson(executionResponse(cancelled));
      }
      if (
        operation.state === "reconciling"
        && operation.reconcileAfter
        && operation.reconcileAfter.valueOf() > Date.now()
      ) {
        return privateJson(executionResponse(operation), { status: 202 });
      }

      let credential;
      let claimId = operation.claimId;
      let startedNow = false;
      if (operation.state === "approved" || operation.state === "claimed") {
        const live = await liveDeletePlanContext({
          workspaceId,
          integrationId,
          integration,
          projectId: operation.plan.target.projectId,
          branchId: operation.plan.target.branchId,
        });
        revalidateNeonBranchDeletePlan({
          plan: operation.plan,
          inventory: live.inventory,
          ownership: live.ownership,
          references: live.references,
          now: new Date(),
        });
        credential = live.credential;
        const claim = await claimProviderOperationExecution({
          ...identity,
          now: new Date(),
        });
        if (!claim) {
          return jsonError("Neon branch deletion authority or operation changed", 409);
        }
        const remoteStart = await markProviderOperationRemoteStarted({
          ...identity,
          claimId: claim.claimId,
          now: new Date(),
        });
        if (!remoteStart) {
          return jsonError("Neon branch deletion remote-start fence changed", 409);
        }
        if (remoteStart.state === "cancelled") {
          return privateJson(executionResponse({
            id: remoteStart.id,
            state: remoteStart.state,
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
          }));
        }
        claimId = claim.claimId;
        startedNow = remoteStart.startedNow;
      } else {
        credential = await verifiedNeonProjectCredential(
          integration,
          operation.plan.target.projectId,
        );
      }
      if (!claimId) {
        return jsonError("Neon branch deletion claim is unavailable", 409);
      }

      let providerOperationId = operation.providerOperationId;
      if (startedNow) {
        let observation: ProviderOperationReconciliationInput;
        try {
          const receipt = await deleteNeonBranch({
            credential,
            plan: operation.plan,
          });
          providerOperationId = receipt.providerOperationId;
          observation = {
            status: "pending",
            branchId: receipt.branchId,
            providerOperationId: receipt.providerOperationId,
            providerOperationStatus: receipt.providerOperationStatus,
            endpointId: null,
            databaseCount: null,
            databaseFingerprint: null,
            retiredInheritedRoleCount: null,
            credentialFenceFingerprint: null,
            managedAccessState: "unavailable",
            failureCode: null,
          };
        } catch (error) {
          observation = error instanceof NeonBranchMutationRequestError
            && error.responseReceived
            ? {
              status: "failed",
              branchId: null,
              providerOperationId: null,
              providerOperationStatus: null,
              endpointId: null,
              databaseCount: null,
              databaseFingerprint: null,
              retiredInheritedRoleCount: null,
              credentialFenceFingerprint: null,
              managedAccessState: "unavailable",
              failureCode: error.explicitlyRetrySafe
                ? "NEON_DELETE_RETRY_SAFE_REJECTED"
                : "NEON_DELETE_REJECTED",
            }
            : {
              status: "pending",
              branchId: operation.plan.target.branchId,
              providerOperationId: null,
              providerOperationStatus: null,
              endpointId: null,
              databaseCount: null,
              databaseFingerprint: null,
              retiredInheritedRoleCount: null,
              credentialFenceFingerprint: null,
              managedAccessState: "unavailable",
              failureCode: null,
            };
        }
        const recorded = await applyProviderOperationReconciliation({
          ...identity,
          claimId,
          result: observation,
          now: new Date(),
        });
        if (!recorded) {
          return jsonError("Neon branch deletion receipt could not be recorded", 409);
        }
        if (recorded.state !== "reconciling") {
          return privateJson(executionResponse(recorded));
        }
        providerOperationId = recorded.providerOperationId;
      }

      let reconciled: ProviderOperationReconciliationInput = await reconcileNeonBranchDelete({
        credential,
        plan: operation.plan,
        providerOperationId,
      });
      const remoteStartedAt = operation.remoteStartedAt?.valueOf() ?? Date.now();
      if (
        reconciled.status === "pending"
        && remoteStartedAt <= Date.now() - 2 * 60 * 1_000
      ) {
        reconciled = {
          ...reconciled,
          status: "conflict",
          failureCode: "NEON_DELETE_RESULT_AMBIGUOUS",
        };
      }
      const recorded = await applyProviderOperationReconciliation({
        ...identity,
        claimId,
        result: reconciled,
        now: new Date(),
      });
      if (!recorded) {
        return jsonError("Neon branch deletion reconciliation authority changed", 409);
      }
      return privateJson(
        executionResponse(recorded),
        recorded.state === "reconciling" ? { status: 202 } : undefined,
      );
    }

    if (body.action === "executeCreate") {
      const operation = await loadProviderOperationExecution({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: body.operationId,
        kind: "neon.branch.create",
      });
      if (
        !operation
        || operation.plan.kind !== "neon.branch.create"
        || operation.planHash !== body.planHash
      ) {
        return jsonError("Neon branch operation plan changed or is unavailable", 409);
      }
      const needsCredentialFenceRecovery = operation.state === "succeeded"
        && operation.plan.target.endpoint === "read_write"
        && (
          operation.retiredInheritedRoleCount === null
          || operation.credentialFenceFingerprint === null
        );
      if (
        ["succeeded", "failed", "needs_repair", "cancelled"].includes(operation.state)
        && !needsCredentialFenceRecovery
      ) {
        return privateJson(executionResponse(operation));
      }
      if (operation.state === "awaiting_approval") {
        return jsonError("Neon branch operation is awaiting approval", 409);
      }
      const identity = {
        authority,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: operation.id,
        kind: "neon.branch.create" as const,
        planHash: operation.planHash,
        ownershipMarker: operation.ownershipMarker,
      };
      if (
        (operation.state === "approved" || operation.state === "claimed")
        && operation.planExpiresAt.valueOf() <= Date.now()
      ) {
        const cancelled = await cancelExpiredProviderOperationExecution({
          ...identity,
          now: new Date(),
        });
        if (!cancelled) {
          return jsonError("Neon branch expiration authority or operation changed", 409);
        }
        return privateJson(executionResponse(cancelled));
      }
      if (
        operation.state === "reconciling"
        && operation.reconcileAfter
        && operation.reconcileAfter.valueOf() > Date.now()
      ) {
        return privateJson(executionResponse(operation), { status: 202 });
      }

      let credential;
      let claimId = operation.claimId;
      let startedNow = false;
      if (operation.state === "approved" || operation.state === "claimed") {
        const live = await livePlanContext({
          workspaceId,
          integrationId,
          integration,
          projectId: operation.plan.source.projectId,
          sourceBranchId: operation.plan.source.branchId,
        });
        revalidateNeonBranchCreatePlan({
          plan: operation.plan,
          inventory: live.inventory,
          workspaceProductionReference: live.workspaceProductionReference,
          now: new Date(),
        });
        credential = live.credential;
        const claim = await claimProviderOperationExecution({
          ...identity,
          now: new Date(),
        });
        if (!claim) {
          return jsonError("Neon branch execution authority or operation changed", 409);
        }
        const remoteStart = await markProviderOperationRemoteStarted({
          ...identity,
          claimId: claim.claimId,
          now: new Date(),
        });
        if (!remoteStart) {
          return jsonError("Neon branch remote-start fence changed", 409);
        }
        if (remoteStart.state === "cancelled") {
          return privateJson(executionResponse({
            id: remoteStart.id,
            state: remoteStart.state,
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
          }));
        }
        claimId = claim.claimId;
        startedNow = remoteStart.startedNow;
      } else {
        credential = await verifiedNeonProjectCredential(
          integration,
          operation.plan.source.projectId,
        );
      }
      if (!claimId) {
        return jsonError("Neon branch execution claim is unavailable", 409);
      }

      let providerOperationId = operation.providerOperationId;
      if (startedNow) {
        let observation: ProviderOperationReconciliationInput;
        try {
          const receipt = await createNeonBranch({
            credential,
            plan: operation.plan,
            planHash: operation.planHash,
            ownershipMarker: operation.ownershipMarker,
          });
          providerOperationId = receipt.providerOperationId;
          observation = {
            status: "pending",
            branchId: receipt.branchId,
            providerOperationId: receipt.providerOperationId,
            providerOperationStatus: receipt.providerOperationStatus,
            endpointId: receipt.endpointId,
            databaseCount: null,
            databaseFingerprint: null,
            retiredInheritedRoleCount: null,
            credentialFenceFingerprint: null,
            managedAccessState: "waiting_for_provider",
            failureCode: null,
          };
        } catch (error) {
          observation = error instanceof NeonBranchMutationRequestError
            && error.explicitlyRetrySafe
            ? {
              status: "failed",
              branchId: null,
              providerOperationId: null,
              providerOperationStatus: null,
              endpointId: null,
              databaseCount: null,
              databaseFingerprint: null,
              retiredInheritedRoleCount: null,
              credentialFenceFingerprint: null,
              managedAccessState: "unavailable",
              failureCode: "NEON_RETRY_SAFE_REJECTED",
            }
            : {
              status: "missing",
              branchId: null,
              providerOperationId: null,
              providerOperationStatus: null,
              endpointId: null,
              databaseCount: null,
              databaseFingerprint: null,
              retiredInheritedRoleCount: null,
              credentialFenceFingerprint: null,
              managedAccessState: "waiting_for_provider",
              failureCode: null,
            };
        }
        const recorded = await applyProviderOperationReconciliation({
          ...identity,
          claimId,
          result: observation,
          now: new Date(),
        });
        if (!recorded) {
          return jsonError("Neon branch creation receipt could not be recorded", 409);
        }
        if (recorded.state !== "reconciling") {
          return privateJson(executionResponse(recorded));
        }
        if (observation.status === "missing") {
          return privateJson(executionResponse(recorded), { status: 202 });
        }
        providerOperationId = recorded.providerOperationId;
      }

      const reconciled = await reconcileNeonBranchCreate({
        credential,
        plan: operation.plan,
        planHash: operation.planHash,
        ownershipMarker: operation.ownershipMarker,
        providerOperationId,
      });
      const recorded = await applyProviderOperationReconciliation({
        ...identity,
        claimId,
        result: reconciled,
        now: new Date(),
      });
      if (!recorded) {
        return jsonError("Neon branch reconciliation authority changed", 409);
      }
      return privateJson(
        executionResponse(recorded),
        recorded.state === "reconciling" ? { status: 202 } : undefined,
      );
    }

    if (body.action === "decideSwitch") {
      const operation = await loadProviderOperationPlan({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: body.operationId,
        kind: "neon.branch.switch",
      });
      if (
        !operation
        || operation.plan.kind !== "neon.branch.switch"
        || operation.planHash !== body.planHash
      ) {
        return jsonError("Neon branch switch plan changed or is unavailable", 409);
      }
      const connectionAuthorization = await authorizeSwitchConnection(
        request,
        workspaceId,
        operation.plan.source.connectionId,
      );
      if (connectionAuthorization) return connectionAuthorization;
      if (body.decision === "approved" && operation.state === "awaiting_approval") {
        const live = await liveSwitchPlanContext({
          workspaceId,
          integrationId,
          integration,
          connectionId: operation.plan.source.connectionId,
          projectId: operation.plan.source.projectId,
          targetBranchId: operation.plan.target.branchId,
          targetEnvironment: operation.plan.target.environment,
        });
        revalidateNeonBranchSwitchPlan({
          plan: operation.plan,
          inventory: live.inventory,
          connection: live.connection,
          target: live.target,
          now: new Date(),
        });
      }
      const decided = await decideProviderOperation({
        authority,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: operation.id,
        kind: "neon.branch.switch",
        planHash: operation.planHash,
        ownershipMarker: operation.ownershipMarker,
        decision: body.decision,
        now: new Date(),
      });
      if (!decided) {
        return jsonError("Neon branch switch approval authority changed", 409);
      }
      return privateJson({
        operation: {
          id: decided.id,
          state: decided.state,
          planHash: operation.planHash,
          decision: decided.decision,
          approvalId: decided.approvalId,
          replayed: decided.replayed,
        },
      });
    }

    if (body.action === "decideDelete") {
      const operation = await loadProviderOperationPlan({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: body.operationId,
        kind: "neon.branch.delete",
      });
      if (
        !operation
        || operation.plan.kind !== "neon.branch.delete"
        || operation.planHash !== body.planHash
      ) {
        return jsonError("Neon branch delete plan changed or is unavailable", 409);
      }
      if (body.decision === "approved" && operation.state === "awaiting_approval") {
        const live = await liveDeletePlanContext({
          workspaceId,
          integrationId,
          integration,
          projectId: operation.plan.target.projectId,
          branchId: operation.plan.target.branchId,
        });
        revalidateNeonBranchDeletePlan({
          plan: operation.plan,
          inventory: live.inventory,
          ownership: live.ownership,
          references: live.references,
          now: new Date(),
        });
      }
      const decided = await decideProviderOperation({
        authority,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: operation.id,
        kind: "neon.branch.delete",
        planHash: operation.planHash,
        ownershipMarker: operation.ownershipMarker,
        decision: body.decision,
        now: new Date(),
      });
      if (!decided) {
        return jsonError("Neon branch deletion approval authority changed", 409);
      }
      return privateJson({
        operation: {
          id: decided.id,
          state: decided.state,
          planHash: operation.planHash,
          decision: decided.decision,
          approvalId: decided.approvalId,
          replayed: decided.replayed,
        },
      });
    }

    if (body.action === "decideCreate") {
      const operation = await loadProviderOperationPlan({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: body.operationId,
        kind: "neon.branch.create",
      });
      if (
        !operation
        || operation.plan.kind !== "neon.branch.create"
        || operation.planHash !== body.planHash
      ) {
        return jsonError("Neon branch operation plan changed or is unavailable", 409);
      }
      if (body.decision === "approved" && operation.state === "awaiting_approval") {
        const live = await livePlanContext({
          workspaceId,
          integrationId,
          integration,
          projectId: operation.plan.source.projectId,
          sourceBranchId: operation.plan.source.branchId,
        });
        revalidateNeonBranchCreatePlan({
          plan: operation.plan,
          inventory: live.inventory,
          workspaceProductionReference: live.workspaceProductionReference,
          now: new Date(),
        });
      }
      const decided = await decideProviderOperation({
        authority,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: operation.id,
        kind: "neon.branch.create",
        planHash: operation.planHash,
        ownershipMarker: operation.ownershipMarker,
        decision: body.decision,
        now: new Date(),
      });
      if (!decided) {
        return jsonError("Neon branch approval authority or operation changed", 409);
      }
      return privateJson({
        operation: {
          id: decided.id,
          state: decided.state,
          planHash: operation.planHash,
          decision: decided.decision,
          approvalId: decided.approvalId,
          replayed: decided.replayed,
        },
      });
    }

    if (body.action === "planSwitch") {
      const planRequest = parseNeonBranchSwitchPlanRequest(body.request);
      const connectionAuthorization = await authorizeSwitchConnection(
        request,
        workspaceId,
        planRequest.connectionId,
      );
      if (connectionAuthorization) return connectionAuthorization;
      const live = await liveSwitchPlanContext({
        workspaceId,
        integrationId,
        integration,
        connectionId: planRequest.connectionId,
        projectId: planRequest.projectId,
        targetBranchId: planRequest.targetBranchId,
        targetEnvironment: planRequest.targetEnvironment,
      });
      const operationId = crypto.randomUUID();
      const now = new Date();
      const plan = buildNeonBranchSwitchPlan({
        request: planRequest,
        inventory: live.inventory,
        connection: live.connection,
        target: live.target,
        operationId,
        integrationId,
        integrationGeneration: integration.generation,
        now,
      });
      const requestHash = canonicalHash({
        version: 1,
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation.toString(),
        requestedByMemberId: authorization.membership.id,
        requestedByUserId: authorization.session.user.id,
        requestedBySessionId: authorization.session.session.id,
        requestedByRole: authorization.role,
        request: planRequest,
        sourceSnapshot: plan.source,
        targetSnapshot: plan.target,
        impact: plan.impact,
      });
      const planHash = canonicalHash(plan);
      const ownershipMarker = providerOperationOwnershipMarker({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        operationId,
        planHash,
      });
      const recorded = await recordProviderOperationPlan({
        authority,
        integrationId,
        integrationGeneration: integration.generation,
        operationId,
        idempotencyKey: planRequest.idempotencyKey,
        requestHash,
        planHash,
        ownershipMarker,
        plan,
        now,
      });
      if (!recorded || recorded.plan.kind !== "neon.branch.switch") {
        return jsonError("Neon branch switch plan authority changed", 409);
      }
      return privateJson({
        operation: {
          id: recorded.id,
          state: recorded.state,
          planHash: recorded.planHash,
          planExpiresAt: recorded.planExpiresAt.toISOString(),
          expired: recorded.planExpiresAt.valueOf() <= Date.now(),
          risk: recorded.risk,
          approvalPolicy: recorded.approvalPolicy,
          replayed: recorded.replayed,
          plan: recorded.plan,
        },
      });
    }

    if (body.action === "planDelete") {
      const planRequest = parseNeonBranchDeletePlanRequest(body.request);
      const live = await liveDeletePlanContext({
        workspaceId,
        integrationId,
        integration,
        projectId: planRequest.projectId,
        branchId: planRequest.branchId,
      });
      const operationId = crypto.randomUUID();
      const now = new Date();
      const plan = buildNeonBranchDeletePlan({
        request: planRequest,
        inventory: live.inventory,
        ownership: live.ownership,
        references: live.references,
        operationId,
        integrationId,
        integrationGeneration: integration.generation,
        now,
      });
      const requestHash = canonicalHash({
        version: 1,
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation.toString(),
        requestedByMemberId: authorization.membership.id,
        requestedByUserId: authorization.session.user.id,
        requestedBySessionId: authorization.session.session.id,
        requestedByRole: authorization.role,
        request: planRequest,
        targetSnapshot: plan.target,
        referenceSnapshot: plan.references,
        createOwnership: plan.ownership,
      });
      const planHash = canonicalHash(plan);
      const ownershipMarker = providerOperationOwnershipMarker({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        operationId,
        planHash,
      });
      const recorded = await recordProviderOperationPlan({
        authority,
        integrationId,
        integrationGeneration: integration.generation,
        operationId,
        idempotencyKey: planRequest.idempotencyKey,
        requestHash,
        planHash,
        ownershipMarker,
        plan,
        now,
      });
      if (!recorded || recorded.plan.kind !== "neon.branch.delete") {
        return jsonError("Neon branch delete plan authority changed", 409);
      }
      return privateJson({
        operation: {
          id: recorded.id,
          state: recorded.state,
          planHash: recorded.planHash,
          planExpiresAt: recorded.planExpiresAt.toISOString(),
          expired: recorded.planExpiresAt.valueOf() <= Date.now(),
          risk: recorded.risk,
          approvalPolicy: recorded.approvalPolicy,
          replayed: recorded.replayed,
          plan: recorded.plan,
        },
      });
    }

    const planRequest = parseNeonBranchCreatePlanRequest(body.request);
    const live = await livePlanContext({
      workspaceId,
      integrationId,
      integration,
      projectId: planRequest.projectId,
      sourceBranchId: planRequest.sourceBranchId,
    });
    const operationId = crypto.randomUUID();
    const now = new Date();
    const plan = buildNeonBranchCreatePlan({
      request: planRequest,
      inventory: live.inventory,
      operationId,
      integrationId,
      integrationGeneration: integration.generation,
      workspaceProductionReference: live.workspaceProductionReference,
      now,
    });
    const requestHash = canonicalHash({
      version: 1,
      organizationId: workspaceId,
      integrationId,
      integrationGeneration: integration.generation.toString(),
      requestedByMemberId: authorization.membership.id,
      requestedByUserId: authorization.session.user.id,
      requestedBySessionId: authorization.session.session.id,
      requestedByRole: authorization.role,
      request: planRequest,
      sourceSnapshot: plan.source,
      workspaceProductionReference: live.workspaceProductionReference,
    });
    const planHash = canonicalHash(plan);
    const ownershipMarker = providerOperationOwnershipMarker({
      organizationId: workspaceId,
      integrationId,
      integrationGeneration: integration.generation,
      operationId,
      planHash,
    });
    const recorded = await recordProviderOperationPlan({
      authority,
      integrationId,
      integrationGeneration: integration.generation,
      operationId,
      idempotencyKey: planRequest.idempotencyKey,
      requestHash,
      planHash,
      ownershipMarker,
      plan,
      now,
    });
    if (!recorded) {
      return jsonError("Neon branch plan authority or idempotency key changed", 409);
    }
    return privateJson({
      operation: {
        id: recorded.id,
        state: recorded.state,
        planHash: recorded.planHash,
        planExpiresAt: recorded.planExpiresAt.toISOString(),
        expired: recorded.planExpiresAt.valueOf() <= Date.now(),
        risk: recorded.risk,
        approvalPolicy: recorded.approvalPolicy,
        replayed: recorded.replayed,
        plan: recorded.plan,
      },
    });
  } catch (error) {
    if (error instanceof NeonBranchPlanError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof NeonBranchDeletePlanError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof NeonBranchSwitchPlanError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Neon branch operation request failed", 502);
  }
}
