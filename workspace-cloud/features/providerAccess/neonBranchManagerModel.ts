// View-model helpers derive Neon branch targets and localized operation states.
import type { Integration, ManagedConnection } from "./domain";
import {
  neonOperationProjectId,
  type NeonBranchInventoryItem,
  type NeonBranchOperation,
  type NeonBranchOperations,
  type NeonBranchOperationState,
  type NeonSafeRunPhase,
} from "./neonBranches";
import type { WorkspaceLocale } from "../../lib/workspace-locale";
import { workspaceMessages } from "../../lib/workspace-messages";
import { localizedIntegrationDisplayName } from "../../lib/workspace-provider-copy";

export type ProjectTarget = Readonly<{
  integration: Integration;
  projectId: string;
}>;

export type SourcePointKind = "head" | "timestamp" | "lsn";

export function projectTargets(
  integrations: readonly Integration[],
  managedConnections: readonly ManagedConnection[],
  operationCatalog: Readonly<Record<string, NeonBranchOperations>>,
  locale: WorkspaceLocale,
) {
  const byId = new Map(integrations.map((integration) => [integration.id, integration]));
  const seen = new Set<string>();
  const targets: ProjectTarget[] = [];
  const add = (integration: Integration | undefined, projectId: string | undefined) => {
    const key = `${integration?.id}:${projectId}`;
    if (
      !integration
      || integration.provider !== "neon"
      || integration.status !== "active"
      || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(projectId ?? "")
      || seen.has(key)
    ) {
      return;
    }
    seen.add(key);
    targets.push({ integration, projectId: projectId! });
  };
  for (const connection of managedConnections) {
    if (connection.provider !== "neon") continue;
    add(byId.get(connection.integrationId), connection.resource.project);
  }
  for (const [integrationId, catalog] of Object.entries(operationCatalog)) {
    const integration = byId.get(integrationId);
    for (const operation of catalog.operations) {
      add(integration, neonOperationProjectId(operation));
    }
  }
  return targets.sort((left, right) => (
    localizedIntegrationDisplayName(left.integration.displayName, locale).localeCompare(
      localizedIntegrationDisplayName(right.integration.displayName, locale),
      locale,
    )
    || left.projectId.localeCompare(right.projectId)
  ));
}

export function operationLabel(operation: NeonBranchOperation, locale: WorkspaceLocale) {
  const copy = workspaceMessages[locale].neonBranches.operation;
  const state = operation.state;
  if (state === "awaiting_approval") return copy.awaitingApproval;
  if (state === "approved") return copy.ready;
  if (state === "claimed" || state === "remote_started") {
    if (operation.plan.kind === "neon.branch.delete") return copy.deleteStarted;
    return operation.plan.kind === "neon.branch.switch"
      ? copy.switchStarted
      : copy.createStarted;
  }
  if (state === "reconciling") return copy.reconciling;
  if (state === "succeeded") {
    if (operation.plan.kind === "neon.branch.delete") return copy.deleteComplete;
    return operation.plan.kind === "neon.branch.switch"
      ? copy.switchComplete
      : copy.createComplete;
  }
  if (state === "needs_repair") return copy.repairRequired;
  if (state === "failed") return copy.failed;
  return copy.cancelled;
}

export function operationTone(state: NeonBranchOperationState) {
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "needs_repair") return "danger";
  if (state === "cancelled") return "neutral";
  return "warning";
}

export function warningLabel(code: string, locale: WorkspaceLocale) {
  const copy = workspaceMessages[locale].neonBranches.warnings;
  if (code === "NEON_PRODUCTION_DATA_COPY") return copy.productionCopy;
  if (code === "NEON_PROTECTED_PARENT_CREDENTIALS_ROTATE") {
    return copy.protectedCredentials;
  }
  if (code === "NEON_SCHEMA_ONLY_HAS_NO_DATA") return copy.schemaOnly;
  if (code === "NEON_ENDPOINT_CREATES_COMPUTE") return copy.endpointCompute;
  if (code === "NEON_INHERITED_DOPEDB_CREDENTIALS_RETIRED") {
    return copy.inheritedCredentials;
  }
  if (code === "NEON_HEAD_RESOLVED_AT_EXECUTION") return copy.executionHead;
  if (code === "NEON_BRANCH_CONNECTIONS_TERMINATE") {
    return copy.connectionsTerminate;
  }
  if (code === "NEON_SOFT_DELETE_RECOVERY_NOT_GUARANTEED") {
    return copy.recoveryNotGuaranteed;
  }
  if (code === "NEON_CONNECTION_TARGET_CHANGES") {
    return copy.targetChanges;
  }
  if (code === "NEON_ACTIVE_ACCESS_REVOKED") {
    return copy.accessRevoked;
  }
  if (code === "NEON_PRODUCTION_TARGET_SWITCH") {
    return copy.productionSwitch;
  }
  return code;
}

export function deletionBlockerLabel(code: string, locale: WorkspaceLocale) {
  const copy = workspaceMessages[locale].neonBranches.blockers;
  if (code === "CREATE_OPERATION_INCOMPLETE") return copy.createIncomplete;
  if (code === "BRANCH_NOT_READY") return copy.branchNotReady;
  if (code === "ROOT_BRANCH") return copy.rootBranch;
  if (code === "DEFAULT_BRANCH") return copy.defaultBranch;
  if (code === "PROTECTED_BRANCH") return copy.protectedBranch;
  if (code === "CHILD_BRANCHES") return copy.childBranches;
  if (code === "WORKSPACE_CONNECTIONS") return copy.workspaceConnections;
  if (code === "ACTIVE_LEASES") return copy.activeLeases;
  if (code === "PROVIDER_RESTRICTED") return copy.providerRestricted;
  return code;
}

export function branchEnvironment(
  branch: NeonBranchInventoryItem | null,
): "" | "development" | "production" {
  if (!branch) return "";
  if (
    branch.protected
    || branch.production === true
    || branch.connections.some((connection) => connection.environment === "production")
  ) {
    return "production";
  }
  return branch.production === false ? "development" : "";
}

export function operationBusy(operation: NeonBranchOperation) {
  return operation.state === "claimed"
    || operation.state === "remote_started"
    || operation.state === "reconciling";
}

export function operationCatalogFingerprint(catalog: NeonBranchOperations | undefined) {
  if (!catalog) return "";
  return `${catalog.integrationGeneration}|${catalog.operations.map((operation) => (
    `${operation.id}:${operation.state}:${operation.branchId ?? ""}:`
    + `${operation.managedAccessState ?? ""}:${operation.planHash}`
  )).join("|")}`;
}

export function safeRunPhaseLabel(phase: NeonSafeRunPhase, locale: WorkspaceLocale) {
  const copy = workspaceMessages[locale].neonBranches.safeRun.phase;
  if (phase === "checkpointing") return copy.checkpointing;
  if (phase === "access_required") return copy.accessRequired;
  if (phase === "ready_to_isolate") return copy.readyToIsolate;
  if (phase === "isolated_active") return copy.isolatedActive;
  if (phase === "ready_to_discard") return copy.readyToDiscard;
  if (phase === "discarded") return copy.discarded;
  return copy.attention;
}

export function safeRunPhaseDescription(phase: NeonSafeRunPhase, locale: WorkspaceLocale) {
  const copy = workspaceMessages[locale].neonBranches.safeRun.description;
  if (phase === "checkpointing") {
    return copy.checkpointing;
  }
  if (phase === "access_required") {
    return copy.accessRequired;
  }
  if (phase === "ready_to_isolate") {
    return copy.readyToIsolate;
  }
  if (phase === "isolated_active") {
    return copy.isolatedActive;
  }
  if (phase === "ready_to_discard") {
    return copy.readyToDiscard;
  }
  if (phase === "discarded") {
    return copy.discarded;
  }
  return copy.attention;
}

export function safeRunStepState(phase: NeonSafeRunPhase, step: number) {
  const checkpointComplete = phase !== "checkpointing" && phase !== "needs_attention";
  const isolated = phase === "isolated_active"
    || phase === "ready_to_discard"
    || phase === "discarded";
  const inspected = phase === "ready_to_discard" || phase === "discarded";
  if (step === 1) return checkpointComplete ? "complete" : "active";
  if (step === 2) return isolated ? "complete" : checkpointComplete ? "active" : "pending";
  if (step === 3) return inspected ? "complete" : phase === "isolated_active" ? "active" : "pending";
  return phase === "discarded" ? "complete" : phase === "ready_to_discard" ? "active" : "pending";
}
