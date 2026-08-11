// Runtime-neutral, credential-free contract for shared Analysis Articles.
//
// An Article definition is declarative. It can describe bounded reads, typed
// transforms, narrative/BI blocks, refresh policy, and evidence claims, but it
// cannot carry result rows, credentials, executable JavaScript, HTML, or an
// inferred cross-connection join. Desktop is the only database execution plane.
import { CronExpressionParser } from "cron-parser";

export const analysisArticleStates = ["draft", "review", "live", "archived"] as const;
export const analysisArticleSources = [
  "human",
  "dopedb.acp.claude",
  "dopedb.acp.codex",
  "migration",
] as const;
export const analysisParameterTypes = [
  "string",
  "number",
  "boolean",
  "date",
  "datetime",
  "enum",
] as const;
export const analysisColumnTypes = [
  "string",
  "number",
  "boolean",
  "date",
  "datetime",
  "duration",
  "currency",
  "percent",
  "json",
] as const;
export const analysisColumnRoles = [
  "dimension",
  "measure",
  "time",
  "identifier",
  "free_text",
] as const;
export const analysisColumnSensitivities = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
export const analysisColumnMasking = ["none", "redact", "hash", "bucket"] as const;
export const analysisTransformOperations = [
  "project",
  "filter",
  "sort",
  "limit",
  "union",
  "group",
  "aggregate",
  "inner_join",
  "left_join",
  "window",
  "lag",
  "ratio",
  "difference",
  "rate",
  "cohort",
  "retention",
] as const;
export const analysisBlockKinds = [
  "heading",
  "markdown",
  "callout",
  "divider",
  "metric",
  "time_series",
  "bar",
  "area",
  "scatter",
  "table",
  "funnel",
  "retention_cohort",
  "heatmap",
  "date_range_control",
  "comparison_control",
  "segment_control",
] as const;

export type AnalysisArticleState = (typeof analysisArticleStates)[number];
export type AnalysisArticleSource = (typeof analysisArticleSources)[number];
export type AnalysisParameterType = (typeof analysisParameterTypes)[number];
export type AnalysisColumnType = (typeof analysisColumnTypes)[number];
export type AnalysisColumnRole = (typeof analysisColumnRoles)[number];
export type AnalysisColumnSensitivity = (typeof analysisColumnSensitivities)[number];
export type AnalysisColumnMasking = (typeof analysisColumnMasking)[number];
export type AnalysisTransformOperation = (typeof analysisTransformOperations)[number];
export type AnalysisBlockKind = (typeof analysisBlockKinds)[number];

export type AnalysisArticleConnection = Readonly<{
  connectionId: string;
  connectionRevision: number;
  role: string;
  alias: string;
}>;

export type AnalysisParameterValue = string | number | boolean | null;

export type AnalysisParameter = Readonly<{
  id: string;
  label: string;
  type: AnalysisParameterType;
  required: boolean;
  defaultValue: AnalysisParameterValue;
  options: readonly string[];
}>;

export type AnalysisColumn = Readonly<{
  name: string;
  type: AnalysisColumnType;
  nullable: boolean;
  role: AnalysisColumnRole;
  sensitivity: AnalysisColumnSensitivity;
  masking: AnalysisColumnMasking;
}>;

export type AnalysisNumberFormat = Readonly<{
  style: "number" | "percent" | "currency" | "duration" | "compact";
  decimals: number;
  currency: string | null;
}>;

export type AnalysisMetric = Readonly<{
  id: string;
  label: string;
  description: string;
  sourceNodeId: string;
  valueColumn: string;
  unit: string;
  lowerIsBetter: boolean | null;
  format: AnalysisNumberFormat;
}>;

export type AnalysisQueryNode = Readonly<{
  id: string;
  title: string;
  connectionRole: string;
  sql: string;
  parameterIds: readonly string[];
  maxRows: number;
  maxBytes: number;
  cacheTtlSeconds: number;
  columns: readonly AnalysisColumn[];
}>;

export type AnalysisTransformNode = Readonly<{
  id: string;
  title: string;
  operation: AnalysisTransformOperation;
  inputNodeIds: readonly string[];
  config: Readonly<Record<string, unknown>>;
  columns: readonly AnalysisColumn[];
}>;

export type AnalysisBlock = Readonly<{
  id: string;
  kind: AnalysisBlockKind;
  title: string;
  sourceNodeId: string | null;
  width: number;
  config: Readonly<Record<string, unknown>>;
}>;

/**
 * Exact, privacy-minimized result schema a block is allowed to retain. Narrative
 * and control blocks retain no rows. Data blocks receive only the columns they
 * render rather than every column produced by their source node.
 */
export function analysisBlockResultColumns(
  definition: AnalysisArticleDefinition,
  block: AnalysisBlock,
): readonly AnalysisColumn[] {
  if (!block.sourceNodeId) return [];
  const node = [...definition.queries, ...definition.transforms]
    .find((candidate) => candidate.id === block.sourceNodeId);
  if (!node) throw new Error("Analysis Article block source is unavailable");
  const config = block.config;
  let names: unknown[];
  if (block.kind === "metric") {
    const metric = definition.metrics.find((candidate) => candidate.id === config.metricId);
    if (!metric || metric.sourceNodeId !== block.sourceNodeId) {
      throw new Error("Analysis Article metric is unavailable");
    }
    names = [
      metric.valueColumn,
      config.comparisonColumn,
      config.sparklineColumn,
      config.sampleCountColumn,
    ];
  } else if (["time_series", "bar", "area", "scatter"].includes(block.kind)) {
    names = [config.xColumn, ...(config.yColumns as unknown[]), config.seriesColumn];
  } else if (block.kind === "table") {
    names = [...(config.columns as unknown[])];
  } else if (block.kind === "funnel") {
    names = [config.stageColumn, config.valueColumn, config.rateColumn];
  } else if (block.kind === "retention_cohort") {
    names = [config.cohortColumn, config.periodColumn, config.valueColumn];
  } else if (block.kind === "heatmap") {
    names = [config.xColumn, config.yColumn, config.valueColumn];
  } else {
    return [];
  }
  const uniqueNames = [...new Set(names.filter((name): name is string => typeof name === "string"))];
  const columns = uniqueNames.map((name) => node.columns.find((column) => column.name === name));
  if (columns.some((column) => !column)) {
    throw new Error("Analysis Article block result schema is stale");
  }
  return columns as AnalysisColumn[];
}

export type AnalysisEvidenceClaim = Readonly<{
  id: string;
  text: string;
  blockIds: readonly string[];
  nodeIds: readonly string[];
}>;

export type AnalysisRefreshPolicy = Readonly<{
  mode: "manual" | "scheduled";
  cron: string | null;
  timezone: string;
  runnerId: string | null;
  maxStalenessSeconds: number;
  resultRetentionDays: number;
  shareReviewedResults: boolean;
}>;

export function nextAnalysisRefreshAt(
  refresh: AnalysisRefreshPolicy,
  after: Date,
): Date | null {
  if (refresh.mode === "manual") return null;
  if (!refresh.cron || Number.isNaN(after.valueOf())) {
    throw new Error("Invalid Analysis Article refresh schedule");
  }
  return CronExpressionParser.parse(refresh.cron, {
    currentDate: after,
    tz: refresh.timezone,
  }).next().toDate();
}

export type AnalysisArticleDefinition = Readonly<{
  version: 1;
  source: AnalysisArticleSource;
  title: string;
  question: string;
  summary: string;
  timezone: string;
  parameters: readonly AnalysisParameter[];
  queries: readonly AnalysisQueryNode[];
  transforms: readonly AnalysisTransformNode[];
  metrics: readonly AnalysisMetric[];
  blocks: readonly AnalysisBlock[];
  claims: readonly AnalysisEvidenceClaim[];
  refresh: AnalysisRefreshPolicy;
  warnings: readonly string[];
}>;

export type SharedAnalysisArticleCreate = Readonly<{
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceKnowledgeGrantId: string | null;
  graphRevisionIds: readonly string[];
  connections: readonly AnalysisArticleConnection[];
  definition: AnalysisArticleDefinition;
}>;

export type AnalysisArticleVersionPayload = SharedAnalysisArticleCreate & Readonly<{
  state: AnalysisArticleState;
  ownerMemberId: string;
  deleted: boolean;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PARAMETER_TOKEN = /\{\{([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/g;
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
    ? record
    : null;
}

function displayText(value: unknown, maxChars: number, allowEmpty = false) {
  if (typeof value !== "string" || UNSAFE_DISPLAY.test(value)) return null;
  const trimmed = value.trim();
  if ((!allowEmpty && trimmed.length === 0) || [...value].length > maxChars) return null;
  return allowEmpty ? value : trimmed;
}

function safeInteger(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum
    ? value
    : null;
}

function id(value: unknown) {
  return typeof value === "string" && ID.test(value) ? value : null;
}

function unique(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function sqlTokens(sql: string) {
  const tokens: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      index = sql.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated Analysis Article SQL comment");
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        if (sql[index] === "\\" && quote !== '"') index += 1;
        index += 1;
      }
      if (!closed) throw new Error("Unterminated Analysis Article SQL string");
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(sql.slice(index))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end < 0) throw new Error("Unterminated Analysis Article SQL string");
        index = end + tag.length;
        continue;
      }
    }
    if (/[A-Za-z_]/u.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(sql.slice(index))![0];
      tokens.push(match.toLowerCase());
      index += match.length;
      continue;
    }
    if (char === ";") tokens.push(";");
    index += 1;
  }
  return tokens;
}

function validateReadOnlySql(sql: string) {
  const tokens = sqlTokens(sql);
  const first = tokens[0];
  if (!first || !["select", "with", "show", "describe", "desc", "explain"].includes(first)
    || tokens.filter((token) => token === ";").length > 1
    || (tokens.includes(";") && tokens.at(-1) !== ";")) {
    throw new Error("Analysis Article source must be one read-only statement");
  }
  const prohibited = new Set([
    "insert", "update", "delete", "merge", "replace", "upsert", "copy", "call", "do",
    "create", "alter", "drop", "truncate", "grant", "revoke", "attach", "detach",
    "vacuum", "analyze", "refresh", "reindex", "cluster", "lock", "set", "reset",
  ]);
  if (tokens.some((token) => prohibited.has(token))) {
    throw new Error("Analysis Article source contains a write or session command");
  }
}

function parseConnection(value: unknown): AnalysisArticleConnection {
  const row = exactRecord(value, ["connectionId", "connectionRevision", "role", "alias"]);
  const revision = safeInteger(row?.connectionRevision, 1, Number.MAX_SAFE_INTEGER);
  const role = id(row?.role);
  const alias = displayText(row?.alias, 128);
  if (!row || typeof row.connectionId !== "string" || !UUID.test(row.connectionId)
    || revision === null || role === null || alias === null) {
    throw new Error("Invalid Analysis Article connection");
  }
  return { connectionId: row.connectionId, connectionRevision: revision, role, alias };
}

function validParameterValue(type: AnalysisParameterType, value: unknown, options: readonly string[]) {
  if (value === null) return true;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeof value !== "string" || value.length > 4_000 || value.includes("\u0000")) return false;
  if (type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (type === "datetime") return !Number.isNaN(Date.parse(value));
  if (type === "enum") return options.includes(value);
  return true;
}

function parseParameter(value: unknown): AnalysisParameter {
  const row = exactRecord(value, ["id", "label", "type", "required", "defaultValue", "options"]);
  const parameterId = id(row?.id);
  const label = displayText(row?.label, 128);
  if (!row || parameterId === null || label === null
    || typeof row.type !== "string"
    || !analysisParameterTypes.includes(row.type as AnalysisParameterType)
    || typeof row.required !== "boolean" || !Array.isArray(row.options)
    || row.options.length > 100
    || row.options.some((option) => displayText(option, 256) === null)
    || !unique(row.options as string[])) {
    throw new Error("Invalid Analysis Article parameter");
  }
  const type = row.type as AnalysisParameterType;
  const options = row.options as string[];
  if ((type === "enum") !== (options.length > 0)
    || !validParameterValue(type, row.defaultValue, options)
    || (row.required && row.defaultValue === null)) {
    throw new Error("Invalid Analysis Article parameter value");
  }
  return {
    id: parameterId,
    label,
    type,
    required: row.required,
    defaultValue: row.defaultValue as AnalysisParameterValue,
    options,
  };
}

function parseColumn(value: unknown): AnalysisColumn {
  const row = exactRecord(value, [
    "name", "type", "nullable", "role", "sensitivity", "masking",
  ]);
  const name = displayText(row?.name, 256);
  if (!row || name === null || typeof row.type !== "string"
    || !analysisColumnTypes.includes(row.type as AnalysisColumnType)
    || typeof row.nullable !== "boolean" || typeof row.role !== "string"
    || !analysisColumnRoles.includes(row.role as AnalysisColumnRole)
    || typeof row.sensitivity !== "string"
    || !analysisColumnSensitivities.includes(row.sensitivity as AnalysisColumnSensitivity)
    || typeof row.masking !== "string"
    || !analysisColumnMasking.includes(row.masking as AnalysisColumnMasking)) {
    throw new Error("Invalid Analysis Article column");
  }
  const role = row.role as AnalysisColumnRole;
  const sensitivity = row.sensitivity as AnalysisColumnSensitivity;
  const masking = row.masking as AnalysisColumnMasking;
  if ((role === "identifier" && !["hash", "redact"].includes(masking))
    || (role === "free_text" && masking !== "redact")
    || (sensitivity === "restricted" && masking !== "redact")
    || (sensitivity === "confidential" && masking === "none")
    || (masking === "hash" && row.type !== "string")) {
    throw new Error("Unsafe Analysis Article column publication policy");
  }
  return {
    name,
    type: row.type as AnalysisColumnType,
    nullable: row.nullable,
    role,
    sensitivity,
    masking,
  };
}

function parseColumns(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw new Error("Invalid Analysis Article columns");
  }
  const columns = value.map(parseColumn);
  if (!unique(columns.map((column) => column.name))) {
    throw new Error("Duplicate Analysis Article column");
  }
  return columns;
}

function parseQuery(value: unknown, parameterIds: ReadonlySet<string>): AnalysisQueryNode {
  const row = exactRecord(value, [
    "id", "title", "connectionRole", "sql", "parameterIds",
    "maxRows", "maxBytes", "cacheTtlSeconds", "columns",
  ]);
  const queryId = id(row?.id);
  const title = displayText(row?.title, 256);
  const connectionRole = id(row?.connectionRole);
  const maxRows = safeInteger(row?.maxRows, 1, 50_000);
  const maxBytes = safeInteger(row?.maxBytes, 1_024, 16 * 1024 * 1024);
  const cacheTtlSeconds = safeInteger(row?.cacheTtlSeconds, 0, 7 * 24 * 60 * 60);
  if (!row || queryId === null || title === null || connectionRole === null
    || typeof row.sql !== "string" || row.sql.trim().length === 0
    || new TextEncoder().encode(row.sql).byteLength > 100_000 || row.sql.includes("\u0000")
    || !Array.isArray(row.parameterIds) || row.parameterIds.length > 32
    || row.parameterIds.some((parameterId) => id(parameterId) === null || !parameterIds.has(parameterId as string))
    || !unique(row.parameterIds as string[]) || maxRows === null || maxBytes === null
    || cacheTtlSeconds === null) {
    throw new Error("Invalid Analysis Article query");
  }
  validateReadOnlySql(row.sql);
  const declaredParameterIds = row.parameterIds as string[];
  const tokens = [...row.sql.matchAll(PARAMETER_TOKEN)].map((match) => match[1]!);
  if (!unique(tokens) || tokens.some((token) => !declaredParameterIds.includes(token))
    || declaredParameterIds.some((parameterId) => !tokens.includes(parameterId))) {
    throw new Error("Analysis Article query parameter tokens do not match parameterIds");
  }
  return {
    id: queryId,
    title,
    connectionRole,
    sql: row.sql,
    parameterIds: declaredParameterIds,
    maxRows,
    maxBytes,
    cacheTtlSeconds,
    columns: parseColumns(row.columns),
  };
}

function stringList(value: unknown, maximum: number, itemMax = 256) {
  if (!Array.isArray(value) || value.length > maximum
    || value.some((item) => displayText(item, itemMax) === null)
    || !unique(value as string[])) return null;
  return value as string[];
}

function parseFormat(value: unknown): AnalysisNumberFormat {
  const row = exactRecord(value, ["style", "decimals", "currency"]);
  const styles = ["number", "percent", "currency", "duration", "compact"];
  if (!row || typeof row.style !== "string" || !styles.includes(row.style)
    || safeInteger(row.decimals, 0, 8) === null
    || !(row.currency === null || (typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency)))
    || ((row.style === "currency") !== (row.currency !== null))) {
    throw new Error("Invalid Analysis Article number format");
  }
  return {
    style: row.style as AnalysisNumberFormat["style"],
    decimals: row.decimals as number,
    currency: row.currency as string | null,
  };
}

function parseMetric(value: unknown): AnalysisMetric {
  const row = exactRecord(value, [
    "id", "label", "description", "sourceNodeId", "valueColumn",
    "unit", "lowerIsBetter", "format",
  ]);
  const metricId = id(row?.id);
  const label = displayText(row?.label, 256);
  const description = displayText(row?.description, 4_000, true);
  const sourceNodeId = id(row?.sourceNodeId);
  const valueColumn = displayText(row?.valueColumn, 256);
  const unit = displayText(row?.unit, 64, true);
  if (!row || metricId === null || label === null || description === null
    || sourceNodeId === null || valueColumn === null || unit === null
    || !(row.lowerIsBetter === null || typeof row.lowerIsBetter === "boolean")) {
    throw new Error("Invalid Analysis Article metric");
  }
  return {
    id: metricId,
    label,
    description,
    sourceNodeId,
    valueColumn,
    unit,
    lowerIsBetter: row.lowerIsBetter as boolean | null,
    format: parseFormat(row.format),
  };
}

function parseTransformConfig(operation: AnalysisTransformOperation, value: unknown) {
  switch (operation) {
    case "project": {
      const row = exactRecord(value, ["columns"]);
      const columns = stringList(row?.columns, 256);
      if (!row || !columns?.length) throw new Error("Invalid project transform");
      return { columns };
    }
    case "filter": {
      const row = exactRecord(value, ["column", "operator", "value"]);
      const operators = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null"];
      if (!row || displayText(row.column, 256) === null || typeof row.operator !== "string"
        || !operators.includes(row.operator)
        || !(row.value === null || typeof row.value === "string" || typeof row.value === "number" || typeof row.value === "boolean" || Array.isArray(row.value))) {
        throw new Error("Invalid filter transform");
      }
      return { column: row.column, operator: row.operator, value: row.value };
    }
    case "sort": {
      const row = exactRecord(value, ["columns"]);
      if (!row || !Array.isArray(row.columns) || row.columns.length < 1 || row.columns.length > 32) {
        throw new Error("Invalid sort transform");
      }
      const columns = row.columns.map((entry) => {
        const item = exactRecord(entry, ["column", "direction"]);
        if (!item || displayText(item.column, 256) === null
          || !(item.direction === "asc" || item.direction === "desc")) {
          throw new Error("Invalid sort column");
        }
        return { column: item.column as string, direction: item.direction };
      });
      return { columns };
    }
    case "limit": {
      const row = exactRecord(value, ["count"]);
      const count = safeInteger(row?.count, 1, 50_000);
      if (!row || count === null) throw new Error("Invalid limit transform");
      return { count };
    }
    case "union": {
      const row = exactRecord(value, ["all", "mappingProposalId"]);
      if (!row || typeof row.all !== "boolean" || typeof row.mappingProposalId !== "string"
        || !UUID.test(row.mappingProposalId)) throw new Error("Invalid union transform");
      return { all: row.all, mappingProposalId: row.mappingProposalId };
    }
    case "group": {
      const row = exactRecord(value, ["columns"]);
      const columns = stringList(row?.columns, 32);
      if (!row || !columns?.length) throw new Error("Invalid group transform");
      return { columns };
    }
    case "aggregate": {
      const row = exactRecord(value, ["groupBy", "measures"]);
      const groupBy = stringList(row?.groupBy, 32);
      if (!row || groupBy === null || !Array.isArray(row.measures)
        || row.measures.length < 1 || row.measures.length > 64) throw new Error("Invalid aggregate transform");
      const functions = ["count", "count_distinct", "sum", "avg", "min", "max"];
      const measures = row.measures.map((entry) => {
        const item = exactRecord(entry, ["column", "function", "as"]);
        if (!item || displayText(item.column, 256) === null || typeof item.function !== "string"
          || !functions.includes(item.function) || id(item.as) === null) {
          throw new Error("Invalid aggregate measure");
        }
        return { column: item.column as string, function: item.function, as: item.as as string };
      });
      return { groupBy, measures };
    }
    case "inner_join":
    case "left_join": {
      const row = exactRecord(value, ["mappingProposalId", "keys"]);
      if (!row || typeof row.mappingProposalId !== "string" || !UUID.test(row.mappingProposalId)
        || !Array.isArray(row.keys) || row.keys.length < 1 || row.keys.length > 16) {
        throw new Error("Invalid join transform");
      }
      const keys = row.keys.map((entry) => {
        const item = exactRecord(entry, ["left", "right"]);
        if (!item || displayText(item.left, 256) === null || displayText(item.right, 256) === null) {
          throw new Error("Invalid join key");
        }
        return { left: item.left as string, right: item.right as string };
      });
      return { mappingProposalId: row.mappingProposalId, keys };
    }
    case "window": {
      const row = exactRecord(value, ["partitionBy", "orderBy", "measures"]);
      const partitionBy = stringList(row?.partitionBy, 16);
      if (!row || partitionBy === null || displayText(row.orderBy, 256) === null
        || !Array.isArray(row.measures) || row.measures.length < 1 || row.measures.length > 32) {
        throw new Error("Invalid window transform");
      }
      const functions = ["row_number", "rank", "dense_rank", "running_sum", "running_avg"];
      const measures = row.measures.map((entry) => {
        const item = exactRecord(entry, ["column", "function", "as"]);
        if (!item || !(item.column === null || displayText(item.column, 256) !== null)
          || typeof item.function !== "string" || !functions.includes(item.function)
          || id(item.as) === null) throw new Error("Invalid window measure");
        return { column: item.column as string | null, function: item.function, as: item.as as string };
      });
      return { partitionBy, orderBy: row.orderBy, measures };
    }
    case "lag": {
      const row = exactRecord(value, ["column", "offset", "partitionBy", "orderBy", "as"]);
      const partitionBy = stringList(row?.partitionBy, 16);
      const offset = safeInteger(row?.offset, 1, 1_000);
      if (!row || displayText(row.column, 256) === null || offset === null || partitionBy === null
        || displayText(row.orderBy, 256) === null || id(row.as) === null) throw new Error("Invalid lag transform");
      return { column: row.column, offset, partitionBy, orderBy: row.orderBy, as: row.as };
    }
    case "ratio":
    case "difference":
    case "rate": {
      const row = exactRecord(value, ["numerator", "denominator", "as"]);
      if (!row || displayText(row.numerator, 256) === null
        || displayText(row.denominator, 256) === null || id(row.as) === null) {
        throw new Error(`Invalid ${operation} transform`);
      }
      return { numerator: row.numerator, denominator: row.denominator, as: row.as };
    }
    case "cohort": {
      const row = exactRecord(value, ["entityColumn", "eventTimeColumn", "cohortUnit", "as"]);
      if (!row || displayText(row.entityColumn, 256) === null
        || displayText(row.eventTimeColumn, 256) === null
        || !["day", "week", "month"].includes(String(row.cohortUnit)) || id(row.as) === null) {
        throw new Error("Invalid cohort transform");
      }
      return { entityColumn: row.entityColumn, eventTimeColumn: row.eventTimeColumn, cohortUnit: row.cohortUnit, as: row.as };
    }
    case "retention": {
      const row = exactRecord(value, ["entityColumn", "cohortColumn", "eventTimeColumn", "periodUnit", "periods", "as"]);
      const periods = safeInteger(row?.periods, 1, 365);
      if (!row || displayText(row.entityColumn, 256) === null
        || displayText(row.cohortColumn, 256) === null || displayText(row.eventTimeColumn, 256) === null
        || !["day", "week", "month"].includes(String(row.periodUnit)) || periods === null
        || id(row.as) === null) throw new Error("Invalid retention transform");
      return { entityColumn: row.entityColumn, cohortColumn: row.cohortColumn, eventTimeColumn: row.eventTimeColumn, periodUnit: row.periodUnit, periods, as: row.as };
    }
  }
}

function transformArity(operation: AnalysisTransformOperation) {
  return ["inner_join", "left_join", "union"].includes(operation) ? 2 : 1;
}

function parseTransform(value: unknown): AnalysisTransformNode {
  const row = exactRecord(value, ["id", "title", "operation", "inputNodeIds", "config", "columns"]);
  const transformId = id(row?.id);
  const title = displayText(row?.title, 256);
  if (!row || transformId === null || title === null || typeof row.operation !== "string"
    || !analysisTransformOperations.includes(row.operation as AnalysisTransformOperation)
    || !Array.isArray(row.inputNodeIds) || !unique(row.inputNodeIds as string[])
    || row.inputNodeIds.some((nodeId) => id(nodeId) === null)) {
    throw new Error("Invalid Analysis Article transform");
  }
  const operation = row.operation as AnalysisTransformOperation;
  if (row.inputNodeIds.length !== transformArity(operation)) {
    throw new Error("Invalid Analysis Article transform arity");
  }
  return {
    id: transformId,
    title,
    operation,
    inputNodeIds: row.inputNodeIds as string[],
    config: parseTransformConfig(operation, row.config),
    columns: parseColumns(row.columns),
  };
}

function chartConfig(value: unknown, scatter = false) {
  const fields = scatter
    ? ["xColumn", "yColumns", "seriesColumn", "stacked", "format"]
    : ["xColumn", "yColumns", "seriesColumn", "stacked", "format"];
  const row = exactRecord(value, fields);
  const yColumns = stringList(row?.yColumns, 12);
  if (!row || displayText(row.xColumn, 256) === null || !yColumns?.length
    || !(row.seriesColumn === null || displayText(row.seriesColumn, 256) !== null)
    || typeof row.stacked !== "boolean" || (scatter && row.stacked)) {
    throw new Error("Invalid Analysis Article chart config");
  }
  return {
    xColumn: row.xColumn,
    yColumns,
    seriesColumn: row.seriesColumn,
    stacked: row.stacked,
    format: parseFormat(row.format),
  };
}

function parseBlockConfig(kind: AnalysisBlockKind, value: unknown) {
  if (kind === "heading") {
    const row = exactRecord(value, ["level", "text"]);
    const level = safeInteger(row?.level, 1, 3);
    const text = displayText(row?.text, 1_000);
    if (!row || level === null || text === null) throw new Error("Invalid heading block");
    return { level, text };
  }
  if (kind === "markdown") {
    const row = exactRecord(value, ["markdown"]);
    const markdown = displayText(row?.markdown, 100_000, true);
    if (!row || markdown === null) throw new Error("Invalid Markdown block");
    return { markdown };
  }
  if (kind === "callout") {
    const row = exactRecord(value, ["tone", "markdown"]);
    const markdown = displayText(row?.markdown, 32_000);
    if (!row || !["info", "success", "warning", "danger"].includes(String(row.tone))
      || markdown === null) throw new Error("Invalid callout block");
    return { tone: row.tone, markdown };
  }
  if (kind === "divider") {
    const row = exactRecord(value, []);
    if (!row) throw new Error("Invalid divider block");
    return {};
  }
  if (kind === "metric") {
    const row = exactRecord(value, [
      "metricId", "comparisonColumn", "sparklineColumn", "sampleCountColumn",
    ]);
    if (!row || id(row.metricId) === null
      || !(row.comparisonColumn === null || displayText(row.comparisonColumn, 256) !== null)
      || !(row.sparklineColumn === null || displayText(row.sparklineColumn, 256) !== null)
      || !(row.sampleCountColumn === null || displayText(row.sampleCountColumn, 256) !== null)) {
      throw new Error("Invalid metric block");
    }
    return {
      metricId: row.metricId,
      comparisonColumn: row.comparisonColumn,
      sparklineColumn: row.sparklineColumn,
      sampleCountColumn: row.sampleCountColumn,
    };
  }
  if (["time_series", "bar", "area", "scatter"].includes(kind)) {
    return chartConfig(value, kind === "scatter");
  }
  if (kind === "table") {
    const row = exactRecord(value, ["columns", "pageSize"]);
    const columns = stringList(row?.columns, 64);
    const pageSize = safeInteger(row?.pageSize, 10, 500);
    if (!row || !columns?.length || pageSize === null) throw new Error("Invalid table block");
    return { columns, pageSize };
  }
  if (kind === "funnel") {
    const row = exactRecord(value, ["stageColumn", "valueColumn", "rateColumn", "format"]);
    if (!row || displayText(row.stageColumn, 256) === null || displayText(row.valueColumn, 256) === null
      || !(row.rateColumn === null || displayText(row.rateColumn, 256) !== null)) throw new Error("Invalid funnel block");
    return { stageColumn: row.stageColumn, valueColumn: row.valueColumn, rateColumn: row.rateColumn, format: parseFormat(row.format) };
  }
  if (kind === "retention_cohort") {
    const row = exactRecord(value, ["cohortColumn", "periodColumn", "valueColumn", "format"]);
    if (!row || displayText(row.cohortColumn, 256) === null || displayText(row.periodColumn, 256) === null
      || displayText(row.valueColumn, 256) === null) throw new Error("Invalid retention block");
    return { cohortColumn: row.cohortColumn, periodColumn: row.periodColumn, valueColumn: row.valueColumn, format: parseFormat(row.format) };
  }
  if (kind === "heatmap") {
    const row = exactRecord(value, ["xColumn", "yColumn", "valueColumn", "format"]);
    if (!row || displayText(row.xColumn, 256) === null || displayText(row.yColumn, 256) === null
      || displayText(row.valueColumn, 256) === null) throw new Error("Invalid heatmap block");
    return { xColumn: row.xColumn, yColumn: row.yColumn, valueColumn: row.valueColumn, format: parseFormat(row.format) };
  }
  const row = exactRecord(value, ["parameterIds"]);
  const parameterIds = stringList(row?.parameterIds, kind === "date_range_control" ? 2 : 1, 64);
  if (!row || !parameterIds?.length || (kind === "date_range_control" && parameterIds.length !== 2)) {
    throw new Error("Invalid Analysis Article control block");
  }
  return { parameterIds };
}

function parseBlock(value: unknown): AnalysisBlock {
  const row = exactRecord(value, ["id", "kind", "title", "sourceNodeId", "width", "config"]);
  const blockId = id(row?.id);
  const title = displayText(row?.title, 256, true);
  const width = safeInteger(row?.width, 1, 12);
  if (!row || blockId === null || title === null || width === null
    || typeof row.kind !== "string" || !analysisBlockKinds.includes(row.kind as AnalysisBlockKind)
    || !(row.sourceNodeId === null || id(row.sourceNodeId) !== null)) {
    throw new Error("Invalid Analysis Article block");
  }
  const kind = row.kind as AnalysisBlockKind;
  const sourceRequired = ["metric", "time_series", "bar", "area", "scatter", "table", "funnel", "retention_cohort", "heatmap"].includes(kind);
  if (sourceRequired !== (row.sourceNodeId !== null)) {
    throw new Error("Analysis Article block source is inconsistent with its kind");
  }
  return {
    id: blockId,
    kind,
    title,
    sourceNodeId: row.sourceNodeId as string | null,
    width,
    config: parseBlockConfig(kind, row.config),
  };
}

function parseClaim(value: unknown): AnalysisEvidenceClaim {
  const row = exactRecord(value, ["id", "text", "blockIds", "nodeIds"]);
  const claimId = id(row?.id);
  const text = displayText(row?.text, 8_000);
  const blockIds = stringList(row?.blockIds, 64, 64);
  const nodeIds = stringList(row?.nodeIds, 64, 64);
  if (!row || claimId === null || text === null || blockIds === null || nodeIds === null
    || (blockIds.length === 0 && nodeIds.length === 0)) throw new Error("Invalid Analysis Article claim");
  return { id: claimId, text, blockIds, nodeIds };
}

function parseRefresh(value: unknown): AnalysisRefreshPolicy {
  const row = exactRecord(value, [
    "mode", "cron", "timezone", "runnerId", "maxStalenessSeconds",
    "resultRetentionDays", "shareReviewedResults",
  ]);
  const timezone = displayText(row?.timezone, 128);
  const maxStalenessSeconds = safeInteger(row?.maxStalenessSeconds, 60, 31_622_400);
  const resultRetentionDays = safeInteger(row?.resultRetentionDays, 1, 365);
  if (!row || !(row.mode === "manual" || row.mode === "scheduled") || timezone === null
    || maxStalenessSeconds === null || resultRetentionDays === null
    || typeof row.shareReviewedResults !== "boolean"
    || !(row.runnerId === null || (typeof row.runnerId === "string" && UUID.test(row.runnerId)))
    || !(row.cron === null || displayText(row.cron, 128) !== null)
    || (row.mode === "manual" && (row.cron !== null || row.runnerId !== null))
    || (row.mode === "scheduled" && (row.cron === null || row.runnerId === null))) {
    throw new Error("Invalid Analysis Article refresh policy");
  }
  const cron = row.cron as string | null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    if (cron !== null) {
      const fields = cron.trim().split(/\s+/u);
      const minuteStep = /^\*\/(\d+)$/.exec(fields[0] ?? "");
      if (fields.length !== 5 || fields.some((field) => !/^[0-9*/?,\-]+$/.test(field))
        || (minuteStep !== null && Number(minuteStep[1]) < 5)) {
        throw new Error("Invalid schedule");
      }
      CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone }).next();
    }
  } catch {
    throw new Error("Invalid Analysis Article refresh schedule");
  }
  return {
    mode: row.mode,
    cron,
    timezone,
    runnerId: row.runnerId as string | null,
    maxStalenessSeconds,
    resultRetentionDays,
    shareReviewedResults: row.shareReviewedResults,
  };
}

function sourceRolesForNode(
  nodeId: string,
  queries: ReadonlyMap<string, AnalysisQueryNode>,
  transforms: ReadonlyMap<string, AnalysisTransformNode>,
  memo: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const cached = memo.get(nodeId);
  if (cached) return cached;
  const query = queries.get(nodeId);
  if (query) {
    const roles = new Set([query.connectionRole]);
    memo.set(nodeId, roles);
    return roles;
  }
  const transform = transforms.get(nodeId);
  if (!transform) return new Set();
  const roles = new Set<string>();
  memo.set(nodeId, roles);
  for (const inputId of transform.inputNodeIds) {
    for (const role of sourceRolesForNode(inputId, queries, transforms, memo)) roles.add(role);
  }
  return roles;
}

function sameColumn(left: AnalysisColumn, right: AnalysisColumn) {
  return left.name === right.name && left.type === right.type && left.nullable === right.nullable
    && left.role === right.role && left.sensitivity === right.sensitivity
    && left.masking === right.masking;
}

function sameSchema(left: readonly AnalysisColumn[], right: readonly AnalysisColumn[]) {
  return left.length === right.length && left.every((column, index) => sameColumn(column, right[index]!));
}

function columnByName(columns: readonly AnalysisColumn[], name: unknown) {
  return typeof name === "string" ? columns.find((column) => column.name === name) : undefined;
}

function exactProjectedSchema(
  input: readonly AnalysisColumn[],
  output: readonly AnalysisColumn[],
  names: readonly string[],
) {
  const expected = names.map((name) => columnByName(input, name));
  return expected.every(Boolean)
    && sameSchema(expected as AnalysisColumn[], output);
}

function inheritedColumnsRemainExact(
  input: readonly AnalysisColumn[],
  output: readonly AnalysisColumn[],
) {
  return input.every((column) => {
    const inherited = columnByName(output, column.name);
    return inherited ? sameColumn(column, inherited) : false;
  });
}

function validateTransformSchema(
  transform: AnalysisTransformNode,
  inputs: readonly (readonly AnalysisColumn[])[],
) {
  const first = inputs[0]!;
  const config = transform.config;
  const fail = () => {
    throw new Error(`Analysis Article transform schema is invalid: ${transform.title}`);
  };
  if (["filter", "sort", "limit"].includes(transform.operation)) {
    if (!sameSchema(first, transform.columns)) fail();
    if (transform.operation === "filter" && !columnByName(first, config.column)) fail();
    if (transform.operation === "sort") {
      const items = config.columns as readonly { column: string }[];
      if (items.some((item) => !columnByName(first, item.column))) fail();
    }
    return;
  }
  if (transform.operation === "project" || transform.operation === "group") {
    if (!exactProjectedSchema(first, transform.columns, config.columns as string[])) fail();
    return;
  }
  if (transform.operation === "union") {
    if (!sameSchema(first, inputs[1]!) || !sameSchema(first, transform.columns)) fail();
    return;
  }
  if (transform.operation === "inner_join" || transform.operation === "left_join") {
    const second = inputs[1]!;
    const keys = config.keys as readonly { left: string; right: string }[];
    if (keys.some((key) => !columnByName(first, key.left) || !columnByName(second, key.right))) fail();
    const combined = [...first, ...second];
    if (!unique(combined.map((column) => column.name)) || !sameSchema(combined, transform.columns)) fail();
    return;
  }
  if (transform.operation === "aggregate") {
    const groupBy = config.groupBy as string[];
    const measures = config.measures as readonly { column: string; function: string; as: string }[];
    if (!exactProjectedSchema(first, transform.columns.slice(0, groupBy.length), groupBy)
      || transform.columns.length !== groupBy.length + measures.length) fail();
    measures.forEach((measure, index) => {
      const source = columnByName(first, measure.column);
      const output = transform.columns[groupBy.length + index];
      if (!source || !output || output.name !== measure.as || output.role !== "measure"
        || !["number", "duration", "currency", "percent"].includes(output.type)
        || (measure.function !== "count" && measure.function !== "count_distinct"
          && !["number", "duration", "currency", "percent"].includes(source.type))) fail();
    });
    return;
  }
  if (!inheritedColumnsRemainExact(first, transform.columns)) fail();
  if (transform.operation === "window") {
    if (!columnByName(first, config.orderBy)
      || (config.partitionBy as string[]).some((name) => !columnByName(first, name))) fail();
    for (const measure of config.measures as readonly { column: string | null; as: string }[]) {
      if ((measure.column !== null && !columnByName(first, measure.column))
        || !columnByName(transform.columns, measure.as)) fail();
    }
    return;
  }
  if (transform.operation === "lag") {
    if (!columnByName(first, config.column) || !columnByName(first, config.orderBy)
      || (config.partitionBy as string[]).some((name) => !columnByName(first, name))
      || !columnByName(transform.columns, config.as)) fail();
    return;
  }
  if (["ratio", "difference", "rate"].includes(transform.operation)) {
    if (!columnByName(first, config.numerator) || !columnByName(first, config.denominator)
      || !columnByName(transform.columns, config.as)) fail();
    return;
  }
  if (transform.operation === "cohort") {
    if (!columnByName(first, config.entityColumn) || !columnByName(first, config.eventTimeColumn)
      || !columnByName(transform.columns, config.as)) fail();
    return;
  }
  if (transform.operation === "retention") {
    if (!columnByName(first, config.entityColumn) || !columnByName(first, config.cohortColumn)
      || !columnByName(first, config.eventTimeColumn) || !columnByName(transform.columns, config.as)) fail();
  }
}

function validateBlockSchema(
  block: AnalysisBlock,
  columns: readonly AnalysisColumn[] | undefined,
) {
  if (!block.sourceNodeId || !columns) return;
  const config = block.config;
  const required: unknown[] = [];
  if (["time_series", "bar", "area", "scatter"].includes(block.kind)) {
    required.push(config.xColumn, ...(config.yColumns as unknown[]));
    if (config.seriesColumn !== null) required.push(config.seriesColumn);
  } else if (block.kind === "table") {
    required.push(...(config.columns as unknown[]));
  } else if (block.kind === "funnel") {
    required.push(config.stageColumn, config.valueColumn);
    if (config.rateColumn !== null) required.push(config.rateColumn);
  } else if (block.kind === "retention_cohort") {
    required.push(config.cohortColumn, config.periodColumn, config.valueColumn);
  } else if (block.kind === "heatmap") {
    required.push(config.xColumn, config.yColumn, config.valueColumn);
  } else if (block.kind === "metric") {
    if (config.comparisonColumn !== null) required.push(config.comparisonColumn);
    if (config.sparklineColumn !== null) required.push(config.sparklineColumn);
    if (config.sampleCountColumn !== null) required.push(config.sampleCountColumn);
  }
  if (required.some((name) => !columnByName(columns, name))) {
    throw new Error(`Analysis Article block column is invalid: ${block.title}`);
  }
}

function parseDefinition(value: unknown, connectionRoles: ReadonlySet<string>): AnalysisArticleDefinition {
  const row = exactRecord(value, [
    "version", "source", "title", "question", "summary", "timezone", "parameters",
    "queries", "transforms", "metrics", "blocks", "claims", "refresh", "warnings",
  ]);
  const title = displayText(row?.title, 160);
  const question = displayText(row?.question, 8_000, true);
  const summary = displayText(row?.summary, 20_000, true);
  const timezone = displayText(row?.timezone, 128);
  if (!row || row.version !== 1 || typeof row.source !== "string"
    || !analysisArticleSources.includes(row.source as AnalysisArticleSource)
    || title === null || question === null || summary === null || timezone === null
    || !Array.isArray(row.parameters) || row.parameters.length > 32
    || !Array.isArray(row.queries) || row.queries.length < 1 || row.queries.length > 64
    || !Array.isArray(row.transforms) || row.transforms.length > 128
    || !Array.isArray(row.metrics) || row.metrics.length > 128
    || !Array.isArray(row.blocks) || row.blocks.length < 1 || row.blocks.length > 128
    || !Array.isArray(row.claims) || row.claims.length > 128
    || !Array.isArray(row.warnings) || row.warnings.length > 64) {
    throw new Error("Invalid Analysis Article definition");
  }
  const parameters = row.parameters.map(parseParameter);
  if (!unique(parameters.map((parameter) => parameter.id))) throw new Error("Duplicate Analysis Article parameter");
  const parameterIds = new Set(parameters.map((parameter) => parameter.id));
  const queries = row.queries.map((query) => parseQuery(query, parameterIds));
  const transforms = row.transforms.map(parseTransform);
  const nodeIds = [...queries.map((query) => query.id), ...transforms.map((transform) => transform.id)];
  if (!unique(nodeIds) || queries.some((query) => !connectionRoles.has(query.connectionRole))) {
    throw new Error("Invalid Analysis Article query authority");
  }
  const known = new Set(queries.map((query) => query.id));
  for (const transform of transforms) {
    if (transform.inputNodeIds.some((inputId) => !known.has(inputId))) {
      throw new Error("Analysis Article transforms must be topologically ordered");
    }
    const available = new Map<string, readonly AnalysisColumn[]>([
      ...queries.map((query) => [query.id, query.columns] as const),
      ...transforms.filter((candidate) => known.has(candidate.id))
        .map((candidate) => [candidate.id, candidate.columns] as const),
    ]);
    validateTransformSchema(
      transform,
      transform.inputNodeIds.map((inputId) => available.get(inputId)!),
    );
    known.add(transform.id);
  }
  const queryById = new Map(queries.map((query) => [query.id, query]));
  const transformById = new Map(transforms.map((transform) => [transform.id, transform]));
  const roleMemo = new Map<string, ReadonlySet<string>>();
  for (const transform of transforms) {
    const roles = sourceRolesForNode(transform.id, queryById, transformById, roleMemo);
    if (roles.size > 1 && !["inner_join", "left_join", "union"].includes(transform.operation)) {
      throw new Error("Cross-connection data may only meet in an approved join or union");
    }
  }
  const metrics = row.metrics.map(parseMetric);
  if (!unique(metrics.map((metric) => metric.id))) {
    throw new Error("Duplicate Analysis Article metric");
  }
  const columnsByNode = new Map<string, readonly AnalysisColumn[]>([
    ...queries.map((query) => [query.id, query.columns] as const),
    ...transforms.map((transform) => [transform.id, transform.columns] as const),
  ]);
  for (const metric of metrics) {
    const column = columnsByNode.get(metric.sourceNodeId)
      ?.find((candidate) => candidate.name === metric.valueColumn);
    if (!column || !["number", "duration", "currency", "percent"].includes(column.type)
      || column.role !== "measure") {
      throw new Error("Analysis Article metric must reference a numeric measure");
    }
  }
  const blocks = row.blocks.map(parseBlock);
  if (!unique(blocks.map((block) => block.id))
    || blocks.some((block) => block.sourceNodeId !== null && !known.has(block.sourceNodeId))) {
    throw new Error("Invalid Analysis Article block reference");
  }
  const blockIds = new Set(blocks.map((block) => block.id));
  for (const block of blocks) {
    validateBlockSchema(
      block,
      block.sourceNodeId ? columnsByNode.get(block.sourceNodeId) : undefined,
    );
    if (block.kind === "metric") {
      const metric = metrics.find((candidate) => candidate.id === block.config.metricId);
      if (!metric || metric.sourceNodeId !== block.sourceNodeId) {
        throw new Error("Analysis Article metric block references an incompatible metric");
      }
    }
    if (!["date_range_control", "comparison_control", "segment_control"].includes(block.kind)) continue;
    const config = block.config as { parameterIds: readonly string[] };
    if (config.parameterIds.some((parameterId) => !parameterIds.has(parameterId))) {
      throw new Error("Analysis Article control references an unknown parameter");
    }
  }
  const claims = row.claims.map(parseClaim);
  if (!unique(claims.map((claim) => claim.id))
    || claims.some((claim) => claim.blockIds.some((blockId) => !blockIds.has(blockId))
      || claim.nodeIds.some((nodeId) => !known.has(nodeId)))) {
    throw new Error("Invalid Analysis Article claim reference");
  }
  const warnings = row.warnings.map((warning) => displayText(warning, 2_000));
  if (warnings.some((warning) => warning === null)) throw new Error("Invalid Analysis Article warning");
  return {
    version: 1,
    source: row.source as AnalysisArticleSource,
    title,
    question,
    summary,
    timezone,
    parameters,
    queries,
    transforms,
    metrics,
    blocks,
    claims,
    refresh: parseRefresh(row.refresh),
    warnings: warnings as string[],
  };
}

export function parseSharedAnalysisArticleCreate(value: unknown): SharedAnalysisArticleCreate {
  const row = exactRecord(value, [
    "id", "projectEnvironmentId", "environmentRevision", "sourceKnowledgeGrantId",
    "graphRevisionIds", "connections", "definition",
  ]);
  const environmentRevision = safeInteger(row?.environmentRevision, 1, Number.MAX_SAFE_INTEGER);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || typeof row.projectEnvironmentId !== "string" || !UUID.test(row.projectEnvironmentId)
    || environmentRevision === null
    || !(row.sourceKnowledgeGrantId === null
      || (typeof row.sourceKnowledgeGrantId === "string" && UUID.test(row.sourceKnowledgeGrantId)))
    || !Array.isArray(row.graphRevisionIds) || row.graphRevisionIds.length > 32
    || row.graphRevisionIds.some((revisionId) => typeof revisionId !== "string" || !UUID.test(revisionId))
    || !unique(row.graphRevisionIds as string[])
    || !Array.isArray(row.connections) || row.connections.length < 1 || row.connections.length > 32) {
    throw new Error("Invalid Analysis Article authority");
  }
  const connections = row.connections.map(parseConnection);
  if (!unique(connections.map((connection) => connection.connectionId))
    || !unique(connections.map((connection) => connection.role))) {
    throw new Error("Duplicate Analysis Article connection authority");
  }
  if ((row.sourceKnowledgeGrantId === null) !== (row.graphRevisionIds.length === 0)) {
    throw new Error("Analysis Article knowledge authority is incomplete");
  }
  return {
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision,
    sourceKnowledgeGrantId: row.sourceKnowledgeGrantId as string | null,
    graphRevisionIds: row.graphRevisionIds as string[],
    connections,
    definition: parseDefinition(
      row.definition,
      new Set(connections.map((connection) => connection.role)),
    ),
  };
}

export function isAnalysisArticleState(value: unknown): value is AnalysisArticleState {
  return typeof value === "string"
    && analysisArticleStates.includes(value as AnalysisArticleState);
}

export function analysisArticleVersionPayload(input: SharedAnalysisArticleCreate & {
  state: AnalysisArticleState;
  ownerMemberId: string;
  deleted?: boolean;
}): AnalysisArticleVersionPayload {
  const parsed = parseSharedAnalysisArticleCreate(input);
  if (!isAnalysisArticleState(input.state) || !input.ownerMemberId) {
    throw new Error("Invalid Analysis Article version authority");
  }
  return {
    ...parsed,
    state: input.state,
    ownerMemberId: input.ownerMemberId,
    deleted: input.deleted ?? false,
  };
}

export function parseAnalysisArticleVersionPayload(value: unknown): AnalysisArticleVersionPayload {
  const row = exactRecord(value, [
    "id", "projectEnvironmentId", "environmentRevision", "sourceKnowledgeGrantId",
    "graphRevisionIds", "connections", "definition", "state", "ownerMemberId", "deleted",
  ]);
  if (!row || !isAnalysisArticleState(row.state) || typeof row.ownerMemberId !== "string"
    || row.ownerMemberId.length === 0 || typeof row.deleted !== "boolean") {
    throw new Error("Invalid Analysis Article revision payload");
  }
  const article = parseSharedAnalysisArticleCreate({
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision: row.environmentRevision,
    sourceKnowledgeGrantId: row.sourceKnowledgeGrantId,
    graphRevisionIds: row.graphRevisionIds,
    connections: row.connections,
    definition: row.definition,
  });
  return {
    ...article,
    state: row.state,
    ownerMemberId: row.ownerMemberId,
    deleted: row.deleted,
  };
}

export function publicAnalysisArticle(row: {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceKnowledgeGrantId: string | null;
  graphRevisionIds: readonly string[];
  connections: readonly AnalysisArticleConnection[];
  definition: unknown;
  state: string;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  liveRevision: number | null;
  liveRunId: string | null;
  nextRefreshAt: Date | null;
  latestSuccessfulRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const parsed = parseSharedAnalysisArticleCreate({
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision: row.environmentRevision,
    sourceKnowledgeGrantId: row.sourceKnowledgeGrantId,
    graphRevisionIds: row.graphRevisionIds,
    connections: row.connections,
    definition: row.definition,
  });
  if (!isAnalysisArticleState(row.state) || !row.ownerMemberId || !row.updatedByMemberId
    || safeInteger(row.revision, 1, Number.MAX_SAFE_INTEGER) === null
    || !(row.liveRevision === null
      || (safeInteger(row.liveRevision, 1, row.revision) !== null))
    || !(row.liveRunId === null || UUID.test(row.liveRunId))
    || !(row.nextRefreshAt === null || (row.nextRefreshAt instanceof Date
      && !Number.isNaN(row.nextRefreshAt.valueOf())))
    || !(row.latestSuccessfulRunId === null || UUID.test(row.latestSuccessfulRunId))
    || Number.isNaN(row.createdAt.valueOf()) || Number.isNaN(row.updatedAt.valueOf())) {
    throw new Error("Invalid stored Analysis Article");
  }
  return {
    ...parsed,
    state: row.state,
    ownerMemberId: row.ownerMemberId,
    updatedByMemberId: row.updatedByMemberId,
    revision: row.revision,
    liveRevision: row.liveRevision,
    liveRunId: row.liveRunId,
    nextRefreshAt: row.nextRefreshAt?.toISOString() ?? null,
    latestSuccessfulRunId: row.latestSuccessfulRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
