// Durable Neon branch-operation boundary. Planning performs no Provider
// mutation; approval revalidates one fresh complete inventory before recording
// the exact decision. Execution owns the later remote-start fence.
import { and, count, eq, gt, isNull } from "drizzle-orm";

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
  type ActiveProviderIntegration,
  verifiedNeonProjectCredential,
} from "../../../../../../../../../lib/provider-integrations";
import { providerOperationOwnershipMarker } from "../../../../../../../../../lib/provider-operation-marker";
import {
  applyProviderOperationReconciliation,
  cancelExpiredProviderOperationExecution,
  claimProviderOperationExecution,
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
  createNeonBranch,
  deleteNeonBranch,
  listNeonBranchEndpointIds,
  listNeonBranchInventory,
  NeonBranchMutationRequestError,
  reconcileNeonBranchCreate,
  reconcileNeonBranchDelete,
  verifyNeonBranchOwnership,
} from "../../../../../../../../../lib/providers/neon";
import { parseNeonResource } from "../../../../../../../../../lib/providers/neon-core";
import { ProviderRequestError } from "../../../../../../../../../lib/providers/provider-types";
import {
  workspaceConnection,
  workspaceCredentialLease,
} from "../../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../../lib/workspace-authorization";
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
    (body.action === "planCreate" || body.action === "planDelete")
    && Object.keys(body).length === 2
    && Object.prototype.hasOwnProperty.call(body, "request")
  ) {
    return { action: body.action, request: body.request };
  }
  if (
    (body.action === "decideCreate" || body.action === "decideDelete")
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
    (body.action === "executeCreate" || body.action === "executeDelete")
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
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Neon branch operation request failed", 502);
  }
}
