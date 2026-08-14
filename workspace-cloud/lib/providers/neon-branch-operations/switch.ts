// Plan, approval, execution, and atomic connection retargeting for Neon branch
// switches. The remote-start fence always precedes lease revocation and commit.
import "server-only";

import { revokeActiveLeases } from "../../provider-integrations/lease-cleanup";
import { providerOperationOwnershipMarker } from "../../provider-operation-marker";
import {
  applyProviderOperationReconciliation,
  cancelExpiredProviderOperationExecution,
  claimProviderOperationExecution,
  completeNeonBranchSwitch,
  decideProviderOperation,
  loadProviderOperationExecution,
  loadProviderOperationPlan,
  markProviderOperationRemoteStarted,
  recordProviderOperationPlan,
  type ProviderOperationExecutionRecord,
} from "../../provider-operation-store";
import {
  clearRevocationGate,
  claimRevocationGate,
  releaseRevocationGateClaim,
} from "../../revocation-gates";
import { canonicalHash } from "../../workspace-versioning";
import type { NeonBranchOperationCommand } from "../neon-branch-operation-command";
import {
  buildNeonBranchSwitchPlan,
  NeonBranchSwitchPlanError,
  parseNeonBranchSwitchPlanRequest,
  revalidateNeonBranchSwitchPlan,
  revalidateNeonBranchSwitchTarget,
  type NeonBranchSwitchPlan,
} from "../neon-branch-switch-plan";
import { ProviderRequestError } from "../provider-types";
import {
  executionResponse,
  jsonError,
  privateJson,
  type NeonBranchOperationContext,
  type NeonBranchOperationOutcome,
} from "./contracts";
import {
  liveSwitchPlanContext,
  liveSwitchTargetContext,
} from "./live-contexts";

type NeonBranchSwitchCommand = Extract<
  NeonBranchOperationCommand,
  { action: "planSwitch" | "decideSwitch" | "executeSwitch" }
>;

async function authorizeSwitchConnection(
  authorizeConnection: NeonBranchOperationContext["authorizeConnection"],
  connectionId: string,
) {
  const authorization = await authorizeConnection(connectionId);
  return authorization.ok
    ? null
    : jsonError(
      authorization.error ?? "Connection access denied",
      authorization.status ?? 403,
    );
}

async function recordSwitchFailure(input: {
  authority: NeonBranchOperationContext["authority"];
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

export async function runNeonBranchSwitchOperation(
  context: NeonBranchOperationContext,
  body: NeonBranchSwitchCommand,
): Promise<NeonBranchOperationOutcome> {
  const {
    workspaceId,
    integrationId,
    integration,
    authority,
    authorizeConnection,
  } = context;

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
      authorizeConnection,
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
      authorizeConnection,
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

  const planRequest = parseNeonBranchSwitchPlanRequest(body.request);
  const connectionAuthorization = await authorizeSwitchConnection(
    authorizeConnection,
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
    requestedByMemberId: authority.membershipId,
    requestedByUserId: authority.userId,
    requestedBySessionId: authority.sessionId,
    requestedByRole: authority.role,
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
