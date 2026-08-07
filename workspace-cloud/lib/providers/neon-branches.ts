// Pure allowlist projection for Neon branch inventory. The control-plane
// adapter owns transport and pagination; this module owns the redacted tree
// contract shared by the API route and critical regression suite.

import { neonSegment } from "./neon-identifiers";
import {
  ProviderRequestError,
  type ProviderProductionClassification,
} from "./provider-types";

type JsonObject = Record<string, unknown>;

const knownStates = ["init", "resetting", "ready", "archived"] as const;
const knownInitSources = ["parent-data", "schema-only"] as const;
const MAX_RESTRICTED_ACTIONS = 64;

export type NeonBranchState = typeof knownStates[number] | "unknown";
export type NeonBranchInitSource = typeof knownInitSources[number] | "unknown";

export type NeonBranchRestrictedAction = Readonly<{
  name: string;
  reason: string;
}>;

export type NeonBranchInventoryItem = Readonly<{
  id: string;
  projectId: string;
  // The source branch Neon reported. For schema-only branches this is
  // provenance, not a tree relationship.
  parentId: string | null;
  treeParentId: string | null;
  name: string;
  currentState: NeonBranchState;
  pendingState: NeonBranchState | null;
  stateChangedAt: string;
  createdAt: string;
  updatedAt: string;
  creationSource: string;
  initSource: NeonBranchInitSource;
  sourceLsn: string | null;
  sourceTimestamp: string | null;
  default: boolean;
  protected: boolean;
  expiresAt: string | null;
  restrictedActions: readonly NeonBranchRestrictedAction[];
  production: ProviderProductionClassification;
  ready: boolean;
  depth: number;
}>;

export type NeonBranchInventory = Readonly<{
  projectId: string;
  rootIds: readonly string[];
  branches: readonly NeonBranchInventoryItem[];
}>;

/**
 * Archived branches remain queryable and wake on access, but they are not
 * mutation-ready. Keep this separate from `branch.ready`, which protects
 * branch lifecycle operations that require Neon's exact `ready` state.
 */
export function neonBranchQueryable(
  branch: Pick<NeonBranchInventoryItem, "currentState">,
) {
  return branch.currentState === "ready" || branch.currentState === "archived";
}

function invalid(message = "Neon returned an invalid branch inventory"): never {
  throw new ProviderRequestError("neon", message, 502);
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as JsonObject;
}

function safeText(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)
  ) {
    return invalid();
  }
  return value;
}

function safeLine(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || /[\u202a-\u202e\u2066-\u2069]/.test(value)) {
    return invalid();
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return safeText(normalized, maxLength);
}

function optionalSegment(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!neonSegment(value)) return invalid();
  return value;
}

function instant(value: unknown, optional = false): string | null {
  if (optional && (value === undefined || value === null || value === "")) {
    return null;
  }
  const text = safeText(value, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)
    || Number.isNaN(Date.parse(text))
  ) {
    return invalid();
  }
  return text;
}

function optionalLsn(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = safeText(value, 64);
  if (!/^[0-9a-f]+\/[0-9a-f]+$/i.test(text)) return invalid();
  return text;
}

function state(value: unknown, optional = false): NeonBranchState | null {
  if (optional && (value === undefined || value === null || value === "")) {
    return null;
  }
  const text = safeText(value, 64);
  return knownStates.includes(text as typeof knownStates[number])
    ? text as typeof knownStates[number]
    : "unknown";
}

function initSource(value: unknown): NeonBranchInitSource {
  if (value === undefined || value === null || value === "") return "unknown";
  const text = safeText(value, 64);
  return knownInitSources.includes(text as typeof knownInitSources[number])
    ? text as typeof knownInitSources[number]
    : "unknown";
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

function restrictedActions(value: unknown): readonly NeonBranchRestrictedAction[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_RESTRICTED_ACTIONS) return invalid();
  const seen = new Set<string>();
  return value.map((candidate) => {
    const row = object(candidate);
    const name = safeText(row.name, 64);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name) || seen.has(name)) {
      return invalid();
    }
    seen.add(name);
    return {
      name,
      reason: safeLine(row.reason, 512),
    };
  }).sort((left, right) => (
    left.name < right.name ? -1 : left.name === right.name ? 0 : 1
  ));
}

function branchOrder(
  left: Omit<NeonBranchInventoryItem, "depth">,
  right: Omit<NeonBranchInventoryItem, "depth">,
) {
  if (left.default !== right.default) return left.default ? -1 : 1;
  if (left.protected !== right.protected) return left.protected ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return left.id < right.id ? -1 : left.id === right.id ? 0 : 1;
}

/**
 * Validates every page result as one complete project tree. It never returns a
 * partial tree: duplicate IDs, cross-project rows, missing structural parents,
 * and cycles all fail closed before identifiers reach a browser.
 */
export function parseNeonBranchInventory(
  projectId: string,
  values: readonly unknown[],
): NeonBranchInventory {
  if (!neonSegment(projectId)) return invalid();
  const byId = new Map<string, Omit<NeonBranchInventoryItem, "depth">>();

  for (const value of values) {
    const row = object(value);
    if (!neonSegment(row.id) || row.project_id !== projectId || byId.has(row.id)) {
      return invalid();
    }
    const id = row.id;
    const parentId = optionalSegment(row.parent_id);
    const branchInitSource = initSource(row.init_source);
    const currentState = state(row.current_state);
    if (currentState === null) return invalid();
    const isDefault = requiredBoolean(row.default);
    const isProtected = requiredBoolean(row.protected);
    byId.set(id, {
      id,
      projectId,
      parentId,
      treeParentId: branchInitSource === "schema-only" ? null : parentId,
      name: safeText(row.name, 256),
      currentState,
      pendingState: state(row.pending_state, true),
      stateChangedAt: instant(row.state_changed_at) ?? invalid(),
      createdAt: instant(row.created_at) ?? invalid(),
      updatedAt: instant(row.updated_at) ?? invalid(),
      creationSource: safeText(row.creation_source, 128),
      initSource: branchInitSource,
      sourceLsn: optionalLsn(row.parent_lsn),
      sourceTimestamp: instant(row.parent_timestamp, true),
      default: isDefault,
      protected: isProtected,
      expiresAt: instant(row.expires_at, true),
      restrictedActions: restrictedActions(row.restricted_actions),
      production: isProtected ? true : isDefault ? "unknown" : false,
      ready: currentState === "ready",
    });
  }

  const children = new Map<string, Array<Omit<NeonBranchInventoryItem, "depth">>>();
  const roots: Array<Omit<NeonBranchInventoryItem, "depth">> = [];
  for (const branch of byId.values()) {
    if (branch.treeParentId === null) {
      roots.push(branch);
      continue;
    }
    if (branch.treeParentId === branch.id || !byId.has(branch.treeParentId)) {
      return invalid("Neon branch hierarchy is inconsistent");
    }
    const siblings = children.get(branch.treeParentId) ?? [];
    siblings.push(branch);
    children.set(branch.treeParentId, siblings);
  }
  roots.sort(branchOrder);
  for (const siblings of children.values()) siblings.sort(branchOrder);

  const ordered: NeonBranchInventoryItem[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (
    branch: Omit<NeonBranchInventoryItem, "depth">,
    depth: number,
  ) => {
    if (visiting.has(branch.id)) return invalid("Neon branch hierarchy contains a cycle");
    if (visited.has(branch.id)) return;
    visiting.add(branch.id);
    ordered.push({ ...branch, depth });
    for (const child of children.get(branch.id) ?? []) visit(child, depth + 1);
    visiting.delete(branch.id);
    visited.add(branch.id);
  };
  for (const root of roots) visit(root, 0);
  if (ordered.length !== byId.size) {
    return invalid("Neon branch hierarchy contains a cycle");
  }
  return {
    projectId,
    rootIds: roots.map((root) => root.id),
    branches: ordered,
  };
}
