// Neon branch inventory, mutation, and reconciliation adapter.
import "server-only";

import { boundedJsonResponse, BoundedJsonResponseError } from "../bounded-json-response";
import {
  ProviderRequestError,
} from "./provider-types";
import { neonSegment, type NeonCredential } from "./neon-core";
import { neonBranchQueryable, parseNeonBranchInventory, type NeonBranchInventory } from "./neon-branches";
import type { NeonBranchCreatePlan } from "./neon-branch-plan";
import type { NeonBranchDeletePlan } from "./neon-branch-delete-plan";
import {
  neonBranchMutationBody,
  parseNeonBranchAnnotation,
  parseNeonBranchCreateReceipt,
  parseNeonBranchDeleteReceipt,
  parseNeonBranchEndpoints,
  parseNeonBranchOperation,
  type NeonBranchCreateReceipt,
  type NeonBranchDeleteReceipt,
} from "./neon-branch-mutation";
import {
  API_ORIGIN,
  MAX_NEON_MUTATION_RESPONSE_BYTES,
  NEON_MUTATION_RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  NeonBranchMutationRequestError,
  NeonInheritedCredentialFenceConflictError,
  apiRequest,
  apiSegment,
  boundedJson,
  listNeonCollection,
  listNeonDatabases,
  neonBranchDatabaseFingerprint,
  object,
  requiredString,
  type NeonBranchDeleteReconciliation,
  type NeonBranchReconciliation,
} from "./neon-api";
import { retireInheritedNeonLeaseRoles } from "./neon-managed-access";
import { listNeonBranchInventory } from "./neon-branch-inventory-api";

export {
  listNeonBranchInventory,
  listNeonBranches,
} from "./neon-branch-inventory-api";

export async function listNeonBranchEndpointIds(
  credential: NeonCredential,
  projectId: string,
  branchId: string,
): Promise<readonly string[]> {
  const body = object(await apiRequest(
    credential,
    `/projects/${apiSegment(projectId)}/branches/${apiSegment(branchId)}/endpoints`,
  ));
  return parseNeonBranchEndpoints(body.endpoints, branchId)
    .map((endpoint) => endpoint.id)
    .sort();
}

export async function verifyNeonBranchOwnership(input: {
  credential: NeonCredential;
  projectId: string;
  branchId: string;
  operationId: string;
  planHash: string;
  ownershipMarker: string;
}) {
  const body = object(await apiRequest(
    input.credential,
    `/projects/${apiSegment(input.projectId)}/branches/${apiSegment(input.branchId)}`,
  ));
  const branch = object(body.branch);
  const properties = parseNeonBranchAnnotation(body.annotation, input.branchId);
  return branch.id === input.branchId
    && branch.project_id === input.projectId
    && properties?.["dopedb-operation-id"] === input.operationId
    && properties?.["dopedb-plan-hash"] === input.planHash
    && properties?.["dopedb-ownership"] === input.ownershipMarker;
}

async function mutationRetryDelay() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, NEON_MUTATION_RETRY_DELAY_MS);
  });
}

export async function createNeonBranch(input: {
  credential: NeonCredential;
  plan: NeonBranchCreatePlan;
  planHash: string;
  ownershipMarker: string;
}): Promise<NeonBranchCreateReceipt> {
  const body = neonBranchMutationBody(input);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(
      `${API_ORIGIN}/projects/${apiSegment(input.plan.source.projectId)}/branches`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.credential.apiKey}`,
          "content-type": "application/json",
          "x-request-id": input.plan.operationId,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    ).catch(() => {
      throw new NeonBranchMutationRequestError(
        "Neon branch creation response was not received",
        502,
        false,
        false,
      );
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const explicitlyRetrySafe = response.status === 423 || response.status === 503;
      if (explicitlyRetrySafe && attempt === 0) {
        await mutationRetryDelay();
        continue;
      }
      const status = response.status === 401
        ? 424
        : response.status >= 500
          ? 502
          : response.status;
      throw new NeonBranchMutationRequestError(
        "Neon rejected branch creation",
        status,
        true,
        explicitlyRetrySafe,
      );
    }
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => undefined);
      throw new NeonBranchMutationRequestError(
        "Neon returned an unexpected branch creation response",
        502,
        true,
        false,
      );
    }
    return parseNeonBranchCreateReceipt(
      await boundedJson(response, MAX_NEON_MUTATION_RESPONSE_BYTES),
      input.plan,
    );
  }
  throw new NeonBranchMutationRequestError(
    "Neon branch creation retry boundary failed",
    502,
    true,
    false,
  );
}

export async function deleteNeonBranch(input: {
  credential: NeonCredential;
  plan: NeonBranchDeletePlan;
}): Promise<NeonBranchDeleteReceipt> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(
      `${API_ORIGIN}/projects/${apiSegment(input.plan.target.projectId)}`
        + `/branches/${apiSegment(input.plan.target.branchId)}`,
      {
        method: "DELETE",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.credential.apiKey}`,
          "x-request-id": input.plan.operationId,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    ).catch(() => {
      throw new NeonBranchMutationRequestError(
        "Neon branch deletion response was not received",
        502,
        false,
        false,
      );
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const explicitlyRetrySafe = response.status === 423 || response.status === 503;
      if (explicitlyRetrySafe && attempt === 0) {
        await mutationRetryDelay();
        continue;
      }
      const status = response.status === 401
        ? 424
        : response.status >= 500
          ? 502
          : response.status;
      throw new NeonBranchMutationRequestError(
        "Neon rejected branch deletion",
        status,
        true,
        explicitlyRetrySafe,
      );
    }
    if (response.status !== 200 && response.status !== 204) {
      await response.body?.cancel().catch(() => undefined);
      throw new NeonBranchMutationRequestError(
        "Neon returned an unexpected branch deletion response",
        502,
        true,
        false,
      );
    }
    return parseNeonBranchDeleteReceipt(
      response.status === 204
        ? null
        : await boundedJson(response, MAX_NEON_MUTATION_RESPONSE_BYTES),
      input.plan,
    );
  }
  throw new NeonBranchMutationRequestError(
    "Neon branch deletion retry boundary failed",
    502,
    true,
    false,
  );
}

async function ownedBranchId(input: {
  credential: NeonCredential;
  projectId: string;
  targetName: string;
  operationId: string;
  planHash: string;
  ownershipMarker: string;
}) {
  const rows = await listNeonCollection({
    credential: input.credential,
    path: `/projects/${apiSegment(input.projectId)}/branches`,
    collection: "branches",
    query: new URLSearchParams({ search: input.targetName }),
    scopeLabel: "branch reconciliation",
  });
  const exact = rows.filter((row) => requiredString(row.name, "branch name") === input.targetName);
  if (exact.length === 0) return { status: "missing" as const, branchId: null };
  if (exact.length !== 1) return { status: "conflict" as const, branchId: null };
  const branchId = requiredString(exact[0].id, "branch id");
  if (!neonSegment(branchId)) {
    throw new ProviderRequestError("neon", "Neon returned an invalid branch id", 502);
  }
  const body = object(await apiRequest(
    input.credential,
    `/projects/${apiSegment(input.projectId)}/branches/${apiSegment(branchId)}`,
  ));
  const branch = object(body.branch);
  const properties = parseNeonBranchAnnotation(body.annotation, branchId);
  if (
    branch.id !== branchId
    || branch.project_id !== input.projectId
    || branch.name !== input.targetName
    || properties?.["dopedb-operation-id"] !== input.operationId
    || properties?.["dopedb-plan-hash"] !== input.planHash
    || properties?.["dopedb-ownership"] !== input.ownershipMarker
  ) {
    return { status: "conflict" as const, branchId };
  }
  return { status: "owned" as const, branchId };
}

async function branchEndpointReconciliation(
  credential: NeonCredential,
  projectId: string,
  branchId: string,
  expected: NeonBranchCreatePlan["target"]["endpoint"],
) {
  const body = object(await apiRequest(
    credential,
    `/projects/${apiSegment(projectId)}/branches/${apiSegment(branchId)}/endpoints`,
  ));
  const endpoints = parseNeonBranchEndpoints(body.endpoints, branchId);
  if (expected === "none") {
    return endpoints.length === 0
      ? { status: "ready" as const, endpointId: null }
      : { status: "conflict" as const, endpointId: null };
  }
  if (endpoints.length === 0) return { status: "pending" as const, endpointId: null };
  const endpoint = endpoints.length === 1
    && endpoints[0].type === "read_write"
    && !endpoints[0].disabled
    ? endpoints[0]
    : null;
  return endpoint
    ? { status: "ready" as const, endpointId: endpoint.id }
    : { status: "conflict" as const, endpointId: null };
}

async function branchDatabaseReconciliation(
  credential: NeonCredential,
  projectId: string,
  branchId: string,
) {
  try {
    return await listNeonDatabases(credential, projectId, branchId);
  } catch (error) {
    // A newly-created branch can briefly exist before its database collection
    // is queryable. Only explicit not-ready/locked responses are pending; auth,
    // malformed data, and transport failures remain hard errors.
    if (
      error instanceof ProviderRequestError
      && [404, 409, 423].includes(error.status)
    ) {
      return null;
    }
    throw error;
  }
}

async function projectOperation(
  credential: NeonCredential,
  projectId: string,
  operationId: string,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(operationId)) {
    throw new ProviderRequestError("neon", "Invalid Neon operation id", 400);
  }
  const body = object(await apiRequest(
    credential,
    `/projects/${apiSegment(projectId)}/operations/${encodeURIComponent(operationId)}`,
  ));
  return parseNeonBranchOperation(body.operation, projectId, requiredString(
    object(body.operation).branch_id,
    "operation branch id",
  ));
}

export async function reconcileNeonBranchCreate(input: {
  credential: NeonCredential;
  plan: NeonBranchCreatePlan;
  planHash: string;
  ownershipMarker: string;
  providerOperationId: string | null;
}): Promise<NeonBranchReconciliation> {
  const owned = await ownedBranchId({
    credential: input.credential,
    projectId: input.plan.source.projectId,
    targetName: input.plan.target.name,
    operationId: input.plan.operationId,
    planHash: input.planHash,
    ownershipMarker: input.ownershipMarker,
  });
  if (owned.status === "missing") {
    return {
      status: "missing",
      branchId: null,
      providerOperationId: input.providerOperationId,
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
  if (owned.status === "conflict") {
    return {
      status: "conflict",
      branchId: owned.branchId,
      providerOperationId: input.providerOperationId,
      providerOperationStatus: null,
      endpointId: null,
      databaseCount: null,
      databaseFingerprint: null,
      retiredInheritedRoleCount: null,
      credentialFenceFingerprint: null,
      managedAccessState: "needs_repair",
      failureCode: "NEON_OWNERSHIP_MARKER_MISMATCH",
    };
  }
  const [inventory, endpoint, operation, databases] = await Promise.all([
    listNeonBranchInventory(input.credential, input.plan.source.projectId),
    branchEndpointReconciliation(
      input.credential,
      input.plan.source.projectId,
      owned.branchId,
      input.plan.target.endpoint,
    ),
    input.providerOperationId
      ? projectOperation(
        input.credential,
        input.plan.source.projectId,
        input.providerOperationId,
      )
      : Promise.resolve(null),
    branchDatabaseReconciliation(
      input.credential,
      input.plan.source.projectId,
      owned.branchId,
    ),
  ]);
  const databaseFingerprint = databases === null
    ? null
    : neonBranchDatabaseFingerprint(databases);
  if (operation && operation.branchId !== owned.branchId) {
    return {
      status: "conflict",
      branchId: owned.branchId,
      providerOperationId: operation.id,
      providerOperationStatus: operation.status,
      endpointId: endpoint.endpointId,
      databaseCount: databases?.length ?? null,
      databaseFingerprint,
      retiredInheritedRoleCount: null,
      credentialFenceFingerprint: null,
      managedAccessState: "needs_repair",
      failureCode: "NEON_OPERATION_BRANCH_MISMATCH",
    };
  }
  if (
    operation
    && ["failed", "error", "cancelled", "skipped"].includes(operation.status)
  ) {
    return {
      status: "failed",
      branchId: owned.branchId,
      providerOperationId: operation.id,
      providerOperationStatus: operation.status,
      endpointId: endpoint.endpointId,
      databaseCount: databases?.length ?? null,
      databaseFingerprint,
      retiredInheritedRoleCount: null,
      credentialFenceFingerprint: null,
      managedAccessState: "needs_repair",
      failureCode: "NEON_OPERATION_FAILED",
    };
  }
  if (endpoint.status === "conflict") {
    return {
      status: "conflict",
      branchId: owned.branchId,
      providerOperationId: operation?.id ?? input.providerOperationId,
      providerOperationStatus: operation?.status ?? null,
      endpointId: endpoint.endpointId,
      databaseCount: databases?.length ?? null,
      databaseFingerprint,
      retiredInheritedRoleCount: null,
      credentialFenceFingerprint: null,
      managedAccessState: "needs_repair",
      failureCode: "NEON_ENDPOINT_SET_MISMATCH",
    };
  }
  const branches = inventory.branches.filter((branch) => branch.id === owned.branchId);
  const branch = branches.length === 1 ? branches[0] : null;
  const providerReady = branch?.currentState === "ready"
    && branch.pendingState === null
    && branch.ready
    && endpoint.status === "ready"
    && databases !== null
    && databases.length > 0
    && (!operation || operation.status === "finished");
  let credentialFence: Awaited<ReturnType<typeof retireInheritedNeonLeaseRoles>> | null = null;
  if (providerReady && input.plan.target.endpoint === "read_write") {
    try {
      credentialFence = await retireInheritedNeonLeaseRoles({
        credential: input.credential,
        projectId: input.plan.source.projectId,
        branchId: owned.branchId,
        databases,
      });
    } catch (error) {
      if (!(error instanceof NeonInheritedCredentialFenceConflictError)) throw error;
      return {
        status: "conflict",
        branchId: owned.branchId,
        providerOperationId: operation?.id ?? input.providerOperationId,
        providerOperationStatus: operation?.status ?? null,
        endpointId: endpoint.endpointId,
        databaseCount: databases.length,
        databaseFingerprint,
        retiredInheritedRoleCount: null,
        credentialFenceFingerprint: null,
        managedAccessState: "needs_repair",
        failureCode: "NEON_INHERITED_CREDENTIAL_FENCE_FAILED",
      };
    }
  }
  const ready = providerReady && (
    input.plan.target.endpoint === "none" || credentialFence !== null
  );
  return {
    status: ready ? "ready" : "pending",
    branchId: owned.branchId,
    providerOperationId: operation?.id ?? input.providerOperationId,
    providerOperationStatus: operation?.status ?? null,
    endpointId: endpoint.endpointId,
    databaseCount: ready ? databases.length : null,
    databaseFingerprint: ready ? databaseFingerprint : null,
    retiredInheritedRoleCount: ready
      ? credentialFence?.retiredInheritedRoleCount ?? null
      : null,
    credentialFenceFingerprint: ready
      ? credentialFence?.credentialFenceFingerprint ?? null
      : null,
    managedAccessState: ready
      ? input.plan.target.endpoint === "read_write"
        ? "bootstrap_required"
        : "not_requested"
      : "waiting_for_provider",
    failureCode: null,
  };
}

export async function reconcileNeonBranchDelete(input: {
  credential: NeonCredential;
  plan: NeonBranchDeletePlan;
  providerOperationId: string | null;
}): Promise<NeonBranchDeleteReconciliation> {
  const inventory = await listNeonBranchInventory(
    input.credential,
    input.plan.target.projectId,
  );
  const branch = inventory.branches.find(
    (candidate) => candidate.id === input.plan.target.branchId,
  ) ?? null;
  let operation = null;
  if (input.providerOperationId) {
    try {
      operation = await projectOperation(
        input.credential,
        input.plan.target.projectId,
        input.providerOperationId,
      );
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.status !== 404) throw error;
    }
  }
  const base = {
    branchId: input.plan.target.branchId,
    providerOperationId: operation?.id ?? input.providerOperationId,
    providerOperationStatus: operation?.status ?? null,
    endpointId: null,
    databaseCount: null,
    databaseFingerprint: null,
    retiredInheritedRoleCount: null,
    credentialFenceFingerprint: null,
    managedAccessState: "unavailable" as const,
  };
  if (operation && operation.branchId !== input.plan.target.branchId) {
    return {
      ...base,
      status: "conflict",
      failureCode: "NEON_DELETE_OPERATION_BRANCH_MISMATCH",
    };
  }
  if (
    operation
    && ["failed", "error", "cancelled", "skipped"].includes(operation.status)
  ) {
    return {
      ...base,
      status: "failed",
      failureCode: "NEON_DELETE_OPERATION_FAILED",
    };
  }
  if (!branch && (!operation || operation.status === "finished")) {
    return { ...base, status: "ready", failureCode: null };
  }
  if (branch && operation?.status === "finished") {
    return {
      ...base,
      status: "conflict",
      failureCode: "NEON_DELETE_RESOURCE_STILL_PRESENT",
    };
  }
  return { ...base, status: "pending", failureCode: null };
}
