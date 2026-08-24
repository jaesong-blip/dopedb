// Runtime-neutral validation for Analysis Article runs and bounded shared
// result fragments. Plaintext fragments are accepted only at the completion
// boundary and are encrypted before persistence.

import type {
  AnalysisArticleDefinition,
  AnalysisColumn,
  AnalysisParameterValue,
} from "./workspace-analysis-articles";
import { canonicalHash } from "./workspace-versioning";

export const analysisRunStates = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "stale",
] as const;

export type AnalysisRunState = (typeof analysisRunStates)[number];

export type AnalysisRunRequest = Readonly<{
  id: string;
  articleRevision: number;
  runnerId: string;
  trigger: "manual" | "schedule" | "signal" | "publication";
  parameterValues: Readonly<Record<string, AnalysisParameterValue>>;
}>;

export type AnalysisQueryReceiptInput = Readonly<{
  queryNodeId: string;
  connectionId: string;
  connectionRevision: number;
  queryRunId: string;
  queryHash: string;
  schemaFingerprint: string;
  state: "succeeded" | "failed" | "cancelled" | "stale";
  rowCount: number;
  byteCount: number;
  durationMs: number;
}>;

export type AnalysisResultFragmentPayload = Readonly<{
  version: 1;
  blockId: string;
  ordinal: number;
  columns: readonly AnalysisColumn[];
  rows: readonly (readonly (string | number | boolean | null)[])[];
  truncated: boolean;
}>;

export type AnalysisResultFragmentReference = Readonly<{
  blockId: string;
  ordinal: number;
  payloadHash: string;
}>;

export type AnalysisRunCompletion = Readonly<{
  state: "succeeded" | "failed" | "cancelled" | "stale";
  queryReceipts: readonly AnalysisQueryReceiptInput[];
  fragmentManifest: readonly AnalysisResultFragmentReference[];
  /** Temporary rolling-deploy input. New callers always stage and send a manifest. */
  inlineFragments: readonly AnalysisResultFragmentPayload[];
  error: Readonly<{ kind: string; message: string }> | null;
}>;

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Hashes the durable result evidence in a transport-order-independent form so a
 * later read can prove that every staged fragment is still present.
 */
export function analysisRunResultHash(
  receipts: readonly AnalysisQueryReceiptInput[],
  fragments: readonly AnalysisResultFragmentReference[],
) {
  return canonicalHash({
    receipts: [...receipts].sort((left, right) => compareIds(left.queryNodeId, right.queryNodeId)),
    fragments: [...fragments].sort((left, right) => compareIds(left.blockId, right.blockId)
      || left.ordinal - right.ordinal),
  });
}

/**
 * Proves that an unexpired stored fragment set is exactly the one committed by
 * the runner. Callers deliberately pass only rows whose retention deadline is
 * still in the future, so removing or expiring even one fragment invalidates
 * the manifest hash instead of returning a misleading partial result.
 */
export function analysisRunEvidenceIsComplete(input: Readonly<{
  resultHash: string | null;
  rowCount: number;
  byteCount: number;
  receipts: readonly AnalysisQueryReceiptInput[];
  fragments: readonly (AnalysisResultFragmentReference & Readonly<{
    plaintextBytes: number;
  }>)[];
}>) {
  return input.resultHash !== null
    && input.resultHash === analysisRunResultHash(input.receipts, input.fragments)
    && input.rowCount === input.receipts.reduce((sum, receipt) => sum + receipt.rowCount, 0)
    && input.byteCount === input.fragments.reduce(
      (sum, fragment) => sum + fragment.plaintextBytes,
      0,
    )
    && input.fragments.length <= 256;
}

export type AnalysisRunnerRegistration = Readonly<{
  deviceId: string;
  displayName: string;
  backgroundAllowed: boolean;
}>;

export type AnalysisLeaseClaim = Readonly<{
  runnerId: string;
  deviceId: string;
  background: boolean;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
    ? record
    : null;
}

export function parseAnalysisRunnerRegistration(value: unknown): AnalysisRunnerRegistration {
  const row = exactRecord(value, ["deviceId", "displayName", "backgroundAllowed"]);
  if (!row || typeof row.deviceId !== "string" || row.deviceId.trim().length < 1
    || row.deviceId.length > 256 || UNSAFE_DISPLAY.test(row.deviceId)
    || typeof row.displayName !== "string" || row.displayName.trim().length < 1
    || row.displayName.length > 256 || UNSAFE_DISPLAY.test(row.displayName)
    || typeof row.backgroundAllowed !== "boolean") {
    throw new Error("Invalid Analysis runner registration");
  }
  return {
    deviceId: row.deviceId.trim(),
    displayName: row.displayName.trim(),
    backgroundAllowed: row.backgroundAllowed,
  };
}

export function parseAnalysisLeaseClaim(value: unknown): AnalysisLeaseClaim {
  const row = exactRecord(value, ["runnerId", "deviceId", "background"]);
  if (!row || typeof row.runnerId !== "string" || !UUID.test(row.runnerId)
    || typeof row.deviceId !== "string" || row.deviceId.trim().length < 1
    || row.deviceId.length > 256 || UNSAFE_DISPLAY.test(row.deviceId)
    || typeof row.background !== "boolean") {
    throw new Error("Invalid Analysis refresh lease claim");
  }
  return { runnerId: row.runnerId, deviceId: row.deviceId.trim(), background: row.background };
}

function safeInteger(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum ? value : null;
}

function validValue(value: unknown) {
  return value === null || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length <= 32_000 && !value.includes("\u0000"));
}

function validParameterValue(
  type: AnalysisArticleDefinition["parameters"][number]["type"],
  value: unknown,
  options: readonly string[],
) {
  if (value === null) return true;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeof value !== "string" || value.length > 4_000 || value.includes("\u0000")) return false;
  if (type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (type === "datetime") return !Number.isNaN(Date.parse(value));
  if (type === "enum") return options.includes(value);
  return true;
}

export function parseAnalysisParameterValues(
  definition: AnalysisArticleDefinition,
  value: unknown,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Analysis Article parameters");
  }
  const row = value as Record<string, unknown>;
  const known = new Set(definition.parameters.map((parameter) => parameter.id));
  if (Object.keys(row).some((key) => !known.has(key))) {
    throw new Error("Unknown Analysis Article parameter");
  }
  const output: Record<string, AnalysisParameterValue> = {};
  for (const parameter of definition.parameters) {
    const candidate = Object.prototype.hasOwnProperty.call(row, parameter.id)
      ? row[parameter.id]
      : parameter.defaultValue;
    if ((candidate === null && parameter.required)
      || !validParameterValue(parameter.type, candidate, parameter.options)) {
      throw new Error(`Invalid Analysis Article parameter: ${parameter.label}`);
    }
    output[parameter.id] = candidate as AnalysisParameterValue;
  }
  return output;
}

export function parseAnalysisRunRequest(
  value: unknown,
  definition: AnalysisArticleDefinition,
): AnalysisRunRequest {
  const row = exactRecord(value, ["id", "articleRevision", "runnerId", "trigger", "parameterValues"]);
  const revision = safeInteger(row?.articleRevision, 1, Number.MAX_SAFE_INTEGER);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || revision === null || typeof row.runnerId !== "string" || !UUID.test(row.runnerId)
    || typeof row.trigger !== "string"
    || !["manual", "schedule", "signal", "publication"].includes(row.trigger)) {
    throw new Error("Invalid Analysis Article run request");
  }
  return {
    id: row.id,
    articleRevision: revision,
    runnerId: row.runnerId,
    trigger: row.trigger as AnalysisRunRequest["trigger"],
    parameterValues: parseAnalysisParameterValues(definition, row.parameterValues),
  };
}

function parseReceipt(value: unknown): AnalysisQueryReceiptInput {
  const row = exactRecord(value, [
    "queryNodeId", "connectionId", "connectionRevision", "queryRunId", "queryHash",
    "schemaFingerprint", "state", "rowCount", "byteCount", "durationMs",
  ]);
  const connectionRevision = safeInteger(row?.connectionRevision, 1, Number.MAX_SAFE_INTEGER);
  const rowCount = safeInteger(row?.rowCount, 0, 50_000);
  const byteCount = safeInteger(row?.byteCount, 0, 16 * 1024 * 1024);
  const durationMs = safeInteger(row?.durationMs, 0, 24 * 60 * 60 * 1_000);
  if (!row || typeof row.queryNodeId !== "string" || !ID.test(row.queryNodeId)
    || typeof row.connectionId !== "string" || !UUID.test(row.connectionId)
    || connectionRevision === null || typeof row.queryRunId !== "string" || !UUID.test(row.queryRunId)
    || typeof row.queryHash !== "string" || !HASH.test(row.queryHash)
    || typeof row.schemaFingerprint !== "string" || !HASH.test(row.schemaFingerprint)
    || typeof row.state !== "string"
    || !["succeeded", "failed", "cancelled", "stale"].includes(row.state)
    || rowCount === null || byteCount === null || durationMs === null) {
    throw new Error("Invalid Analysis Article query receipt");
  }
  return {
    queryNodeId: row.queryNodeId,
    connectionId: row.connectionId,
    connectionRevision,
    queryRunId: row.queryRunId,
    queryHash: row.queryHash,
    schemaFingerprint: row.schemaFingerprint,
    state: row.state as AnalysisQueryReceiptInput["state"],
    rowCount,
    byteCount,
    durationMs,
  };
}

function parseColumn(value: unknown): AnalysisColumn {
  const row = exactRecord(value, [
    "name", "type", "nullable", "role", "sensitivity", "masking",
  ]);
  const types = ["string", "number", "boolean", "date", "datetime", "duration", "currency", "percent", "json"];
  const roles = ["dimension", "measure", "time", "identifier", "free_text"];
  const sensitivities = ["public", "internal", "confidential", "restricted"];
  const masking = ["none", "redact", "hash", "bucket"];
  if (!row || typeof row.name !== "string" || row.name.length < 1 || row.name.length > 256
    || UNSAFE_DISPLAY.test(row.name) || typeof row.type !== "string" || !types.includes(row.type)
    || typeof row.nullable !== "boolean" || typeof row.role !== "string" || !roles.includes(row.role)
    || typeof row.sensitivity !== "string" || !sensitivities.includes(row.sensitivity)
    || typeof row.masking !== "string" || !masking.includes(row.masking)
    || (row.role === "identifier" && !["hash", "redact"].includes(row.masking))
    || (row.role === "free_text" && row.masking !== "redact")
    || (row.sensitivity === "restricted" && row.masking !== "redact")
    || (row.sensitivity === "confidential" && row.masking === "none")
    // The control plane cannot prove that a client-derived bucket did not simply
    // reuse a raw value with the same shape. Keep bucketing local to public data;
    // private values require a one-way hash or full redaction at this boundary.
    || (row.masking === "bucket" && row.sensitivity !== "public")
    || (row.masking === "hash" && row.type !== "string")) {
    throw new Error("Invalid result fragment column");
  }
  return {
    name: row.name,
    type: row.type as AnalysisColumn["type"],
    nullable: row.nullable,
    role: row.role as AnalysisColumn["role"],
    sensitivity: row.sensitivity as AnalysisColumn["sensitivity"],
    masking: row.masking as AnalysisColumn["masking"],
  };
}

function validBucketValue(
  column: AnalysisColumn,
  value: string | number | boolean | null,
): boolean {
  if (value === null) return true;
  switch (column.type) {
    case "date":
    case "datetime":
      return typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
    case "number":
    case "duration":
    case "currency":
    case "percent": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      const magnitude = value === 0 ? 1 : 10 ** Math.floor(Math.log10(Math.abs(value)));
      return Object.is(Math.floor(value / magnitude) * magnitude, value);
    }
    case "string":
    case "json":
      return typeof value === "string" && ["0-3", "4-7", "8-15", "16+"].includes(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

export function parseAnalysisResultFragment(value: unknown): AnalysisResultFragmentPayload {
  const row = exactRecord(value, ["version", "blockId", "ordinal", "columns", "rows", "truncated"]);
  const ordinal = safeInteger(row?.ordinal, 0, 255);
  if (!row || row.version !== 1 || typeof row.blockId !== "string" || !ID.test(row.blockId)
    || ordinal === null || !Array.isArray(row.columns) || row.columns.length < 1
    || row.columns.length > 256 || !Array.isArray(row.rows) || row.rows.length > 5_000
    || typeof row.truncated !== "boolean") throw new Error("Invalid Analysis Article result fragment");
  const columns = row.columns.map(parseColumn);
  if (new Set(columns.map((column) => column.name)).size !== columns.length) {
    throw new Error("Duplicate result fragment column");
  }
  const rows = row.rows.map((candidate) => {
    if (!Array.isArray(candidate) || candidate.length !== columns.length || candidate.some((cell, index) => {
      const column = columns[index]!;
      return !validValue(cell)
        || (column.masking === "redact" && cell !== null)
        || (column.masking === "hash" && !(typeof cell === "string" && /^[0-9a-f]{64}$/.test(cell)))
        || (column.masking === "bucket" && !validBucketValue(column, cell));
    })) {
      throw new Error("Invalid Analysis Article result row");
    }
    return candidate as (string | number | boolean | null)[];
  });
  const encoded = new TextEncoder().encode(JSON.stringify({
    version: 1,
    blockId: row.blockId,
    ordinal,
    columns,
    rows,
    truncated: row.truncated,
  }));
  if (encoded.byteLength > 1024 * 1024) throw new Error("Analysis Article result fragment is too large");
  return { version: 1, blockId: row.blockId, ordinal, columns, rows, truncated: row.truncated };
}

/**
 * A successful run is useful evidence only when every source-backed block owns
 * one complete fragment sequence. This is shared by staged manifests and the
 * temporary inline protocol so neither transport can omit a block or a middle
 * fragment while still claiming success.
 */
export function analysisResultFragmentsAreComplete(
  definition: AnalysisArticleDefinition,
  fragments: readonly Pick<AnalysisResultFragmentReference, "blockId" | "ordinal">[],
) {
  const expectedBlockIds = new Set(
    definition.blocks.flatMap((block) => block.sourceNodeId ? [block.id] : []),
  );
  const ordinalsByBlock = new Map<string, Set<number>>();
  for (const fragment of fragments) {
    if (!expectedBlockIds.has(fragment.blockId)) return false;
    const ordinals = ordinalsByBlock.get(fragment.blockId) ?? new Set<number>();
    if (ordinals.has(fragment.ordinal)) return false;
    ordinals.add(fragment.ordinal);
    ordinalsByBlock.set(fragment.blockId, ordinals);
  }
  if (ordinalsByBlock.size !== expectedBlockIds.size) return false;
  return [...expectedBlockIds].every((blockId) => {
    const ordinals = ordinalsByBlock.get(blockId);
    if (!ordinals || ordinals.size === 0) return false;
    return [...ordinals].every((ordinal) => ordinal >= 0 && ordinal < ordinals.size);
  });
}

/**
 * Parses terminal evidence without deciding where results may be stored. An
 * empty successful manifest is the valid Desktop-only form; the route and the
 * PostgreSQL commit independently enforce whether this exact run is local-only
 * or must provide a complete shared fragment set.
 */
export function parseAnalysisRunCompletion(
  value: unknown,
  definition: AnalysisArticleDefinition,
): AnalysisRunCompletion {
  const stagedRow = exactRecord(value, ["state", "queryReceipts", "fragmentManifest", "error"]);
  const inlineRow = exactRecord(value, ["state", "queryReceipts", "fragments", "error"]);
  const row = stagedRow ?? inlineRow;
  if (!row || typeof row.state !== "string"
    || !["succeeded", "failed", "cancelled", "stale"].includes(row.state)
    || !Array.isArray(row.queryReceipts) || row.queryReceipts.length > 64
    || (stagedRow !== null
      && (!Array.isArray(stagedRow.fragmentManifest) || stagedRow.fragmentManifest.length > 256))
    || (inlineRow !== null
      && (!Array.isArray(inlineRow.fragments) || inlineRow.fragments.length > 256))) {
    throw new Error("Invalid Analysis Article run completion");
  }
  const receipts = row.queryReceipts.map(parseReceipt);
  const fragmentManifest = (stagedRow?.fragmentManifest as unknown[] | undefined ?? []).map((candidate) => {
    const fragment = exactRecord(candidate, ["blockId", "ordinal", "payloadHash"]);
    const ordinal = safeInteger(fragment?.ordinal, 0, 255);
    if (!fragment || typeof fragment.blockId !== "string" || !ID.test(fragment.blockId)
      || ordinal === null || typeof fragment.payloadHash !== "string"
      || !HASH.test(fragment.payloadHash)) {
      throw new Error("Invalid Analysis Article result manifest");
    }
    return { blockId: fragment.blockId, ordinal, payloadHash: fragment.payloadHash };
  });
  const inlineFragments = (inlineRow?.fragments as unknown[] | undefined ?? [])
    .map(parseAnalysisResultFragment);
  if (new Set(receipts.map((receipt) => receipt.queryNodeId)).size !== receipts.length
    || new Set(fragmentManifest.map((fragment) => `${fragment.blockId}:${fragment.ordinal}`)).size
      !== fragmentManifest.length
    || new Set(inlineFragments.map((fragment) => `${fragment.blockId}:${fragment.ordinal}`)).size
      !== inlineFragments.length) {
    throw new Error("Duplicate Analysis Article run evidence");
  }
  const queryById = new Map(definition.queries.map((query) => [query.id, query]));
  if (receipts.some((receipt) => {
    const query = queryById.get(receipt.queryNodeId);
    return !query || query.maxRows < receipt.rowCount || query.maxBytes < receipt.byteCount;
  })) throw new Error("Analysis Article query receipt exceeds its definition");
  const dataBlockIds = new Set(definition.blocks.flatMap((block) => block.sourceNodeId ? [block.id] : []));
  if (fragmentManifest.some((fragment) => !dataBlockIds.has(fragment.blockId))) {
    throw new Error("Analysis Article result references an unknown data block");
  }
  if (inlineFragments.some((fragment) => !dataBlockIds.has(fragment.blockId))) {
    throw new Error("Analysis Article result references an unknown data block");
  }
  const errorRow = row.error === null ? null : exactRecord(row.error, ["kind", "message"]);
  const error = errorRow && typeof errorRow.kind === "string" && errorRow.kind.length <= 128
    && !UNSAFE_DISPLAY.test(errorRow.kind) && typeof errorRow.message === "string"
    && errorRow.message.length <= 2_000 && !UNSAFE_DISPLAY.test(errorRow.message)
    ? { kind: errorRow.kind, message: errorRow.message }
    : null;
  const succeeded = row.state === "succeeded";
  const resultFragments = stagedRow ? fragmentManifest : inlineFragments;
  if ((succeeded && (receipts.length !== definition.queries.length
    || receipts.some((receipt) => receipt.state !== "succeeded") || error !== null
    || (resultFragments.length > 0
      && !analysisResultFragmentsAreComplete(definition, resultFragments))))
    || (!succeeded && error === null)
    || (!succeeded && (fragmentManifest.length > 0 || inlineFragments.length > 0))) {
    throw new Error("Analysis Article completion state is inconsistent");
  }
  return {
    state: row.state as AnalysisRunCompletion["state"],
    queryReceipts: receipts,
    fragmentManifest,
    inlineFragments,
    error,
  };
}
