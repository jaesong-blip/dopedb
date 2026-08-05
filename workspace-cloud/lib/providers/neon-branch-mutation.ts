// Runtime-neutral allowlist contracts for the secret-bearing Neon branch-create
// response. Roles, passwords, connection URIs, and unknown response fields are
// never projected out of this module.

import type { NeonBranchCreatePlan } from "./neon-branch-plan";
import { neonSegment } from "./neon-identifiers";
import { ProviderRequestError } from "./provider-types";

type JsonObject = Record<string, unknown>;

export const NEON_OPERATION_STATUSES = [
  "scheduling",
  "running",
  "finished",
  "failed",
  "error",
  "cancelling",
  "cancelled",
  "skipped",
] as const;

export type NeonOperationStatus = typeof NEON_OPERATION_STATUSES[number];

export type NeonBranchCreateReceipt = Readonly<{
  branchId: string;
  providerOperationId: string | null;
  providerOperationStatus: NeonOperationStatus | null;
  endpointId: string | null;
}>;

export type ParsedNeonBranchOperation = Readonly<{
  id: string;
  branchId: string | null;
  action: string;
  status: NeonOperationStatus;
}>;

export type ParsedNeonBranchEndpoint = Readonly<{
  id: string;
  type: "read_write" | "read_only";
  disabled: boolean;
}>;

function invalid(message: string): never {
  throw new ProviderRequestError("neon", message, 502);
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Neon returned an invalid branch mutation response");
  }
  return value as JsonObject;
}

function requiredString(value: unknown, field: string) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 2_048
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)
  ) {
    return invalid(`Neon response omitted ${field}`);
  }
  return value;
}

function responseUuid(value: unknown, field: string) {
  const id = requiredString(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(id)) {
    return invalid(`Neon returned an invalid ${field}`);
  }
  return id;
}

function operationStatus(value: unknown): NeonOperationStatus {
  if (
    typeof value !== "string"
    || !NEON_OPERATION_STATUSES.includes(value as NeonOperationStatus)
  ) {
    return invalid("Neon returned an invalid operation status");
  }
  return value as NeonOperationStatus;
}

export function parseNeonBranchOperation(
  value: unknown,
  projectId: string,
  branchId: string,
): ParsedNeonBranchOperation {
  const row = object(value);
  const operationProject = requiredString(row.project_id, "operation project id");
  const operationBranch = row.branch_id === undefined || row.branch_id === null
    ? null
    : requiredString(row.branch_id, "operation branch id");
  const action = requiredString(row.action, "operation action");
  if (
    operationProject !== projectId
    || (operationBranch !== null && operationBranch !== branchId)
    || action.length > 128
    || !/^[a-z][a-z0-9_]{0,127}$/.test(action)
  ) {
    return invalid("Neon returned an invalid branch operation");
  }
  return {
    id: responseUuid(row.id, "operation id"),
    branchId: operationBranch,
    action,
    status: operationStatus(row.status),
  };
}

export function parseNeonBranchEndpoints(
  value: unknown,
  branchId: string,
): readonly ParsedNeonBranchEndpoint[] {
  const values = Array.isArray(value) ? value : [];
  if (values.length > 16) return invalid("Neon returned too many branch endpoints");
  const seen = new Set<string>();
  return values.map((endpointValue) => {
    const endpoint = object(endpointValue);
    const id = requiredString(endpoint.id, "endpoint id");
    const type = requiredString(endpoint.type, "endpoint type");
    if (
      !neonSegment(id)
      || (type !== "read_write" && type !== "read_only")
      || (endpoint.branch_id !== undefined && endpoint.branch_id !== branchId)
      || (endpoint.disabled !== undefined && typeof endpoint.disabled !== "boolean")
      || seen.has(id)
    ) {
      return invalid("Neon returned an invalid branch endpoint");
    }
    seen.add(id);
    return {
      id,
      type,
      disabled: endpoint.disabled === true,
    };
  });
}

export function parseNeonBranchAnnotation(
  value: unknown,
  branchId: string,
): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const annotation = value as JsonObject;
  const annotationObject = object(annotation.object);
  if (annotationObject.id !== branchId) return null;
  const properties = object(annotation.value);
  const entries = Object.entries(properties);
  if (entries.length > 50) return invalid("Neon returned invalid branch annotations");
  const parsed: Record<string, string> = {};
  for (const [key, property] of entries) {
    if (
      key.length < 1
      || key.length > 256
      || /[\u0000-\u001f\u007f]/.test(key)
      || typeof property !== "string"
      || property.length > 2_048
      || /[\u0000-\u001f\u007f]/.test(property)
    ) {
      return invalid("Neon returned invalid branch annotations");
    }
    parsed[key] = property;
  }
  return parsed;
}

export function neonBranchMutationBody(input: {
  plan: NeonBranchCreatePlan;
  planHash: string;
  ownershipMarker: string;
}) {
  if (
    !/^[0-9a-f]{64}$/.test(input.planHash)
    || !/^v1\.[A-Za-z0-9_-]{43}$/.test(input.ownershipMarker)
  ) {
    throw new ProviderRequestError("neon", "Invalid Neon branch mutation identity", 400);
  }
  const branch: Record<string, string | boolean> = {
    parent_id: input.plan.source.branchId,
    name: input.plan.target.name,
    init_source: input.plan.target.initSource,
    protected: false,
  };
  if (input.plan.source.point.kind === "lsn") {
    branch.parent_lsn = input.plan.source.point.value;
  } else if (input.plan.source.point.kind === "timestamp") {
    branch.parent_timestamp = input.plan.source.point.value;
  }
  return {
    branch,
    ...(input.plan.target.endpoint === "read_write"
      ? { endpoints: [{ type: "read_write" as const }] }
      : {}),
    annotation_value: {
      "dopedb-operation-id": input.plan.operationId,
      "dopedb-plan-hash": input.planHash,
      "dopedb-ownership": input.ownershipMarker,
    },
  };
}

export function parseNeonBranchCreateReceipt(
  value: unknown,
  plan: NeonBranchCreatePlan,
): NeonBranchCreateReceipt {
  const body = object(value);
  const branch = object(body.branch);
  const branchId = requiredString(branch.id, "branch id");
  if (
    !neonSegment(branchId)
    || branch.project_id !== plan.source.projectId
    || branch.name !== plan.target.name
  ) {
    return invalid("Neon returned an invalid created branch");
  }
  const operationValues = Array.isArray(body.operations) ? body.operations : [];
  if (operationValues.length > 64) {
    return invalid("Neon returned too many branch operations");
  }
  const seenOperations = new Set<string>();
  const operations = operationValues.map((operation) => {
    const parsed = parseNeonBranchOperation(operation, plan.source.projectId, branchId);
    if (seenOperations.has(parsed.id)) return invalid("Neon repeated a branch operation");
    seenOperations.add(parsed.id);
    return parsed;
  });
  const primary = operations.find((operation) => (
    operation.branchId === branchId
    && ["create_branch", "create_timeline", "apply_schema_from_branch"]
      .includes(operation.action)
  )) ?? operations.find((operation) => operation.branchId === branchId) ?? null;

  const endpoints = parseNeonBranchEndpoints(body.endpoints, branchId);
  const endpoint = endpoints.find((item) => item.type === "read_write") ?? null;
  if (
    (plan.target.endpoint === "none" && endpoints.length !== 0)
    || (plan.target.endpoint === "read_write"
      && (endpoints.length !== 1 || endpoint === null))
  ) {
    return invalid("Neon created an unexpected endpoint set");
  }
  return {
    branchId,
    providerOperationId: primary?.id ?? null,
    providerOperationStatus: primary?.status ?? null,
    endpointId: endpoint?.id ?? null,
  };
}
