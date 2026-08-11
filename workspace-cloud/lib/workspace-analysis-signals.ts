// Closed contract for signals attached to one metric block of an Analysis Article.
// Metric values never cross this boundary; Desktop submits only categorical state
// bound to an exact successful run/result hash.
import type { AnalysisArticleDefinition } from "./workspace-analysis-articles";

export type AnalysisSignalDefinition = Readonly<{
  condition: Readonly<Record<string, unknown>>;
  baselineWindowSeconds: number | null;
  minimumSampleCount: number;
  cooldownSeconds: number;
  rearmAfterNormalCount: number;
  severity: "info" | "warning" | "critical";
  recipientMemberIds: readonly string[];
  channels: readonly ("desktop" | "workspace_web" | "email")[];
  productionConfirmed: boolean;
}>;

export type AnalysisSignalCreate = Readonly<{
  id: string;
  articleRevision: number;
  blockId: string;
  definition: AnalysisSignalDefinition;
  enabled: boolean;
}>;

export type AnalysisSignalVersionPayload = AnalysisSignalCreate & Readonly<{
  deleted: boolean;
}>;

export type AnalysisSignalMutation =
  | Readonly<{
    action: "update";
    articleRevision: number;
    blockId: string;
    definition: AnalysisSignalDefinition;
  }>
  | Readonly<{ action: "enable" }>
  | Readonly<{ action: "disable" }>
  | Readonly<{ action: "delete" }>;

export type AnalysisSignalReceipt = Readonly<{
  id: string;
  signalRevision: number;
  runId: string;
  observedState: "normal" | "firing" | "no_data" | "error" | "stale";
  resultHash: string | null;
  schemaFingerprint: string;
  dedupeKey: string;
  errorKind: string | null;
  evaluatedAt: Date;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export function analysisSignalBlockIsEligible(
  definition: AnalysisArticleDefinition,
  blockId: string,
) {
  const block = definition.blocks.find((candidate) => candidate.id === blockId);
  if (!block || block.kind !== "metric" || !block.sourceNodeId) return false;
  const metricId = block.config.metricId;
  const metric = typeof metricId === "string"
    ? definition.metrics.find((candidate) => candidate.id === metricId) : null;
  const node = [...definition.queries, ...definition.transforms]
    .find((candidate) => candidate.id === block.sourceNodeId);
  const valueColumn = metric && node
    ? node.columns.find((column) => column.name === metric.valueColumn) : null;
  if (!metric || metric.sourceNodeId !== block.sourceNodeId || !valueColumn
    || !["number", "duration", "currency", "percent"].includes(valueColumn.type)
    || valueColumn.masking !== "none"
    || !["public", "internal"].includes(valueColumn.sensitivity)) return false;
  const sampleCountColumn = block.config.sampleCountColumn;
  if (sampleCountColumn !== null) {
    const sample = typeof sampleCountColumn === "string"
      ? node?.columns.find((column) => column.name === sampleCountColumn) : null;
    if (!sample || sample.type !== "number" || sample.masking !== "none"
      || !["public", "internal"].includes(sample.sensitivity)) return false;
  }
  return true;
}

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(row, field))
    ? row : null;
}

function integer(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum ? value : null;
}

function condition(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Analysis signal condition");
  }
  const kind = (value as Record<string, unknown>).kind;
  if (["threshold_above", "threshold_below", "absolute_change"].includes(String(kind))) {
    const row = exactRecord(value, ["kind", "value"]);
    if (!row || typeof row.value !== "number" || !Number.isFinite(row.value)) {
      throw new Error("Invalid Analysis signal threshold");
    }
    return { kind, value: row.value };
  }
  if (kind === "percentage_change") {
    const row = exactRecord(value, ["kind", "percentage"]);
    if (!row || typeof row.percentage !== "number" || !Number.isFinite(row.percentage)
      || row.percentage < 0) throw new Error("Invalid Analysis signal percentage");
    return { kind, percentage: row.percentage };
  }
  if (kind === "missing_data" || kind === "consecutive_failure") {
    const row = exactRecord(value, ["kind", "count"]);
    const count = integer(row?.count, 1, 1_000);
    if (count === null) throw new Error("Invalid Analysis signal count");
    return { kind, count };
  }
  throw new Error("Invalid Analysis signal condition kind");
}

export function parseAnalysisSignalDefinition(value: unknown): AnalysisSignalDefinition {
  const row = exactRecord(value, [
    "condition", "baselineWindowSeconds", "minimumSampleCount", "cooldownSeconds", "rearmAfterNormalCount",
    "severity", "recipientMemberIds", "channels", "productionConfirmed",
  ]);
  const minimumSampleCount = integer(row?.minimumSampleCount, 0, 1_000_000_000);
  const baselineWindowSeconds = row?.baselineWindowSeconds === null
    ? null : integer(row?.baselineWindowSeconds, 60, 31_622_400);
  const cooldownSeconds = integer(row?.cooldownSeconds, 0, 31_622_400);
  const rearmAfterNormalCount = integer(row?.rearmAfterNormalCount, 1, 1_000);
  if (!row || baselineWindowSeconds === null && row?.baselineWindowSeconds !== null
    || minimumSampleCount === null || cooldownSeconds === null
    || rearmAfterNormalCount === null
    || !(row.severity === "info" || row.severity === "warning" || row.severity === "critical")
    || !Array.isArray(row.recipientMemberIds) || row.recipientMemberIds.length < 1
    || row.recipientMemberIds.length > 100
    || row.recipientMemberIds.some((id) => typeof id !== "string" || !UUID.test(id))
    || new Set(row.recipientMemberIds).size !== row.recipientMemberIds.length
    || !Array.isArray(row.channels) || row.channels.length < 1 || row.channels.length > 3
    || row.channels.some((channel) => !["desktop", "workspace_web", "email"].includes(String(channel)))
    || new Set(row.channels).size !== row.channels.length
    || row.productionConfirmed !== true) {
    throw new Error("Invalid Analysis signal definition");
  }
  const parsedCondition = condition(row.condition);
  const requiresBaseline = parsedCondition.kind === "absolute_change"
    || parsedCondition.kind === "percentage_change";
  if (requiresBaseline !== (baselineWindowSeconds !== null)) {
    throw new Error("Change signals require one explicit baseline window");
  }
  return {
    condition: parsedCondition,
    baselineWindowSeconds,
    minimumSampleCount,
    cooldownSeconds,
    rearmAfterNormalCount,
    severity: row.severity,
    recipientMemberIds: row.recipientMemberIds as string[],
    channels: row.channels as AnalysisSignalDefinition["channels"],
    productionConfirmed: true,
  };
}

export function parseAnalysisSignalCreate(value: unknown): AnalysisSignalCreate {
  const row = exactRecord(value, ["id", "articleRevision", "blockId", "definition", "enabled"]);
  const articleRevision = integer(row?.articleRevision, 1, Number.MAX_SAFE_INTEGER);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || articleRevision === null || typeof row.blockId !== "string" || !ID.test(row.blockId)
    || typeof row.enabled !== "boolean") throw new Error("Invalid Analysis signal");
  return {
    id: row.id,
    articleRevision,
    blockId: row.blockId,
    definition: parseAnalysisSignalDefinition(row.definition),
    enabled: row.enabled,
  };
}

export function analysisSignalVersionPayload(
  value: AnalysisSignalCreate & { deleted?: boolean },
): AnalysisSignalVersionPayload {
  const signal = parseAnalysisSignalCreate({
    id: value.id,
    articleRevision: value.articleRevision,
    blockId: value.blockId,
    definition: value.definition,
    enabled: value.enabled,
  });
  if (!(value.deleted === undefined || typeof value.deleted === "boolean")) {
    throw new Error("Invalid Analysis signal version");
  }
  return { ...signal, deleted: value.deleted ?? false };
}

export function parseAnalysisSignalVersionPayload(value: unknown): AnalysisSignalVersionPayload {
  const row = exactRecord(value, [
    "id", "articleRevision", "blockId", "definition", "enabled", "deleted",
  ]);
  if (!row || typeof row.deleted !== "boolean") {
    throw new Error("Invalid Analysis signal revision payload");
  }
  return {
    ...parseAnalysisSignalCreate({
      id: row.id,
      articleRevision: row.articleRevision,
      blockId: row.blockId,
      definition: row.definition,
      enabled: row.enabled,
    }),
    deleted: row.deleted,
  };
}

export function parseAnalysisSignalMutation(value: unknown): AnalysisSignalMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Analysis signal action");
  }
  const action = (value as Record<string, unknown>).action;
  if (action === "update") {
    const row = exactRecord(value, ["action", "articleRevision", "blockId", "definition"]);
    const articleRevision = integer(row?.articleRevision, 1, Number.MAX_SAFE_INTEGER);
    if (!row || articleRevision === null || typeof row.blockId !== "string" || !ID.test(row.blockId)) {
      throw new Error("Invalid Analysis signal update");
    }
    return {
      action,
      articleRevision,
      blockId: row.blockId,
      definition: parseAnalysisSignalDefinition(row.definition),
    };
  }
  if (["enable", "disable", "delete"].includes(String(action))) {
    const row = exactRecord(value, ["action"]);
    if (!row) throw new Error("Invalid Analysis signal action");
    return { action: action as "enable" | "disable" | "delete" };
  }
  throw new Error("Invalid Analysis signal action");
}

export function parseAnalysisSignalReceipt(value: unknown): AnalysisSignalReceipt {
  const row = exactRecord(value, [
    "id", "signalRevision", "runId", "observedState", "resultHash",
    "schemaFingerprint", "dedupeKey", "errorKind", "evaluatedAt",
  ]);
  const signalRevision = integer(row?.signalRevision, 1, Number.MAX_SAFE_INTEGER);
  const evaluatedAt = typeof row?.evaluatedAt === "string" ? new Date(row.evaluatedAt) : null;
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || signalRevision === null || typeof row.runId !== "string" || !UUID.test(row.runId)
    || !["normal", "firing", "no_data", "error", "stale"].includes(String(row.observedState))
    || !(row.resultHash === null || (typeof row.resultHash === "string" && HASH.test(row.resultHash)))
    || typeof row.schemaFingerprint !== "string" || !HASH.test(row.schemaFingerprint)
    || typeof row.dedupeKey !== "string" || row.dedupeKey.length < 1 || row.dedupeKey.length > 256
    || UNSAFE_DISPLAY.test(row.dedupeKey)
    || !(row.errorKind === null || (typeof row.errorKind === "string"
      && row.errorKind.length > 0 && row.errorKind.length <= 128 && !UNSAFE_DISPLAY.test(row.errorKind)))
    || ((row.observedState === "error") !== (row.errorKind !== null))
    || (["normal", "firing", "no_data"].includes(String(row.observedState))
      ? typeof row.resultHash !== "string" : row.resultHash !== null)
    || !evaluatedAt || Number.isNaN(evaluatedAt.valueOf()) || evaluatedAt > new Date(Date.now() + 60_000)) {
    throw new Error("Invalid Analysis signal receipt");
  }
  return {
    id: row.id,
    signalRevision,
    runId: row.runId,
    observedState: row.observedState as AnalysisSignalReceipt["observedState"],
    resultHash: row.resultHash as string | null,
    schemaFingerprint: row.schemaFingerprint,
    dedupeKey: row.dedupeKey,
    errorKind: row.errorKind as string | null,
    evaluatedAt,
  };
}
