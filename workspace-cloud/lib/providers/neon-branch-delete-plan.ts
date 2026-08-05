// Runtime-neutral, secret-free planning contract for one Neon branch delete.
// Only a live, ready, DopeDB-owned leaf with no workspace authority may enter
// this plan. Execution always uses Neon's recoverable default delete behavior.

import type {
  NeonBranchInventory,
  NeonBranchInventoryItem,
} from "./neon-branches";
import { neonSegment } from "./neon-identifiers";

const PLAN_VERSION = 1 as const;
export const NEON_BRANCH_DELETE_PLAN_TTL_MS = 10 * 60 * 1_000;

export type NeonBranchDeletePlanRequest = Readonly<{
  idempotencyKey: string;
  projectId: string;
  branchId: string;
}>;

export type NeonBranchDeleteReferenceSnapshot = Readonly<{
  connectionCount: number;
  activeLeaseCount: number;
  endpointIds: readonly string[];
}>;

export type NeonBranchDeleteOwnershipProof = Readonly<{
  createOperationId: string;
  createPlanHash: string;
}>;

export type NeonBranchDeleteOwnershipBoundary = Readonly<{
  operationId: string;
  state: string;
  planHash: string;
  ownershipMarker: string;
  branchId: string;
}>;

export type NeonBranchDeletePlan = Readonly<{
  version: typeof PLAN_VERSION;
  kind: "neon.branch.delete";
  operationId: string;
  integrationId: string;
  integrationGeneration: string;
  issuedAt: string;
  expiresAt: string;
  target: Readonly<{
    projectId: string;
    branchId: string;
    parentId: string | null;
    treeParentId: string | null;
    name: string;
    currentState: NeonBranchInventoryItem["currentState"];
    pendingState: NeonBranchInventoryItem["pendingState"];
    stateChangedAt: string;
    createdAt: string;
    updatedAt: string;
    creationSource: string;
    initSource: NeonBranchInventoryItem["initSource"];
    default: false;
    protected: false;
    expiresAt: string | null;
    restrictedActions: readonly [];
    childBranchIds: readonly [];
  }>;
  references: NeonBranchDeleteReferenceSnapshot;
  ownership: NeonBranchDeleteOwnershipProof;
  deletionMode: "provider_default_soft_delete";
  risk: "standard";
  approvalPolicy: "single_admin";
  warningCodes: readonly [
    "NEON_BRANCH_CONNECTIONS_TERMINATE",
    "NEON_SOFT_DELETE_RECOVERY_NOT_GUARANTEED",
  ];
}>;

export class NeonBranchDeletePlanError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 500) {
    super(message);
    this.name = "NeonBranchDeletePlanError";
  }
}

function invalid(message: string, status: 400 | 409 | 500 = 400): never {
  throw new NeonBranchDeletePlanError(message, status);
}

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(record, field))
  ) {
    return null;
  }
  return record;
}

function uuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function sameRestrictedActions(
  left: NeonBranchInventoryItem["restrictedActions"],
  right: NeonBranchInventoryItem["restrictedActions"],
) {
  return left.length === right.length && left.every((item, index) => (
    item.name === right[index]?.name && item.reason === right[index]?.reason
  ));
}

function sortedUniqueSegments(values: readonly string[]) {
  if (
    values.length > 64
    || values.some((value) => !neonSegment(value))
    || new Set(values).size !== values.length
  ) {
    return invalid("Invalid Neon branch delete reference snapshot", 500);
  }
  return [...values].sort();
}

function validateReferenceSnapshot(snapshot: NeonBranchDeleteReferenceSnapshot) {
  if (
    !Number.isInteger(snapshot.connectionCount)
    || snapshot.connectionCount !== 0
    || !Number.isInteger(snapshot.activeLeaseCount)
    || snapshot.activeLeaseCount !== 0
  ) {
    return invalid("Neon branch is still referenced by workspace authority", 409);
  }
  return {
    connectionCount: 0,
    activeLeaseCount: 0,
    endpointIds: sortedUniqueSegments(snapshot.endpointIds),
  } as const;
}

function ownedReadyLeaf(input: {
  inventory: NeonBranchInventory;
  branchId: string;
  ownership: NeonBranchDeleteOwnershipBoundary;
}) {
  const branches = input.inventory.branches.filter((branch) => branch.id === input.branchId);
  const branch = branches.length === 1 ? branches[0] : null;
  if (!branch) return invalid("Neon branch is unavailable", 409);
  if (
    branch.currentState !== "ready"
    || branch.pendingState !== null
    || !branch.ready
  ) {
    return invalid("Neon branch is not ready for deletion", 409);
  }
  if (branch.treeParentId === null) {
    return invalid("Neon root branch cannot be deleted", 409);
  }
  if (branch.default) return invalid("Neon default branch cannot be deleted", 409);
  if (branch.protected) return invalid("Neon protected branch cannot be deleted", 409);
  if (branch.restrictedActions.length > 0) {
    return invalid("Neon currently restricts this branch mutation", 409);
  }
  if (input.inventory.branches.some((candidate) => candidate.treeParentId === branch.id)) {
    return invalid("Neon branch with child branches cannot be deleted", 409);
  }
  if (
    input.ownership.branchId !== branch.id
    || input.ownership.state !== "succeeded"
    || !uuid(input.ownership.operationId)
    || !/^[0-9a-f]{64}$/.test(input.ownership.planHash)
    || !/^v1\.[A-Za-z0-9_-]{43}$/.test(input.ownership.ownershipMarker)
  ) {
    return invalid("Only a completed DopeDB-owned branch can be deleted", 409);
  }
  return branch;
}

export function parseNeonBranchDeletePlanRequest(
  value: unknown,
): NeonBranchDeletePlanRequest {
  const request = exactRecord(value, ["idempotencyKey", "projectId", "branchId"]);
  if (
    !request
    || !uuid(request.idempotencyKey)
    || !neonSegment(request.projectId)
    || !neonSegment(request.branchId)
  ) {
    return invalid("Invalid Neon branch delete plan request");
  }
  return {
    idempotencyKey: request.idempotencyKey,
    projectId: request.projectId,
    branchId: request.branchId,
  };
}

export function buildNeonBranchDeletePlan(input: {
  request: NeonBranchDeletePlanRequest;
  inventory: NeonBranchInventory;
  ownership: NeonBranchDeleteOwnershipBoundary;
  references: NeonBranchDeleteReferenceSnapshot;
  operationId: string;
  integrationId: string;
  integrationGeneration: bigint;
  now: Date;
}): NeonBranchDeletePlan {
  if (
    !uuid(input.operationId)
    || !uuid(input.integrationId)
    || input.integrationGeneration < 1n
    || input.inventory.projectId !== input.request.projectId
    || Number.isNaN(input.now.valueOf())
  ) {
    return invalid("Invalid Neon branch delete plan context", 500);
  }
  const branch = ownedReadyLeaf({
    inventory: input.inventory,
    branchId: input.request.branchId,
    ownership: input.ownership,
  });
  const references = validateReferenceSnapshot(input.references);
  const issuedAt = new Date(input.now.valueOf());
  const expiresAt = new Date(input.now.valueOf() + NEON_BRANCH_DELETE_PLAN_TTL_MS);
  return {
    version: PLAN_VERSION,
    kind: "neon.branch.delete",
    operationId: input.operationId,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration.toString(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    target: {
      projectId: branch.projectId,
      branchId: branch.id,
      parentId: branch.parentId,
      treeParentId: branch.treeParentId,
      name: branch.name,
      currentState: branch.currentState,
      pendingState: branch.pendingState,
      stateChangedAt: branch.stateChangedAt,
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt,
      creationSource: branch.creationSource,
      initSource: branch.initSource,
      default: false,
      protected: false,
      expiresAt: branch.expiresAt,
      restrictedActions: [],
      childBranchIds: [],
    },
    references,
    ownership: {
      createOperationId: input.ownership.operationId,
      createPlanHash: input.ownership.planHash,
    },
    deletionMode: "provider_default_soft_delete",
    risk: "standard",
    approvalPolicy: "single_admin",
    warningCodes: [
      "NEON_BRANCH_CONNECTIONS_TERMINATE",
      "NEON_SOFT_DELETE_RECOVERY_NOT_GUARANTEED",
    ],
  };
}

export function revalidateNeonBranchDeletePlan(input: {
  plan: NeonBranchDeletePlan;
  inventory: NeonBranchInventory;
  ownership: NeonBranchDeleteOwnershipBoundary;
  references: NeonBranchDeleteReferenceSnapshot;
  now: Date;
}) {
  const issuedAt = Date.parse(input.plan.issuedAt);
  const expiresAt = Date.parse(input.plan.expiresAt);
  if (
    Number.isNaN(input.now.valueOf())
    || Number.isNaN(issuedAt)
    || Number.isNaN(expiresAt)
    || expiresAt - issuedAt !== NEON_BRANCH_DELETE_PLAN_TTL_MS
    || input.now.valueOf() >= expiresAt
  ) {
    return invalid("Neon branch delete plan expired", 409);
  }
  if (input.inventory.projectId !== input.plan.target.projectId) {
    return invalid("Neon branch delete project changed", 409);
  }
  const branch = ownedReadyLeaf({
    inventory: input.inventory,
    branchId: input.plan.target.branchId,
    ownership: input.ownership,
  });
  const references = validateReferenceSnapshot(input.references);
  if (
    branch.projectId !== input.plan.target.projectId
    || branch.parentId !== input.plan.target.parentId
    || branch.treeParentId !== input.plan.target.treeParentId
    || branch.name !== input.plan.target.name
    || branch.currentState !== input.plan.target.currentState
    || branch.pendingState !== input.plan.target.pendingState
    || branch.stateChangedAt !== input.plan.target.stateChangedAt
    || branch.createdAt !== input.plan.target.createdAt
    || branch.updatedAt !== input.plan.target.updatedAt
    || branch.creationSource !== input.plan.target.creationSource
    || branch.initSource !== input.plan.target.initSource
    || branch.default !== input.plan.target.default
    || branch.protected !== input.plan.target.protected
    || branch.expiresAt !== input.plan.target.expiresAt
    || !sameRestrictedActions(branch.restrictedActions, input.plan.target.restrictedActions)
    || input.ownership.operationId !== input.plan.ownership.createOperationId
    || input.ownership.planHash !== input.plan.ownership.createPlanHash
    || references.connectionCount !== input.plan.references.connectionCount
    || references.activeLeaseCount !== input.plan.references.activeLeaseCount
    || references.endpointIds.length !== input.plan.references.endpointIds.length
    || references.endpointIds.some((id, index) => id !== input.plan.references.endpointIds[index])
  ) {
    return invalid("Neon branch changed after delete planning", 409);
  }
  return input.plan;
}
