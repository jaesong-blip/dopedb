// Read-side projection for the durable Neon operation inventory. This module
// owns presentation flags derived from persisted operation and authority state.
import "server-only";

import { listProviderOperationExecutions } from "../../provider-operation-store";
import { ProviderRequestError } from "../provider-types";
import {
  jsonError,
  privateJson,
  type NeonBranchOperationListInput,
  type NeonBranchOperationOutcome,
} from "./contracts";

export async function listNeonBranchOperations(
  input: NeonBranchOperationListInput,
): Promise<NeonBranchOperationOutcome> {
  const { workspaceId, integrationId, integration } = input;
  try {
    const operations = await listProviderOperationExecutions({
      organizationId: workspaceId,
      integrationId,
      integrationGeneration: integration.generation,
      currentMemberId: input.currentMemberId,
      currentUserId: input.currentUserId,
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
