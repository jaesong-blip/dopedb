// Runtime-neutral validation for shared SignalRule definitions and categorical
// EvaluationReceipts. Exact records make result values, SQL, credentials, and
// arbitrary provider data fail closed instead of being silently retained.

import { CronExpressionParser } from "cron-parser";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export const signalEvaluationStates = [
  "normal", "firing", "recovered", "no_data", "error", "stale", "runner_offline",
] as const;
export type SignalEvaluationState = (typeof signalEvaluationStates)[number];

export type SignalRuleCreate = Readonly<{
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceAnalysisId: string;
  sourceAnalysisRevision: number;
  sourceTileId: string;
  metricSemanticId: string;
  connections: readonly Readonly<{ connectionId: string; connectionRevision: number }>[];
  schedule: string;
  timezone: string;
  evaluationWindowSeconds: number;
  condition: Readonly<Record<string, unknown>>;
  baselineWindowSeconds: number | null;
  minimumSampleCount: number;
  cooldownSeconds: number;
  rearmAfterNormalCount: number;
  severity: "info" | "warning" | "critical";
  recipientMemberIds: readonly string[];
  channels: readonly ("desktop" | "workspace_web" | "email")[];
  runnerId: string | null;
  enabled: boolean;
  productionConfirmed: boolean;
}>;

export type SignalEvaluationReceiptInput = Readonly<{
  receiptId: string;
  ruleId: string;
  ruleRevision: number;
  projectEnvironmentId: string;
  environmentRevision: number;
  runnerDeviceId: string;
  scheduledAt: Date;
  evaluatedAt: Date;
  state: SignalEvaluationState;
  queryRunIds: readonly string[];
  connectionIds: readonly string[];
  durationMs: number;
  rowCountCategory: string;
  schemaFingerprint: string;
  dedupeKey: string;
  transitionSequence: number;
  errorKind: string | null;
}>;

export type SignalRunnerRegistration = Readonly<{
  deviceId: string;
  displayName: string;
  backgroundAllowed: boolean;
}>;

export type SignalLeaseClaim = Readonly<{
  runnerId: string;
  deviceId: string;
  background: boolean;
}>;

export type SignalRuleUpdate = Readonly<{
  schedule: string;
  timezone: string;
  evaluationWindowSeconds: number;
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

export type SignalRuleMutation =
  | Readonly<{ action: "pause" | "enable" | "disable" | "run_now" }>
  | Readonly<{ action: "runner_change"; runnerId: string }>
  | Readonly<{ action: "update"; definition: SignalRuleUpdate }>;

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
    ? record
    : null;
}

function text(value: unknown, maxChars: number) {
  if (typeof value !== "string" || UNSAFE_DISPLAY.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && [...value].length <= maxChars ? trimmed : null;
}

function integer(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum ? value : null;
}

function unique(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function safeSchedule(value: unknown) {
  const schedule = text(value, 256);
  if (!schedule) return null;
  const fields = schedule.split(/\s+/u);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9*/?,\-]+$/.test(field))) return null;
  const minute = fields[0];
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && (Number(step[1]) < 5 || Number(step[1]) > 59)) return null;
  if (!step && !/^(?:[0-9]|[1-5][0-9])$/.test(minute)) return null;
  try {
    CronExpressionParser.parse(schedule, { currentDate: new Date(), tz: "UTC" }).next();
    return schedule;
  } catch {
    return null;
  }
}

function safeTimezone(value: unknown) {
  const timezone = text(value, 128);
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return null;
  }
}

/** Return the first scheduled instant strictly after the supplied time. */
export function nextSignalEvaluationAt(schedule: string, timezone: string, after: Date) {
  const safe = safeSchedule(schedule);
  const zone = safeTimezone(timezone);
  if (!safe || !zone || Number.isNaN(after.valueOf())) {
    throw new Error("Invalid signal schedule");
  }
  return CronExpressionParser.parse(safe, {
    currentDate: after,
    tz: zone,
  }).next().toDate();
}

function parseCondition(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid signal condition");
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "threshold_above" || kind === "threshold_below" || kind === "absolute_change") {
    const row = exactRecord(value, ["kind", "value"]);
    if (!row || typeof row.value !== "number" || !Number.isFinite(row.value)) {
      throw new Error("Invalid signal threshold condition");
    }
    return { kind, value: row.value };
  }
  if (kind === "percentage_change") {
    const row = exactRecord(value, ["kind", "percentage"]);
    if (!row || typeof row.percentage !== "number" || !Number.isFinite(row.percentage)
      || row.percentage < 0) throw new Error("Invalid signal percentage condition");
    return { kind, percentage: row.percentage };
  }
  if (kind === "consecutive_failure" || kind === "missing_data") {
    const row = exactRecord(value, ["kind", "count"]);
    const count = integer(row?.count, 1, 1_000);
    if (count === null) throw new Error("Invalid signal count condition");
    return { kind, count };
  }
  throw new Error("Invalid signal condition kind");
}

export function parseSignalRunnerRegistration(value: unknown): SignalRunnerRegistration {
  const row = exactRecord(value, ["deviceId", "displayName", "backgroundAllowed"]);
  const deviceId = text(row?.deviceId, 256);
  const displayName = text(row?.displayName, 256);
  if (!row || deviceId === null || displayName === null
    || typeof row.backgroundAllowed !== "boolean") {
    throw new Error("Invalid signal runner registration");
  }
  return { deviceId, displayName, backgroundAllowed: row.backgroundAllowed };
}

export function parseSignalLeaseClaim(value: unknown): SignalLeaseClaim {
  const row = exactRecord(value, ["runnerId", "deviceId", "background"]);
  const deviceId = text(row?.deviceId, 256);
  if (!row || typeof row.runnerId !== "string" || !UUID.test(row.runnerId)
    || deviceId === null || typeof row.background !== "boolean") {
    throw new Error("Invalid signal lease claim");
  }
  return { runnerId: row.runnerId, deviceId, background: row.background };
}

export function parseSignalRuleMutation(value: unknown): SignalRuleMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid signal rule command");
  }
  const action = (value as Record<string, unknown>).action;
  if (action === "runner_change") {
    const row = exactRecord(value, ["action", "runnerId"]);
    if (!row || typeof row.runnerId !== "string" || !UUID.test(row.runnerId)) {
      throw new Error("Invalid signal runner change");
    }
    return { action, runnerId: row.runnerId };
  }
  if (action === "update") {
    const row = exactRecord(value, ["action", "definition"]);
    const definition = exactRecord(row?.definition, [
      "schedule", "timezone", "evaluationWindowSeconds", "condition",
      "baselineWindowSeconds", "minimumSampleCount", "cooldownSeconds",
      "rearmAfterNormalCount", "severity", "recipientMemberIds", "channels",
      "productionConfirmed",
    ]);
    const schedule = safeSchedule(definition?.schedule);
    const timezone = safeTimezone(definition?.timezone);
    const evaluationWindow = integer(definition?.evaluationWindowSeconds, 1, 31_622_400);
    const baselineWindow = definition?.baselineWindowSeconds === null
      ? null : integer(definition?.baselineWindowSeconds, 1, 31_622_400);
    const minimumSample = integer(definition?.minimumSampleCount, 0, 1_000_000_000);
    const cooldown = integer(definition?.cooldownSeconds, 0, 31_622_400);
    const rearm = integer(definition?.rearmAfterNormalCount, 1, 1_000);
    if (!row || !definition || schedule === null || timezone === null
      || evaluationWindow === null
      || (definition.baselineWindowSeconds !== null && baselineWindow === null)
      || minimumSample === null || cooldown === null || rearm === null
      || !(definition.severity === "info" || definition.severity === "warning"
        || definition.severity === "critical")
      || typeof definition.productionConfirmed !== "boolean"
      || !Array.isArray(definition.recipientMemberIds)
      || definition.recipientMemberIds.length < 1
      || definition.recipientMemberIds.length > 100
      || !Array.isArray(definition.channels)
      || definition.channels.length < 1 || definition.channels.length > 3) {
      throw new Error("Invalid signal rule update");
    }
    const recipientMemberIds = definition.recipientMemberIds.map((member) => text(member, 256));
    const channels = definition.channels.map(String);
    if (recipientMemberIds.some((member) => member === null)
      || !unique(recipientMemberIds as string[]) || !unique(channels)
      || channels.some((channel) => !["desktop", "workspace_web", "email"].includes(channel))) {
      throw new Error("Invalid signal recipients or channels");
    }
    const condition = parseCondition(definition.condition);
    if ((condition.kind === "absolute_change" || condition.kind === "percentage_change")
      && baselineWindow === null) {
      throw new Error("Change signals require a baseline window");
    }
    return {
      action,
      definition: {
        schedule,
        timezone,
        evaluationWindowSeconds: evaluationWindow,
        condition,
        baselineWindowSeconds: baselineWindow,
        minimumSampleCount: minimumSample,
        cooldownSeconds: cooldown,
        rearmAfterNormalCount: rearm,
        severity: definition.severity,
        recipientMemberIds: recipientMemberIds as string[],
        channels: channels as SignalRuleUpdate["channels"],
        productionConfirmed: definition.productionConfirmed,
      },
    };
  }
  if (!["pause", "enable", "disable", "run_now"].includes(String(action))) {
    throw new Error("Invalid signal rule command");
  }
  const row = exactRecord(value, ["action"]);
  if (!row) throw new Error("Invalid signal rule command");
  return { action: action as "pause" | "enable" | "disable" | "run_now" };
}

export function parseSignalRuleCreate(value: unknown): SignalRuleCreate {
  const row = exactRecord(value, [
    "id", "projectEnvironmentId", "environmentRevision", "sourceAnalysisId",
    "sourceAnalysisRevision", "sourceTileId", "metricSemanticId", "connections",
    "schedule", "timezone", "evaluationWindowSeconds", "condition",
    "baselineWindowSeconds", "minimumSampleCount", "cooldownSeconds",
    "rearmAfterNormalCount", "severity", "recipientMemberIds", "channels",
    "runnerId", "enabled", "productionConfirmed",
  ]);
  const environmentRevision = integer(row?.environmentRevision, 1, Number.MAX_SAFE_INTEGER);
  const analysisRevision = integer(row?.sourceAnalysisRevision, 1, Number.MAX_SAFE_INTEGER);
  const evaluationWindow = integer(row?.evaluationWindowSeconds, 1, 31_622_400);
  const baselineWindow = row?.baselineWindowSeconds === null
    ? null : integer(row?.baselineWindowSeconds, 1, 31_622_400);
  const minimumSample = integer(row?.minimumSampleCount, 0, 1_000_000_000);
  const cooldown = integer(row?.cooldownSeconds, 0, 31_622_400);
  const rearm = integer(row?.rearmAfterNormalCount, 1, 1_000);
  const schedule = safeSchedule(row?.schedule);
  const timezone = safeTimezone(row?.timezone);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || typeof row.projectEnvironmentId !== "string" || !UUID.test(row.projectEnvironmentId)
    || typeof row.sourceAnalysisId !== "string" || !UUID.test(row.sourceAnalysisId)
    || !(row.runnerId === null || (typeof row.runnerId === "string" && UUID.test(row.runnerId)))
    || environmentRevision === null || analysisRevision === null
    || text(row.sourceTileId, 64) === null || !ID.test(String(row.metricSemanticId))
    || schedule === null || timezone === null
    || evaluationWindow === null
    || (row.baselineWindowSeconds !== null && baselineWindow === null)
    || minimumSample === null || cooldown === null || rearm === null
    || !(row.severity === "info" || row.severity === "warning" || row.severity === "critical")
    || typeof row.enabled !== "boolean" || typeof row.productionConfirmed !== "boolean"
    || !Array.isArray(row.connections) || row.connections.length < 1 || row.connections.length > 32
    || !Array.isArray(row.recipientMemberIds) || row.recipientMemberIds.length < 1
    || row.recipientMemberIds.length > 100 || !Array.isArray(row.channels)
    || row.channels.length < 1 || row.channels.length > 3) {
    throw new Error("Invalid signal rule");
  }
  const connections = row.connections.map((value) => {
    const connection = exactRecord(value, ["connectionId", "connectionRevision"]);
    const revision = integer(connection?.connectionRevision, 1, Number.MAX_SAFE_INTEGER);
    if (!connection || typeof connection.connectionId !== "string"
      || !UUID.test(connection.connectionId) || revision === null) {
      throw new Error("Invalid signal connection");
    }
    return { connectionId: connection.connectionId, connectionRevision: revision };
  });
  const recipientMemberIds = row.recipientMemberIds.map((value) => text(value, 256));
  const channels = row.channels.map((value) => String(value));
  if (!unique(connections.map((connection) => connection.connectionId))
    || recipientMemberIds.some((member) => member === null)
    || !unique(recipientMemberIds as string[]) || !unique(channels)
    || channels.some((channel) => !["desktop", "workspace_web", "email"].includes(channel))) {
    throw new Error("Invalid signal recipients or channels");
  }
  const condition = parseCondition(row.condition);
  if ((condition.kind === "absolute_change" || condition.kind === "percentage_change")
    && baselineWindow === null) {
    throw new Error("Change signals require a baseline window");
  }
  return {
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision,
    sourceAnalysisId: row.sourceAnalysisId,
    sourceAnalysisRevision: analysisRevision,
    sourceTileId: String(row.sourceTileId).trim(),
    metricSemanticId: String(row.metricSemanticId),
    connections,
    schedule,
    timezone,
    evaluationWindowSeconds: evaluationWindow,
    condition,
    baselineWindowSeconds: baselineWindow,
    minimumSampleCount: minimumSample,
    cooldownSeconds: cooldown,
    rearmAfterNormalCount: rearm,
    severity: row.severity,
    recipientMemberIds: recipientMemberIds as string[],
    channels: channels as SignalRuleCreate["channels"],
    runnerId: row.runnerId as string | null,
    enabled: row.enabled,
    productionConfirmed: row.productionConfirmed,
  };
}

export function parseSignalEvaluationReceipt(value: unknown): SignalEvaluationReceiptInput {
  const row = exactRecord(value, [
    "receiptId", "ruleId", "ruleRevision", "projectEnvironmentId",
    "environmentRevision", "runnerDeviceId", "scheduledAt", "evaluatedAt", "state",
    "queryRunIds", "connectionIds", "durationMs", "rowCountCategory",
    "schemaFingerprint", "dedupeKey", "transitionSequence", "errorKind",
  ]);
  const ruleRevision = integer(row?.ruleRevision, 1, Number.MAX_SAFE_INTEGER);
  const environmentRevision = integer(row?.environmentRevision, 1, Number.MAX_SAFE_INTEGER);
  const durationMs = integer(row?.durationMs, 0, Number.MAX_SAFE_INTEGER);
  const sequence = integer(row?.transitionSequence, 1, Number.MAX_SAFE_INTEGER);
  const scheduledAt = typeof row?.scheduledAt === "string" ? new Date(row.scheduledAt) : null;
  const evaluatedAt = typeof row?.evaluatedAt === "string" ? new Date(row.evaluatedAt) : null;
  if (!row || typeof row.receiptId !== "string" || !UUID.test(row.receiptId)
    || typeof row.ruleId !== "string" || !UUID.test(row.ruleId)
    || typeof row.projectEnvironmentId !== "string" || !UUID.test(row.projectEnvironmentId)
    || ruleRevision === null || environmentRevision === null || durationMs === null
    || sequence === null || !scheduledAt || Number.isNaN(scheduledAt.getTime())
    || !evaluatedAt || Number.isNaN(evaluatedAt.getTime()) || evaluatedAt < scheduledAt
    || !signalEvaluationStates.includes(row.state as SignalEvaluationState)
    || row.state === "recovered" || row.state === "runner_offline"
    || text(row.runnerDeviceId, 256) === null || !Array.isArray(row.queryRunIds)
    || row.queryRunIds.length > 32 || !Array.isArray(row.connectionIds)
    || row.connectionIds.length < 1 || row.connectionIds.length > 32
    || row.queryRunIds.some((id) => typeof id !== "string" || !UUID.test(id))
    || row.connectionIds.some((id) => typeof id !== "string" || !UUID.test(id))
    || !unique(row.queryRunIds as string[]) || !unique(row.connectionIds as string[])
    || !["zero", "one", "small", "medium", "large", "unknown"].includes(
      String(row.rowCountCategory),
    )
    || typeof row.schemaFingerprint !== "string" || !HASH.test(row.schemaFingerprint)
    || text(row.dedupeKey, 256) === null
    || !(row.errorKind === null || [
      "query_failed", "authorization_changed", "credential_unavailable",
      "schema_changed", "timeout", "cancelled", "runner_error",
    ].includes(String(row.errorKind)))
    || ((row.state === "error") !== (row.errorKind !== null))) {
    throw new Error("Invalid signal evaluation receipt");
  }
  return {
    receiptId: row.receiptId,
    ruleId: row.ruleId,
    ruleRevision,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision,
    runnerDeviceId: String(row.runnerDeviceId).trim(),
    scheduledAt,
    evaluatedAt,
    state: row.state as SignalEvaluationState,
    queryRunIds: row.queryRunIds as string[],
    connectionIds: row.connectionIds as string[],
    durationMs,
    rowCountCategory: String(row.rowCountCategory).trim(),
    schemaFingerprint: row.schemaFingerprint,
    dedupeKey: String(row.dedupeKey).trim(),
    transitionSequence: sequence,
    errorKind: row.errorKind === null ? null : String(row.errorKind).trim(),
  };
}
