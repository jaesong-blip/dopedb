// Runtime-neutral, secret-free planning contract for moving one managed
// workspace connection to another verified Neon branch. The target is an exact
// branch/database identity; execution must revoke the old lease epoch before
// committing the new connection revision.

import type { NeonBranchInventory, NeonBranchInventoryItem } from "./neon-branches";
import { neonSegment } from "./neon-identifiers";

const PLAN_VERSION = 1 as const;
export const NEON_BRANCH_SWITCH_PLAN_TTL_MS = 10 * 60 * 1_000;

export type NeonBranchSwitchPlanRequest = Readonly<{
  idempotencyKey: string;
  projectId: string;
  connectionId: string;
  targetBranchId: string;
  targetEnvironment: "development" | "production";
}>;

export type NeonBranchSwitchConnectionSnapshot = Readonly<{
  connectionId: string;
  connectionName: string;
  providerResourceId: string;
  projectId: string;
  sourceBranchId: string;
  databaseId: string;
  database: string;
  schemas: readonly string[];
  environment: "development" | "production";
  readonlyDefault: boolean;
  allowWrites: boolean;
  schemaGroup: string | null;
  contentRevision: number;
  authorityRevision: number;
  activeLeaseCount: number;
}>;

export type NeonBranchSwitchTargetSnapshot = Readonly<{
  branch: NeonBranchInventoryItem;
  databaseId: string;
  database: string;
  endpointId: string;
  databaseFingerprint: string;
  resourceFingerprint: string;
  managedAccessOperationId: string | null;
}>;

type BranchSnapshot = Readonly<{
  branchId: string;
  name: string;
  currentState: NeonBranchInventoryItem["currentState"];
  pendingState: NeonBranchInventoryItem["pendingState"];
  stateChangedAt: string;
  updatedAt: string;
  default: boolean;
  protected: boolean;
  restrictedActions: NeonBranchInventoryItem["restrictedActions"];
}>;

export type NeonBranchSwitchPlan = Readonly<{
  version: typeof PLAN_VERSION;
  kind: "neon.branch.switch";
  operationId: string;
  integrationId: string;
  integrationGeneration: string;
  issuedAt: string;
  expiresAt: string;
  source: BranchSnapshot & Readonly<{
    projectId: string;
    connectionId: string;
    connectionName: string;
    providerResourceId: string;
    databaseId: string;
    database: string;
    schemas: readonly string[];
    environment: "development" | "production";
    readonlyDefault: boolean;
    allowWrites: boolean;
    schemaGroup: string | null;
    contentRevision: number;
    authorityRevision: number;
    activeLeaseCount: number;
  }>;
  target: BranchSnapshot & Readonly<{
    projectId: string;
    databaseId: string;
    database: string;
    endpointId: string;
    databaseFingerprint: string;
    resourceFingerprint: string;
    managedAccessOperationId: string | null;
    environment: "development" | "production";
  }>;
  impact: Readonly<{
    activeLeaseCount: number;
    closesExistingSessions: true;
    createsConnectionRevision: true;
    reintrospectionRequired: true;
  }>;
  risk: "standard" | "production_data";
  approvalPolicy: "single_admin" | "separate_admin";
  warningCodes: readonly string[];
}>;

export class NeonBranchSwitchPlanError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 500) {
    super(message);
    this.name = "NeonBranchSwitchPlanError";
  }
}

function invalid(message: string, status: 400 | 409 | 500 = 400): never {
  throw new NeonBranchSwitchPlanError(message, status);
}

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
    ? record
    : null;
}

function uuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function branchSnapshot(branch: NeonBranchInventoryItem): BranchSnapshot {
  return {
    branchId: branch.id,
    name: branch.name,
    currentState: branch.currentState,
    pendingState: branch.pendingState,
    stateChangedAt: branch.stateChangedAt,
    updatedAt: branch.updatedAt,
    default: branch.default,
    protected: branch.protected,
    restrictedActions: branch.restrictedActions.map((action) => ({ ...action })),
  };
}

function sameRestrictedActions(
  left: NeonBranchInventoryItem["restrictedActions"],
  right: NeonBranchInventoryItem["restrictedActions"],
) {
  return left.length === right.length && left.every((item, index) => (
    item.name === right[index]?.name && item.reason === right[index]?.reason
  ));
}

function sameBranchSnapshot(branch: NeonBranchInventoryItem, snapshot: BranchSnapshot) {
  return branch.id === snapshot.branchId
    && branch.name === snapshot.name
    && branch.currentState === snapshot.currentState
    && branch.pendingState === snapshot.pendingState
    && branch.stateChangedAt === snapshot.stateChangedAt
    && branch.updatedAt === snapshot.updatedAt
    && branch.default === snapshot.default
    && branch.protected === snapshot.protected
    && sameRestrictedActions(branch.restrictedActions, snapshot.restrictedActions);
}

function safeConnectionSnapshot(connection: NeonBranchSwitchConnectionSnapshot) {
  return uuid(connection.connectionId)
    && typeof connection.connectionName === "string"
    && connection.connectionName.length > 0
    && connection.connectionName.length <= 120
    && uuid(connection.providerResourceId)
    && neonSegment(connection.projectId)
    && neonSegment(connection.sourceBranchId)
    && /^[0-9]{1,19}$/.test(connection.databaseId)
    && typeof connection.database === "string"
    && connection.database.length > 0
    && connection.database.length <= 256
    && connection.schemas.length > 0
    && connection.schemas.length <= 32
    && new Set(connection.schemas).size === connection.schemas.length
    && connection.schemas.every((schema) => (
      typeof schema === "string" && schema.length > 0 && schema.length <= 63
    ))
    && (connection.environment === "development" || connection.environment === "production")
    && (connection.schemaGroup === null || (
      typeof connection.schemaGroup === "string" && connection.schemaGroup.length <= 120
    ))
    && Number.isSafeInteger(connection.contentRevision)
    && connection.contentRevision >= 1
    && Number.isSafeInteger(connection.authorityRevision)
    && connection.authorityRevision >= 1
    && Number.isSafeInteger(connection.activeLeaseCount)
    && connection.activeLeaseCount >= 0
    && connection.activeLeaseCount <= 10_000;
}

function safeTargetSnapshot(target: NeonBranchSwitchTargetSnapshot) {
  return /^[0-9]{1,19}$/.test(target.databaseId)
    && typeof target.database === "string"
    && target.database.length > 0
    && target.database.length <= 256
    && neonSegment(target.endpointId)
    && /^[0-9a-f]{64}$/.test(target.databaseFingerprint)
    && /^[0-9a-f]{64}$/.test(target.resourceFingerprint)
    && (target.managedAccessOperationId === null
      || uuid(target.managedAccessOperationId));
}

function readyBranch(
  inventory: NeonBranchInventory,
  branchId: string,
  label: "source" | "target",
) {
  const matches = inventory.branches.filter((branch) => branch.id === branchId);
  const branch = matches.length === 1 ? matches[0] : null;
  if (
    !branch
    || !branch.ready
    || branch.currentState !== "ready"
    || branch.pendingState !== null
    || branch.restrictedActions.length > 0
  ) {
    return invalid(`Neon ${label} branch is not ready`, 409);
  }
  return branch;
}

function assertEnvironment(
  branch: NeonBranchInventoryItem,
  environment: "development" | "production",
  label: "source" | "target",
) {
  if (
    (branch.protected || branch.production === true)
      ? environment !== "production"
      : branch.production === false && environment !== "development"
  ) {
    return invalid(`Neon ${label} branch environment changed`, 409);
  }
}

export function parseNeonBranchSwitchPlanRequest(
  value: unknown,
): NeonBranchSwitchPlanRequest {
  const request = exactRecord(value, [
    "idempotencyKey",
    "projectId",
    "connectionId",
    "targetBranchId",
    "targetEnvironment",
  ]);
  if (
    !request
    || !uuid(request.idempotencyKey)
    || !neonSegment(request.projectId)
    || !uuid(request.connectionId)
    || !neonSegment(request.targetBranchId)
    || (request.targetEnvironment !== "development"
      && request.targetEnvironment !== "production")
  ) {
    return invalid("Invalid Neon branch switch plan request");
  }
  return request as NeonBranchSwitchPlanRequest;
}

export function buildNeonBranchSwitchPlan(input: {
  request: NeonBranchSwitchPlanRequest;
  inventory: NeonBranchInventory;
  connection: NeonBranchSwitchConnectionSnapshot;
  target: NeonBranchSwitchTargetSnapshot;
  operationId: string;
  integrationId: string;
  integrationGeneration: bigint;
  now: Date;
}): NeonBranchSwitchPlan {
  if (
    !uuid(input.operationId)
    || !uuid(input.integrationId)
    || input.integrationGeneration < 1n
    || Number.isNaN(input.now.valueOf())
    || input.inventory.projectId !== input.request.projectId
    || input.connection.connectionId !== input.request.connectionId
    || input.connection.projectId !== input.request.projectId
    || !safeConnectionSnapshot(input.connection)
    || !safeTargetSnapshot(input.target)
    || input.target.branch.projectId !== input.request.projectId
    || input.target.branch.id !== input.request.targetBranchId
  ) {
    return invalid("Invalid Neon branch switch plan context", 500);
  }
  if (input.connection.sourceBranchId === input.request.targetBranchId) {
    return invalid("Neon connection already targets this branch", 409);
  }
  if (
    input.target.database !== input.connection.database
    || input.target.databaseId.length === 0
  ) {
    return invalid("Neon target branch does not contain the same database", 409);
  }
  const sourceBranch = readyBranch(
    input.inventory,
    input.connection.sourceBranchId,
    "source",
  );
  const targetBranch = readyBranch(
    input.inventory,
    input.request.targetBranchId,
    "target",
  );
  assertEnvironment(sourceBranch, input.connection.environment, "source");
  assertEnvironment(targetBranch, input.request.targetEnvironment, "target");

  const productionData = input.connection.environment === "production"
    || input.request.targetEnvironment === "production";
  const warningCodes = [
    "NEON_CONNECTION_TARGET_CHANGES",
    "NEON_ACTIVE_ACCESS_REVOKED",
    ...(productionData ? ["NEON_PRODUCTION_TARGET_SWITCH"] : []),
  ];
  const issuedAt = new Date(input.now.valueOf());
  const expiresAt = new Date(input.now.valueOf() + NEON_BRANCH_SWITCH_PLAN_TTL_MS);
  return {
    version: PLAN_VERSION,
    kind: "neon.branch.switch",
    operationId: input.operationId,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration.toString(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    source: {
      ...branchSnapshot(sourceBranch),
      projectId: input.connection.projectId,
      connectionId: input.connection.connectionId,
      connectionName: input.connection.connectionName,
      providerResourceId: input.connection.providerResourceId,
      databaseId: input.connection.databaseId,
      database: input.connection.database,
      schemas: [...input.connection.schemas],
      environment: input.connection.environment,
      readonlyDefault: input.connection.readonlyDefault,
      allowWrites: input.connection.allowWrites,
      schemaGroup: input.connection.schemaGroup,
      contentRevision: input.connection.contentRevision,
      authorityRevision: input.connection.authorityRevision,
      activeLeaseCount: input.connection.activeLeaseCount,
    },
    target: {
      ...branchSnapshot(targetBranch),
      projectId: input.request.projectId,
      databaseId: input.target.databaseId,
      database: input.target.database,
      endpointId: input.target.endpointId,
      databaseFingerprint: input.target.databaseFingerprint,
      resourceFingerprint: input.target.resourceFingerprint,
      managedAccessOperationId: input.target.managedAccessOperationId,
      environment: input.request.targetEnvironment,
    },
    impact: {
      activeLeaseCount: input.connection.activeLeaseCount,
      closesExistingSessions: true,
      createsConnectionRevision: true,
      reintrospectionRequired: true,
    },
    risk: productionData ? "production_data" : "standard",
    approvalPolicy: productionData ? "separate_admin" : "single_admin",
    warningCodes,
  };
}

export function revalidateNeonBranchSwitchPlan(input: {
  plan: NeonBranchSwitchPlan;
  inventory: NeonBranchInventory;
  connection: NeonBranchSwitchConnectionSnapshot;
  target: NeonBranchSwitchTargetSnapshot;
  now: Date;
}) {
  const issuedAt = Date.parse(input.plan.issuedAt);
  const expiresAt = Date.parse(input.plan.expiresAt);
  if (
    Number.isNaN(input.now.valueOf())
    || Number.isNaN(issuedAt)
    || Number.isNaN(expiresAt)
    || expiresAt - issuedAt !== NEON_BRANCH_SWITCH_PLAN_TTL_MS
    || input.now.valueOf() >= expiresAt
  ) {
    return invalid("Neon branch switch plan expired", 409);
  }
  revalidateNeonBranchSwitchTarget({
    plan: input.plan,
    inventory: input.inventory,
    target: input.target,
  });
  const sourceBranch = readyBranch(input.inventory, input.plan.source.branchId, "source");
  if (
    input.inventory.projectId !== input.plan.source.projectId
    || input.plan.target.projectId !== input.plan.source.projectId
    || !sameBranchSnapshot(sourceBranch, input.plan.source)
    || !safeConnectionSnapshot(input.connection)
    || input.connection.connectionId !== input.plan.source.connectionId
    || input.connection.connectionName !== input.plan.source.connectionName
    || input.connection.providerResourceId !== input.plan.source.providerResourceId
    || input.connection.projectId !== input.plan.source.projectId
    || input.connection.sourceBranchId !== input.plan.source.branchId
    || input.connection.databaseId !== input.plan.source.databaseId
    || input.connection.database !== input.plan.source.database
    || input.connection.schemas.length !== input.plan.source.schemas.length
    || input.connection.schemas.some((schema, index) => schema !== input.plan.source.schemas[index])
    || input.connection.environment !== input.plan.source.environment
    || input.connection.readonlyDefault !== input.plan.source.readonlyDefault
    || input.connection.allowWrites !== input.plan.source.allowWrites
    || input.connection.schemaGroup !== input.plan.source.schemaGroup
    || input.connection.contentRevision !== input.plan.source.contentRevision
    || input.connection.authorityRevision !== input.plan.source.authorityRevision
    || input.connection.activeLeaseCount !== input.plan.source.activeLeaseCount
  ) {
    return invalid("Neon branch switch authority changed after planning", 409);
  }
  assertEnvironment(sourceBranch, input.plan.source.environment, "source");
  return input.plan;
}

/** Rechecks provider target facts after the irreversible old-lease fence. */
export function revalidateNeonBranchSwitchTarget(input: {
  plan: NeonBranchSwitchPlan;
  inventory: NeonBranchInventory;
  target: NeonBranchSwitchTargetSnapshot;
}) {
  const targetBranch = readyBranch(input.inventory, input.plan.target.branchId, "target");
  if (
    input.inventory.projectId !== input.plan.target.projectId
    || !sameBranchSnapshot(targetBranch, input.plan.target)
    || !safeTargetSnapshot(input.target)
    || input.target.branch.id !== input.plan.target.branchId
    || input.target.databaseId !== input.plan.target.databaseId
    || input.target.database !== input.plan.target.database
    || input.target.endpointId !== input.plan.target.endpointId
    || input.target.databaseFingerprint !== input.plan.target.databaseFingerprint
    || input.target.resourceFingerprint !== input.plan.target.resourceFingerprint
    || input.target.managedAccessOperationId !== input.plan.target.managedAccessOperationId
  ) {
    return invalid("Neon branch switch target changed after planning", 409);
  }
  assertEnvironment(targetBranch, input.plan.target.environment, "target");
  return input.plan;
}
