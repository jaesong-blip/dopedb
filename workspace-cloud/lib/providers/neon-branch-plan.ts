// Runtime-neutral, secret-free planning contract for one Neon branch create.
// The route supplies live inventory and authority; durable storage and Provider
// I/O remain server-only.

import type {
  NeonBranchInventory,
  NeonBranchInventoryItem,
} from "./neon-branches";
import { neonSegment } from "./neon-identifiers";

const PLAN_VERSION = 1 as const;
export const NEON_BRANCH_PLAN_TTL_MS = 10 * 60 * 1_000;

export type NeonBranchSourcePoint =
  | Readonly<{ kind: "head" }>
  | Readonly<{ kind: "lsn"; value: string }>
  | Readonly<{ kind: "timestamp"; value: string }>;

export type NeonBranchCreatePlanRequest = Readonly<{
  idempotencyKey: string;
  projectId: string;
  sourceBranchId: string;
  targetName: string;
  initSource: "parent-data" | "schema-only";
  sourcePoint: NeonBranchSourcePoint;
  endpoint: "none" | "read_write";
  sourceEnvironment: "development" | "production";
}>;

export type NeonBranchCreatePlan = Readonly<{
  version: typeof PLAN_VERSION;
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
    currentState: NeonBranchInventoryItem["currentState"];
    pendingState: NeonBranchInventoryItem["pendingState"];
    stateChangedAt: string;
    updatedAt: string;
    default: boolean;
    protected: boolean;
    environment: "development" | "production";
    point: NeonBranchSourcePoint;
    restrictedActions: NeonBranchInventoryItem["restrictedActions"];
  }>;
  target: Readonly<{
    name: string;
    initSource: "parent-data" | "schema-only";
    endpoint: "none" | "read_write";
    protected: false;
    expiresAt: null;
    copiesData: boolean;
    createsCompute: boolean;
  }>;
  risk: "standard" | "production_data";
  approvalPolicy: "single_admin" | "separate_admin";
  warningCodes: readonly string[];
}>;

export class NeonBranchPlanError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 500) {
    super(message);
    this.name = "NeonBranchPlanError";
  }
}

function invalid(message: string, status: 400 | 409 | 500 = 400): never {
  throw new NeonBranchPlanError(message, status);
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

function branchName(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 256
    && value.trim() === value
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);
}

function sourcePoint(value: unknown): NeonBranchSourcePoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value as Record<string, unknown>;
  if (point.kind === "head" && Object.keys(point).length === 1) {
    return { kind: "head" };
  }
  if (
    (point.kind === "lsn" || point.kind === "timestamp")
    && Object.keys(point).length === 2
    && Object.prototype.hasOwnProperty.call(point, "value")
    && typeof point.value === "string"
    && point.value.length > 0
    && point.value.length <= 64
  ) {
    if (point.kind === "lsn" && /^[0-9a-f]+\/[0-9a-f]+$/i.test(point.value)) {
      return { kind: "lsn", value: point.value };
    }
    if (
      point.kind === "timestamp"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(point.value)
      && !Number.isNaN(Date.parse(point.value))
    ) {
      return { kind: "timestamp", value: point.value };
    }
  }
  return null;
}

export function parseNeonBranchCreatePlanRequest(
  value: unknown,
): NeonBranchCreatePlanRequest {
  const request = exactRecord(value, [
    "idempotencyKey",
    "projectId",
    "sourceBranchId",
    "targetName",
    "initSource",
    "sourcePoint",
    "endpoint",
    "sourceEnvironment",
  ]);
  const point = request ? sourcePoint(request.sourcePoint) : null;
  if (
    !request
    || !uuid(request.idempotencyKey)
    || !neonSegment(request.projectId)
    || !neonSegment(request.sourceBranchId)
    || !branchName(request.targetName)
    || (request.initSource !== "parent-data" && request.initSource !== "schema-only")
    || !point
    || (request.endpoint !== "none" && request.endpoint !== "read_write")
    || (request.sourceEnvironment !== "development"
      && request.sourceEnvironment !== "production")
  ) {
    return invalid("Invalid Neon branch create plan request");
  }
  return {
    idempotencyKey: request.idempotencyKey,
    projectId: request.projectId,
    sourceBranchId: request.sourceBranchId,
    targetName: request.targetName,
    initSource: request.initSource,
    sourcePoint: point,
    endpoint: request.endpoint,
    sourceEnvironment: request.sourceEnvironment,
  };
}

export function buildNeonBranchCreatePlan(input: {
  request: NeonBranchCreatePlanRequest;
  inventory: NeonBranchInventory;
  operationId: string;
  integrationId: string;
  integrationGeneration: bigint;
  workspaceProductionReference: boolean;
  now: Date;
}): NeonBranchCreatePlan {
  if (
    !uuid(input.operationId)
    || !uuid(input.integrationId)
    || input.integrationGeneration < 1n
    || input.inventory.projectId !== input.request.projectId
    || Number.isNaN(input.now.valueOf())
  ) {
    return invalid("Invalid Neon branch create plan context", 500);
  }
  const sources = input.inventory.branches.filter(
    (branch) => branch.id === input.request.sourceBranchId,
  );
  const source = sources.length === 1 ? sources[0] : null;
  if (
    !source
    || source.currentState !== "ready"
    || source.pendingState !== null
    || !source.ready
  ) {
    return invalid("Neon source branch is not ready", 409);
  }
  if (input.inventory.branches.some((branch) => branch.name === input.request.targetName)) {
    return invalid("Neon target branch name is already in use", 409);
  }
  const knownProduction = source.protected || input.workspaceProductionReference;
  if (knownProduction && input.request.sourceEnvironment !== "production") {
    return invalid("Neon production source cannot be downgraded", 409);
  }
  if (input.request.sourcePoint.kind === "timestamp") {
    const timestamp = Date.parse(input.request.sourcePoint.value);
    if (
      timestamp < Date.parse(source.createdAt)
      || timestamp > input.now.valueOf() + 30_000
    ) {
      return invalid("Neon source timestamp is outside the branch lifetime", 409);
    }
  }

  const copiesData = input.request.initSource === "parent-data";
  const productionData = copiesData
    && input.request.sourceEnvironment === "production";
  const warningCodes: string[] = [];
  if (productionData) warningCodes.push("NEON_PRODUCTION_DATA_COPY");
  if (source.protected) warningCodes.push("NEON_PROTECTED_PARENT_CREDENTIALS_ROTATE");
  if (!copiesData) warningCodes.push("NEON_SCHEMA_ONLY_HAS_NO_DATA");
  if (input.request.endpoint === "read_write") {
    warningCodes.push("NEON_ENDPOINT_CREATES_COMPUTE");
  }
  if (input.request.sourcePoint.kind === "head") {
    warningCodes.push("NEON_HEAD_RESOLVED_AT_EXECUTION");
  }

  const issuedAt = new Date(input.now.valueOf());
  const expiresAt = new Date(input.now.valueOf() + NEON_BRANCH_PLAN_TTL_MS);
  return {
    version: PLAN_VERSION,
    kind: "neon.branch.create",
    operationId: input.operationId,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration.toString(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    source: {
      projectId: source.projectId,
      branchId: source.id,
      name: source.name,
      currentState: source.currentState,
      pendingState: source.pendingState,
      stateChangedAt: source.stateChangedAt,
      updatedAt: source.updatedAt,
      default: source.default,
      protected: source.protected,
      environment: input.request.sourceEnvironment,
      point: input.request.sourcePoint,
      restrictedActions: source.restrictedActions.map((action) => ({ ...action })),
    },
    target: {
      name: input.request.targetName,
      initSource: input.request.initSource,
      endpoint: input.request.endpoint,
      protected: false,
      expiresAt: null,
      copiesData,
      createsCompute: input.request.endpoint === "read_write",
    },
    risk: productionData ? "production_data" : "standard",
    approvalPolicy: productionData ? "separate_admin" : "single_admin",
    warningCodes,
  };
}
