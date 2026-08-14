// Shared command context and transport-neutral result shapes for durable Neon
// branch use cases. HTTP response construction stays in the route boundary.
import type {
  ActiveProviderIntegration,
  ProviderMutationAuthority,
} from "../../provider-integrations/authority";
import type { ProviderOperationExecutionRecord } from "../../provider-operation-store";

export type NeonBranchOperationOutcome =
  | Readonly<{ ok: true; body: unknown; status: number }>
  | Readonly<{ ok: false; error: string; status: number }>;

export type NeonBranchConnectionAuthorization = Readonly<{
  ok: boolean;
  error?: string;
  status?: number;
}>;

export type NeonBranchOperationContext = Readonly<{
  workspaceId: string;
  integrationId: string;
  integration: ActiveProviderIntegration;
  authority: ProviderMutationAuthority;
  authorizeConnection: (
    connectionId: string,
  ) => Promise<NeonBranchConnectionAuthorization>;
}>;

export type NeonBranchOperationListInput = Readonly<{
  workspaceId: string;
  integrationId: string;
  integration: ActiveProviderIntegration;
  currentMemberId: string;
  currentUserId: string;
}>;

export function jsonError(
  error: string,
  status: number,
): NeonBranchOperationOutcome {
  return { ok: false, error, status };
}

export function privateJson(
  body: unknown,
  init?: Readonly<{ status: number }>,
): NeonBranchOperationOutcome {
  return { ok: true, body, status: init?.status ?? 200 };
}

export function executionResponse(operation: ProviderOperationExecutionRecord | {
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
