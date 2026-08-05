export type NeonBranchConnectionReference = Readonly<{
  connectionId: string;
  connectionName: string;
  database: string;
  environment: string | null;
  allowWrites: boolean;
  contentRevision: number;
  authorityRevision: number;
  activeLeaseCount: number;
}>;

export type NeonBranchInventoryItem = Readonly<{
  id: string;
  projectId: string;
  parentId: string | null;
  treeParentId: string | null;
  name: string;
  currentState: "init" | "resetting" | "ready" | "archived" | "unknown";
  pendingState: "init" | "resetting" | "ready" | "archived" | "unknown" | null;
  stateChangedAt: string;
  createdAt: string;
  updatedAt: string;
  creationSource: string;
  initSource: "parent-data" | "schema-only" | "unknown";
  sourceLsn: string | null;
  sourceTimestamp: string | null;
  default: boolean;
  protected: boolean;
  expiresAt: string | null;
  restrictedActions: readonly Readonly<{ name: string; reason: string }>[];
  production: boolean | "unknown";
  ready: boolean;
  depth: number;
  managedAccess: Readonly<{
    operationId: string;
    state: NeonBranchOperationState;
    status: NeonManagedAccessState;
  }> | null;
  deletion: Readonly<{
    canPlan: boolean;
    blockerCodes: readonly string[];
  }> | null;
  connections: readonly NeonBranchConnectionReference[];
}>;

export type NeonBranchInventory = Readonly<{
  projectId: string;
  integrationGeneration: string;
  observedAt: string;
  rootIds: readonly string[];
  branches: readonly NeonBranchInventoryItem[];
}>;

export type NeonBranchSourcePoint =
  | Readonly<{ kind: "head" }>
  | Readonly<{ kind: "lsn" | "timestamp"; value: string }>;

export type NeonBranchCreatePlan = Readonly<{
  version: 1;
  kind: "neon.branch.create";
  operationId: string;
  integrationId: string;
  integrationGeneration: string;
  issuedAt: string;
  expiresAt: string;
  source: Readonly<{
    projectId: string;
    branchId: string;
    name: string;
    protected: boolean;
    default: boolean;
    environment: "development" | "production";
    point: NeonBranchSourcePoint;
  }>;
  target: Readonly<{
    name: string;
    initSource: "parent-data" | "schema-only";
    endpoint: "none" | "read_write";
    copiesData: boolean;
    createsCompute: boolean;
  }>;
  risk: "standard" | "production_data";
  approvalPolicy: "single_admin" | "separate_admin";
  warningCodes: readonly string[];
}>;

export type NeonBranchDeletePlan = Readonly<{
  version: 1;
  kind: "neon.branch.delete";
  operationId: string;
  integrationId: string;
  integrationGeneration: string;
  issuedAt: string;
  expiresAt: string;
  target: Readonly<{
    projectId: string;
    branchId: string;
    name: string;
    default: false;
    protected: false;
    expiresAt: string | null;
  }>;
  references: Readonly<{
    connectionCount: 0;
    activeLeaseCount: 0;
    endpointIds: readonly string[];
  }>;
  ownership: Readonly<{
    createOperationId: string;
    createPlanHash: string;
  }>;
  deletionMode: "provider_default_soft_delete";
  risk: "standard";
  approvalPolicy: "single_admin";
  warningCodes: readonly string[];
}>;

export type NeonBranchPlan = NeonBranchCreatePlan | NeonBranchDeletePlan;

export type NeonBranchOperationState =
  | "awaiting_approval"
  | "approved"
  | "claimed"
  | "remote_started"
  | "reconciling"
  | "succeeded"
  | "failed"
  | "needs_repair"
  | "cancelled";

export type NeonManagedAccessState =
  | "waiting_for_provider"
  | "not_requested"
  | "bootstrap_required"
  | "ready"
  | "needs_repair"
  | "unavailable";

export type NeonBranchOperation = Readonly<{
  id: string;
  state: NeonBranchOperationState;
  planHash: string;
  planExpiresAt: string;
  expired: boolean;
  risk: "standard" | "production_data";
  approvalPolicy: "single_admin" | "separate_admin";
  requestedByCurrentActor: boolean;
  canApprove: boolean;
  canReject: boolean;
  canExecute: boolean;
  needsCredentialFenceRecovery: boolean;
  providerOperationId: string | null;
  branchId: string | null;
  reconcileAfter: string | null;
  endpointId: string | null;
  databaseCount: number | null;
  retiredInheritedRoleCount: number | null;
  managedAccessState: NeonManagedAccessState | null;
  failureCode: string | null;
  plan: NeonBranchPlan;
}>;

export type NeonBranchOperations = Readonly<{
  integrationGeneration: string;
  operations: readonly NeonBranchOperation[];
}>;

const operationStates: readonly NeonBranchOperationState[] = [
  "awaiting_approval",
  "approved",
  "claimed",
  "remote_started",
  "reconciling",
  "succeeded",
  "failed",
  "needs_repair",
  "cancelled",
];
const managedAccessStates: readonly NeonManagedAccessState[] = [
  "waiting_for_provider",
  "not_requested",
  "bootstrap_required",
  "ready",
  "needs_repair",
  "unavailable",
];
const branchStates = ["init", "resetting", "ready", "archived", "unknown"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exact(value: unknown, fields: readonly string[]) {
  const row = record(value);
  return row
    && Object.keys(row).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(row, field))
    ? row
    : null;
}

function safeText(value: unknown, maximum = 512): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);
}

function segment(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,59}$/.test(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function instant(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function integer(value: unknown, maximum = 1_000_000): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= maximum;
}

function nullable<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T | null {
  return value === null || predicate(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function parseSourcePoint(value: unknown): NeonBranchSourcePoint | null {
  const row = record(value);
  if (row?.kind === "head" && Object.keys(row).length === 1) return { kind: "head" };
  if (
    row
    && (row.kind === "lsn" || row.kind === "timestamp")
    && Object.keys(row).length === 2
    && safeText(row.value, 64)
  ) {
    return { kind: row.kind, value: row.value };
  }
  return null;
}

function parseCreatePlan(value: unknown): NeonBranchCreatePlan | null {
  const row = record(value);
  const source = record(row?.source);
  const target = record(row?.target);
  const point = parseSourcePoint(source?.point);
  if (
    !row
    || row.version !== 1
    || row.kind !== "neon.branch.create"
    || !uuid(row.operationId)
    || !uuid(row.integrationId)
    || typeof row.integrationGeneration !== "string"
    || !/^\d+$/.test(row.integrationGeneration)
    || !instant(row.issuedAt)
    || !instant(row.expiresAt)
    || !source
    || !segment(source.projectId)
    || !segment(source.branchId)
    || !safeText(source.name, 256)
    || typeof source.protected !== "boolean"
    || typeof source.default !== "boolean"
    || (source.environment !== "development" && source.environment !== "production")
    || !point
    || !target
    || !safeText(target.name, 256)
    || (target.initSource !== "parent-data" && target.initSource !== "schema-only")
    || (target.endpoint !== "none" && target.endpoint !== "read_write")
    || typeof target.copiesData !== "boolean"
    || typeof target.createsCompute !== "boolean"
    || (row.risk !== "standard" && row.risk !== "production_data")
    || (row.approvalPolicy !== "single_admin" && row.approvalPolicy !== "separate_admin")
    || !Array.isArray(row.warningCodes)
    || row.warningCodes.length > 16
    || !row.warningCodes.every((code) => (
      typeof code === "string" && /^NEON_[A-Z0-9_]{1,95}$/.test(code)
    ))
  ) {
    return null;
  }
  return {
    version: 1,
    kind: "neon.branch.create",
    operationId: row.operationId,
    integrationId: row.integrationId,
    integrationGeneration: row.integrationGeneration,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    source: {
      projectId: source.projectId,
      branchId: source.branchId,
      name: source.name,
      protected: source.protected,
      default: source.default,
      environment: source.environment,
      point,
    },
    target: {
      name: target.name,
      initSource: target.initSource,
      endpoint: target.endpoint,
      copiesData: target.copiesData,
      createsCompute: target.createsCompute,
    },
    risk: row.risk,
    approvalPolicy: row.approvalPolicy,
    warningCodes: row.warningCodes as string[],
  };
}

function parseDeletePlan(value: unknown): NeonBranchDeletePlan | null {
  const row = record(value);
  const target = record(row?.target);
  const references = exact(row?.references, [
    "connectionCount",
    "activeLeaseCount",
    "endpointIds",
  ]);
  const ownership = exact(row?.ownership, ["createOperationId", "createPlanHash"]);
  if (
    !row
    || row.version !== 1
    || row.kind !== "neon.branch.delete"
    || !uuid(row.operationId)
    || !uuid(row.integrationId)
    || typeof row.integrationGeneration !== "string"
    || !/^\d+$/.test(row.integrationGeneration)
    || !instant(row.issuedAt)
    || !instant(row.expiresAt)
    || !target
    || !segment(target.projectId)
    || !segment(target.branchId)
    || !safeText(target.name, 256)
    || target.default !== false
    || target.protected !== false
    || !nullable(target.expiresAt, instant)
    || !references
    || references.connectionCount !== 0
    || references.activeLeaseCount !== 0
    || !Array.isArray(references.endpointIds)
    || references.endpointIds.length > 64
    || !references.endpointIds.every(segment)
    || new Set(references.endpointIds).size !== references.endpointIds.length
    || !ownership
    || !uuid(ownership.createOperationId)
    || typeof ownership.createPlanHash !== "string"
    || !/^[0-9a-f]{64}$/.test(ownership.createPlanHash)
    || row.deletionMode !== "provider_default_soft_delete"
    || row.risk !== "standard"
    || row.approvalPolicy !== "single_admin"
    || !Array.isArray(row.warningCodes)
    || row.warningCodes.length > 16
    || !row.warningCodes.every((code) => (
      typeof code === "string" && /^NEON_[A-Z0-9_]{1,95}$/.test(code)
    ))
  ) {
    return null;
  }
  return {
    version: 1,
    kind: "neon.branch.delete",
    operationId: row.operationId,
    integrationId: row.integrationId,
    integrationGeneration: row.integrationGeneration,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    target: {
      projectId: target.projectId,
      branchId: target.branchId,
      name: target.name,
      default: false,
      protected: false,
      expiresAt: target.expiresAt as string | null,
    },
    references: {
      connectionCount: 0,
      activeLeaseCount: 0,
      endpointIds: references.endpointIds as string[],
    },
    ownership: {
      createOperationId: ownership.createOperationId,
      createPlanHash: ownership.createPlanHash,
    },
    deletionMode: "provider_default_soft_delete",
    risk: "standard",
    approvalPolicy: "single_admin",
    warningCodes: row.warningCodes as string[],
  };
}

function parsePlan(value: unknown): NeonBranchPlan | null {
  const row = record(value);
  if (row?.kind === "neon.branch.create") return parseCreatePlan(value);
  if (row?.kind === "neon.branch.delete") return parseDeletePlan(value);
  return null;
}

function parseConnection(value: unknown): NeonBranchConnectionReference | null {
  const row = exact(value, [
    "connectionId",
    "connectionName",
    "database",
    "environment",
    "allowWrites",
    "contentRevision",
    "authorityRevision",
    "activeLeaseCount",
  ]);
  if (
    !row
    || !uuid(row.connectionId)
    || !safeText(row.connectionName, 120)
    || !safeText(row.database, 256)
    || !nullable(row.environment, (candidate): candidate is string => safeText(candidate, 32))
    || typeof row.allowWrites !== "boolean"
    || !integer(row.contentRevision)
    || !integer(row.authorityRevision)
    || !integer(row.activeLeaseCount, 10_000)
  ) {
    return null;
  }
  return row as NeonBranchConnectionReference;
}

function parseBranch(value: unknown): NeonBranchInventoryItem | null {
  const row = record(value);
  const requiredFields = [
    "id", "projectId", "parentId", "treeParentId", "name", "currentState",
    "pendingState", "stateChangedAt", "createdAt", "updatedAt", "creationSource",
    "initSource", "sourceLsn", "sourceTimestamp", "default", "protected",
    "expiresAt", "restrictedActions", "production", "ready", "depth", "connections",
  ];
  if (
    !row
    || !Object.keys(row).every((key) => (
      [...requiredFields, "managedAccess", "deletion"].includes(key)
    ))
    || requiredFields.some((field) => !Object.prototype.hasOwnProperty.call(row, field))
    || !segment(row.id)
    || !segment(row.projectId)
    || !nullable(row.parentId, segment)
    || !nullable(row.treeParentId, segment)
    || !safeText(row.name, 256)
    || !oneOf(row.currentState, branchStates)
    || !nullable(row.pendingState, (candidate): candidate is typeof branchStates[number] => (
      oneOf(candidate, branchStates)
    ))
    || !instant(row.stateChangedAt)
    || !instant(row.createdAt)
    || !instant(row.updatedAt)
    || !safeText(row.creationSource, 128)
    || !oneOf(row.initSource, ["parent-data", "schema-only", "unknown"] as const)
    || !nullable(row.sourceLsn, (candidate): candidate is string => (
      typeof candidate === "string" && /^[0-9a-f]+\/[0-9a-f]+$/i.test(candidate)
    ))
    || !nullable(row.sourceTimestamp, instant)
    || typeof row.default !== "boolean"
    || typeof row.protected !== "boolean"
    || !nullable(row.expiresAt, instant)
    || (row.production !== "unknown" && typeof row.production !== "boolean")
    || typeof row.ready !== "boolean"
    || !integer(row.depth, 200)
    || !Array.isArray(row.restrictedActions)
    || row.restrictedActions.length > 64
    || !Array.isArray(row.connections)
    || row.connections.length > 200
  ) {
    return null;
  }
  const restrictedActions = row.restrictedActions.map((item) => {
    const action = exact(item, ["name", "reason"]);
    return action && safeText(action.name, 64) && safeText(action.reason, 512)
      ? { name: action.name, reason: action.reason }
      : null;
  });
  const connections = row.connections.map(parseConnection);
  if (restrictedActions.some((item) => item === null) || connections.some((item) => item === null)) {
    return null;
  }
  let managedAccess: NeonBranchInventoryItem["managedAccess"] = null;
  if (row.managedAccess !== undefined) {
    const access = exact(row.managedAccess, ["operationId", "state", "status"]);
    if (
      !access
      || !uuid(access.operationId)
      || !oneOf(access.state, operationStates)
      || !oneOf(access.status, managedAccessStates)
    ) {
      return null;
    }
    managedAccess = access as NeonBranchInventoryItem["managedAccess"];
  }
  let deletion: NeonBranchInventoryItem["deletion"] = null;
  if (row.deletion !== undefined) {
    const capability = exact(row.deletion, ["canPlan", "blockerCodes"]);
    if (
      !capability
      || typeof capability.canPlan !== "boolean"
      || !Array.isArray(capability.blockerCodes)
      || capability.blockerCodes.length > 16
      || !capability.blockerCodes.every((code) => (
        typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(code)
      ))
      || capability.canPlan !== (capability.blockerCodes.length === 0)
    ) {
      return null;
    }
    deletion = capability as NeonBranchInventoryItem["deletion"];
  }
  return {
    ...(row as Omit<
      NeonBranchInventoryItem,
      "restrictedActions" | "connections" | "managedAccess" | "deletion"
    >),
    restrictedActions: restrictedActions as ReadonlyArray<{ name: string; reason: string }>,
    connections: connections as NeonBranchConnectionReference[],
    managedAccess,
    deletion,
  };
}

export function parseNeonBranchInventory(value: unknown): NeonBranchInventory | null {
  const row = exact(value, [
    "projectId",
    "integrationGeneration",
    "observedAt",
    "rootIds",
    "branches",
    "missingTargets",
  ]);
  if (
    !row
    || !segment(row.projectId)
    || typeof row.integrationGeneration !== "string"
    || !/^\d+$/.test(row.integrationGeneration)
    || !instant(row.observedAt)
    || !Array.isArray(row.rootIds)
    || !row.rootIds.every(segment)
    || !Array.isArray(row.branches)
    || row.branches.length > 200
    || !Array.isArray(row.missingTargets)
    || row.missingTargets.length > 200
  ) {
    return null;
  }
  const branches = row.branches.map(parseBranch);
  if (branches.some((branch) => branch === null)) return null;
  return {
    projectId: row.projectId,
    integrationGeneration: row.integrationGeneration,
    observedAt: row.observedAt,
    rootIds: row.rootIds as string[],
    branches: branches as NeonBranchInventoryItem[],
  };
}

export function parseNeonBranchOperations(value: unknown): NeonBranchOperations | null {
  const row = exact(value, ["integrationGeneration", "operations"]);
  if (
    !row
    || typeof row.integrationGeneration !== "string"
    || !/^\d+$/.test(row.integrationGeneration)
    || !Array.isArray(row.operations)
    || row.operations.length > 200
  ) {
    return null;
  }
  const operations = row.operations.map((value) => {
    const operation = exact(value, [
      "id", "state", "planHash", "planExpiresAt", "expired", "risk",
      "approvalPolicy", "requestedByCurrentActor", "canApprove", "canReject",
      "canExecute", "needsCredentialFenceRecovery", "providerOperationId", "branchId", "reconcileAfter",
      "endpointId", "databaseCount", "retiredInheritedRoleCount",
      "managedAccessState", "failureCode", "plan",
    ]);
    const plan = parsePlan(operation?.plan);
    if (
      !operation
      || !uuid(operation.id)
      || !oneOf(operation.state, operationStates)
      || typeof operation.planHash !== "string"
      || !/^[0-9a-f]{64}$/.test(operation.planHash)
      || !instant(operation.planExpiresAt)
      || typeof operation.expired !== "boolean"
      || (operation.risk !== "standard" && operation.risk !== "production_data")
      || (operation.approvalPolicy !== "single_admin"
        && operation.approvalPolicy !== "separate_admin")
      || typeof operation.requestedByCurrentActor !== "boolean"
      || typeof operation.canApprove !== "boolean"
      || typeof operation.canReject !== "boolean"
      || typeof operation.canExecute !== "boolean"
      || typeof operation.needsCredentialFenceRecovery !== "boolean"
      || !nullable(operation.providerOperationId, uuid)
      || !nullable(operation.branchId, segment)
      || !nullable(operation.reconcileAfter, instant)
      || !nullable(operation.endpointId, segment)
      || !nullable(operation.databaseCount, (candidate): candidate is number => integer(candidate, 200))
      || !nullable(
        operation.retiredInheritedRoleCount,
        (candidate): candidate is number => integer(candidate, 200),
      )
      || !nullable(
        operation.managedAccessState,
        (candidate): candidate is NeonManagedAccessState => oneOf(candidate, managedAccessStates),
      )
      || !nullable(operation.failureCode, (candidate): candidate is string => (
        typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(candidate)
      ))
      || !plan
      || plan.operationId !== operation.id
      || plan.integrationGeneration !== row.integrationGeneration
      || plan.risk !== operation.risk
      || plan.approvalPolicy !== operation.approvalPolicy
    ) {
      return null;
    }
    return { ...operation, plan } as NeonBranchOperation;
  });
  return operations.some((operation) => operation === null)
    ? null
    : {
      integrationGeneration: row.integrationGeneration,
      operations: operations as NeonBranchOperation[],
    };
}

export function parseNeonBranchPlanResponse(value: unknown): NeonBranchOperation | null {
  const row = exact(value, ["operation"]);
  const operation = record(row?.operation);
  const plan = record(operation?.plan);
  if (!operation || !plan) return null;
  return parseNeonBranchOperations({
    integrationGeneration: plan.integrationGeneration,
    operations: [{
      id: operation.id,
      state: operation.state,
      planHash: operation.planHash,
      planExpiresAt: operation.planExpiresAt,
      expired: operation.expired,
      risk: operation.risk,
      approvalPolicy: operation.approvalPolicy,
      plan: operation.plan,
      providerOperationId: null,
      branchId: null,
      reconcileAfter: null,
      endpointId: null,
      databaseCount: null,
      retiredInheritedRoleCount: null,
      managedAccessState: null,
      failureCode: null,
      requestedByCurrentActor: true,
      canApprove: operation.state === "awaiting_approval"
        && operation.approvalPolicy === "single_admin",
      canReject: operation.state === "awaiting_approval",
      canExecute: false,
      needsCredentialFenceRecovery: false,
    }],
  })?.operations[0] ?? null;
}
