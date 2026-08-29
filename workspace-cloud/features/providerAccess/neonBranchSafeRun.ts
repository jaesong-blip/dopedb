import type {
  NeonBranchInventory,
  NeonBranchOperation,
  NeonSafeRun,
} from "./neonBranches";

export function neonOperationProjectId(operation: NeonBranchOperation) {
  if (operation.plan.kind === "neon.branch.delete") {
    return operation.plan.target.projectId;
  }
  return operation.plan.source.projectId;
}

function operationTime(operation: NeonBranchOperation) {
  return Date.parse(operation.plan.issuedAt);
}

/** Projects one real, auditable safe-run journey from durable Provider state. */
export function deriveNeonSafeRun(
  inventory: NeonBranchInventory,
  operations: readonly NeonBranchOperation[],
): NeonSafeRun | null {
  const candidate = operations
    .filter((operation) => (
      operation.plan.kind === "neon.branch.create"
      && operation.plan.source.projectId === inventory.projectId
      && operation.plan.target.endpoint === "read_write"
      && operation.state !== "cancelled"
    ))
    .sort((left, right) => (
      operationTime(right) - operationTime(left)
      || right.id.localeCompare(left.id)
    ))[0];
  if (!candidate || candidate.plan.kind !== "neon.branch.create") return null;
  const createOperation = candidate as NeonSafeRun["createOperation"];
  const branchId = createOperation.branchId;
  const branch = branchId
    ? inventory.branches.find((item) => item.id === branchId) ?? null
    : null;
  const sourceBranch = inventory.branches.find(
    (item) => item.id === createOperation.plan.source.branchId,
  ) ?? null;
  const base = {
    createOperation,
    branch,
    sourceBranch,
    activeConnection: null,
    switchedConnectionId: null,
    switchedFromSource: false,
  } satisfies Omit<NeonSafeRun, "phase">;

  if (branchId) {
    const deletion = operations.find((operation) => (
      operation.plan.kind === "neon.branch.delete"
      && operation.state === "succeeded"
      && operation.plan.target.projectId === inventory.projectId
      && operation.plan.target.branchId === branchId
      && operationTime(operation) >= operationTime(createOperation)
    ));
    if (deletion && !branch) return { ...base, phase: "discarded" };
  }
  if (createOperation.state !== "succeeded") {
    return {
      ...base,
      phase: createOperation.state === "failed"
        || createOperation.state === "needs_repair"
        ? "needs_attention"
        : "checkpointing",
    };
  }
  if (!branchId || !branch || !sourceBranch) {
    return { ...base, phase: "needs_attention" };
  }

  const successfulSwitches = operations
    .filter((operation) => (
      operation.plan.kind === "neon.branch.switch"
      && operation.state === "succeeded"
      && operation.plan.source.projectId === inventory.projectId
      && operationTime(operation) >= operationTime(createOperation)
      && (
        operation.plan.source.branchId === branchId
        || operation.plan.target.branchId === branchId
      )
    ))
    .sort((left, right) => (
      operationTime(right) - operationTime(left)
      || right.id.localeCompare(left.id)
    ));
  const latestSwitch = successfulSwitches[0];
  const switchedConnectionId = latestSwitch?.plan.kind === "neon.branch.switch"
    ? latestSwitch.plan.source.connectionId
    : null;
  const activeConnection = switchedConnectionId
    ? branch.connections.find((connection) => (
      connection.connectionId === switchedConnectionId
    )) ?? null
    : branch.connections[0] ?? null;
  const switchedFromSource = successfulSwitches.some((operation) => (
    operation.plan.kind === "neon.branch.switch"
    && operation.plan.source.branchId === sourceBranch.id
    && operation.plan.target.branchId === branch.id
    && operation.plan.source.connectionId === switchedConnectionId
  ));
  const enriched = {
    ...base,
    activeConnection,
    switchedConnectionId,
    switchedFromSource,
  };

  if (activeConnection) return { ...enriched, phase: "isolated_active" };
  const returnedConnectionId = latestSwitch?.plan.kind === "neon.branch.switch"
    && latestSwitch.plan.source.branchId === branch.id
    && latestSwitch.plan.target.branchId !== branch.id
    ? latestSwitch.plan.source.connectionId
    : null;
  if (
    returnedConnectionId
    && sourceBranch.connections.some((connection) => (
      connection.connectionId === returnedConnectionId
    ))
  ) {
    return { ...enriched, phase: "ready_to_discard" };
  }
  if (
    createOperation.managedAccessState === "bootstrap_required"
    || createOperation.managedAccessState === "not_requested"
    || createOperation.managedAccessState === "waiting_for_provider"
  ) {
    return { ...enriched, phase: "access_required" };
  }
  if (createOperation.managedAccessState === "ready") {
    return { ...enriched, phase: "ready_to_isolate" };
  }
  return { ...enriched, phase: "needs_attention" };
}
