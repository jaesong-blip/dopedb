// Runtime-neutral, credential-free contract for shared Analysis Articles.
//
// Current Articles are sanitized HTML plus one bounded read. Version-1 graph
// definitions are accepted only long enough to project them into that simple
// contract; Desktop remains the only database execution plane.
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
  version: 2;
  source: AnalysisArticleSource;
  title: string;
  html: string;
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
