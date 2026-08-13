export const analysisArticleStates = ["draft", "review", "live", "archived"] as const;
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
export type AnalysisArticleSource =
  | "human"
  | "dopedb.acp.claude"
  | "dopedb.acp.codex"
  | "migration";
export type AnalysisParameterType = (typeof analysisParameterTypes)[number];
export type AnalysisColumnType = (typeof analysisColumnTypes)[number];
export type AnalysisColumnRole = (typeof analysisColumnRoles)[number];
export type AnalysisColumnSensitivity = (typeof analysisColumnSensitivities)[number];
export type AnalysisColumnMasking = (typeof analysisColumnMasking)[number];
export type AnalysisTransformOperation = (typeof analysisTransformOperations)[number];
export type AnalysisBlockKind = (typeof analysisBlockKinds)[number];
export type AnalysisParameterValue = string | number | boolean | null;

export type AnalysisArticleConnection = {
  connectionId: string;
  connectionRevision: number;
  role: string;
  alias: string;
};

export type AnalysisParameter = {
  id: string;
  label: string;
  type: AnalysisParameterType;
  required: boolean;
  defaultValue: AnalysisParameterValue;
  options: string[];
};

export type AnalysisColumn = {
  name: string;
  type: AnalysisColumnType;
  nullable: boolean;
  role: AnalysisColumnRole;
  sensitivity: AnalysisColumnSensitivity;
  masking: AnalysisColumnMasking;
};

export type AnalysisNumberFormat = {
  style: "number" | "percent" | "currency" | "duration" | "compact";
  decimals: number;
  currency: string | null;
};

export type AnalysisMetric = {
  id: string;
  label: string;
  description: string;
  sourceNodeId: string;
  valueColumn: string;
  unit: string;
  lowerIsBetter: boolean | null;
  format: AnalysisNumberFormat;
};

export type AnalysisQueryNode = {
  id: string;
  title: string;
  connectionRole: string;
  sql: string;
  parameterIds: string[];
  maxRows: number;
  maxBytes: number;
  cacheTtlSeconds: number;
  columns: AnalysisColumn[];
};

export type AnalysisTransformNode = {
  id: string;
  title: string;
  operation: AnalysisTransformOperation;
  inputNodeIds: string[];
  config: Record<string, unknown>;
  columns: AnalysisColumn[];
};

export type AnalysisBlock = {
  id: string;
  kind: AnalysisBlockKind;
  title: string;
  sourceNodeId: string | null;
  width: number;
  config: Record<string, unknown>;
};

export type AnalysisEvidenceClaim = {
  id: string;
  text: string;
  blockIds: string[];
  nodeIds: string[];
};

export type AnalysisRefreshPolicy = {
  mode: "manual" | "scheduled";
  cron: string | null;
  timezone: string;
  runnerId: string | null;
  maxStalenessSeconds: number;
  resultRetentionDays: number;
  shareReviewedResults: boolean;
};

export type AnalysisArticleDefinition = {
  version: 1;
  source: AnalysisArticleSource;
  title: string;
  question: string;
  summary: string;
  timezone: string;
  parameters: AnalysisParameter[];
  queries: AnalysisQueryNode[];
  transforms: AnalysisTransformNode[];
  metrics: AnalysisMetric[];
  blocks: AnalysisBlock[];
  claims: AnalysisEvidenceClaim[];
  refresh: AnalysisRefreshPolicy;
  warnings: string[];
};

export type SharedAnalysisArticleCreate = {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceKnowledgeGrantId: string | null;
  graphRevisionIds: string[];
  connections: AnalysisArticleConnection[];
  definition: AnalysisArticleDefinition;
};

export type AnalysisArticleVersionPayload = SharedAnalysisArticleCreate & {
  state: AnalysisArticleState;
  ownerMemberId: string;
  deleted: boolean;
};

export type AnalysisArticleRecord = SharedAnalysisArticleCreate & {
  state: AnalysisArticleState;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  liveRevision: number | null;
  liveRunId: string | null;
  nextRefreshAt: string | null;
  latestSuccessfulRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnalysisQueryReceipt = {
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
};

export type AnalysisResultFragment = {
  version: 1;
  blockId: string;
  ordinal: number;
  columns: AnalysisColumn[];
  rows: AnalysisParameterValue[][];
  truncated: boolean;
};

export type AnalysisDefinitionRunReceipt = {
  runId: string;
  articleId: string;
  articleRevision: number;
  parameterValues: Record<string, AnalysisParameterValue>;
  queryReceipts: AnalysisQueryReceipt[];
  fragments: AnalysisResultFragment[];
  resultHash: string;
  startedAt: string;
  finishedAt: string;
};

export type AnalysisRun = {
  id: string;
  articleId: string;
  articleRevision: number;
  runnerId: string;
  leaseId: string | null;
  trigger: "manual" | "schedule" | "signal" | "publication";
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "stale";
  parameterValues: Record<string, AnalysisParameterValue>;
  parameterHash: string;
  definitionHash: string;
  schemaFingerprints: Record<string, string>;
  rowCount: number;
  byteCount: number;
  resultHash: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  cancelRequestedAt: string | null;
  cancelRequestedByMemberId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type AnalysisRunCommandResult = {
  run: AnalysisRun;
  result: AnalysisDefinitionRunReceipt;
  sharedResult: boolean;
};

export type AnalysisRunPage = {
  runs: AnalysisRun[];
  nextCursor: string | null;
};

export type AnalysisArticleRevision = {
  revision: number;
  baseRevision: number | null;
  operation: string;
  payload: AnalysisArticleVersionPayload;
  payloadHash: string;
  createdByMemberId: string;
  createdAt: string;
};

export type AnalysisResult = {
  run: Pick<
    AnalysisRun,
    | "id"
    | "articleId"
    | "articleRevision"
    | "state"
    | "resultHash"
    | "rowCount"
    | "byteCount"
    | "finishedAt"
  >;
  fragments: AnalysisResultFragment[];
};

export type AnalysisRunnerChanged = {
  state: "disabled" | "deferred" | "registering" | "running" | "failed" | "ready";
  articleId: string | null;
  runId: string | null;
  errorKind: string | null;
};

export type AnalysisArticleChanged = {
  articleId: string;
  revision: number;
  action: "proposed" | "updated";
};

export type AnalysisRunner = {
  id: string;
  deviceId: string;
  displayName: string;
  backgroundAllowed: boolean;
  lastSeenAt: string;
  online: boolean;
  scheduledArticleCount: number;
  isCurrent: boolean;
};

export type AnalysisRunnerRevocation = {
  id: string;
  scheduledArticleCount: number;
  activeLeaseCount: number;
};

export type AnalysisPublicationRequest = {
  id: string;
  runId: string;
  slug: string;
  replacePublicationId: string | null;
  visibility: "unlisted" | "public";
  title: string;
  description: string;
  blockIds: string[];
  parameterIds: string[];
  searchIndexable: boolean;
  sensitivityConfirmed: boolean;
  productionConfirmed: boolean;
  previewHash: string | null;
};

export type AnalysisPublicSnapshot = {
  version: 1;
  title: string;
  description: string;
  summary: string;
  timezone: string;
  dataAsOf: string;
  searchIndexable: boolean;
  parameters: Array<{ label: string; value: AnalysisParameterValue }>;
  blocks: Array<{
    id: string;
    kind: AnalysisBlockKind;
    title: string;
    width: number;
    config: Record<string, unknown>;
    fragments: AnalysisResultFragment[];
  }>;
};

export type AnalysisPublicationPreview = {
  snapshot: AnalysisPublicSnapshot;
  snapshotHash: string;
};

export type AnalysisPublication = {
  id: string;
  articleRevision: number;
  sourceRunId: string;
  slug: string;
  version: number;
  replacesPublicationId: string | null;
  visibility: "unlisted" | "public";
  title: string;
  description: string;
  snapshotHash: string;
  publishedAt: string;
  revokedAt: string | null;
};

export type AnalysisSignalCondition =
  | { kind: "threshold_above" | "threshold_below" | "absolute_change"; value: number }
  | { kind: "percentage_change"; percentage: number }
  | { kind: "missing_data" | "consecutive_failure"; count: number };

export type AnalysisSignalDefinition = {
  condition: AnalysisSignalCondition;
  baselineWindowSeconds: number | null;
  minimumSampleCount: number;
  cooldownSeconds: number;
  rearmAfterNormalCount: number;
  severity: "info" | "warning" | "critical";
  recipientMemberIds: string[];
  channels: Array<"desktop" | "workspace_web" | "email">;
  productionConfirmed: boolean;
};

export type AnalysisSignalCreate = {
  id: string;
  articleRevision: number;
  blockId: string;
  definition: AnalysisSignalDefinition;
  enabled: boolean;
};

export type AnalysisSignal = AnalysisSignalCreate & {
  articleId: string;
  ownerMemberId: string | null;
  revision: number;
  lastEvaluatedRunId: string | null;
  lastObservedState: "unknown" | "normal" | "firing" | "recovered" | "no_data" | "error" | "stale";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type AnalysisSignalHistoryReceipt = {
  id: string;
  signalRevision: number;
  runId: string;
  observedState: "normal" | "firing" | "no_data" | "error" | "stale";
  state: "normal" | "firing" | "recovered" | "no_data" | "error" | "stale";
  resultHash: string | null;
  schemaFingerprint: string;
  transitionSequence: number;
  errorKind: string | null;
  evaluatedAt: string;
  createdAt: string;
};

export type AnalysisCollaborator = {
  id: string;
  name: string;
  role: "viewer" | "analyst" | "editor" | "admin" | "owner";
  canOwnAnalysis: boolean;
};

export type AnalysisCollaboratorDirectory = {
  workspaceId: string;
  currentMemberId: string;
  currentRole: AnalysisCollaborator["role"];
  members: AnalysisCollaborator[];
};

export type AnalysisNotification = {
  id: string;
  articleId: string;
  articleTitle: string;
  signalId: string;
  blockId: string;
  signalRevision: number;
  state: "normal" | "firing" | "recovered" | "no_data" | "error" | "stale";
  observedState: "normal" | "firing" | "no_data" | "error" | "stale";
  severity: "info" | "warning" | "critical";
  deliveryState: "pending" | "delivered" | "failed";
  evaluatedAt: string;
  createdAt: string;
  readAt: string | null;
};

export type AnalysisBlockData = {
  columns: AnalysisColumn[];
  rows: AnalysisParameterValue[][];
  truncated: boolean;
};

export function mergeAnalysisFragments(
  fragments: readonly AnalysisResultFragment[],
): Map<string, AnalysisBlockData> {
  const grouped = new Map<string, AnalysisResultFragment[]>();
  for (const fragment of fragments) {
    const current = grouped.get(fragment.blockId) ?? [];
    current.push(fragment);
    grouped.set(fragment.blockId, current);
  }
  const output = new Map<string, AnalysisBlockData>();
  for (const [blockId, group] of grouped) {
    group.sort((left, right) => left.ordinal - right.ordinal);
    const columns = group[0]?.columns ?? [];
    output.set(blockId, {
      columns,
      rows: group.flatMap((fragment) => fragment.rows),
      truncated: group.some((fragment) => fragment.truncated),
    });
  }
  return output;
}

export function articleFreshness(
  article: AnalysisArticleRecord,
  now = Date.now(),
): "never_run" | "running" | "failed" | "fresh" | "stale" {
  if (!article.latestSuccessfulRunId) return "never_run";
  const updatedAt = Date.parse(article.updatedAt);
  if (!Number.isFinite(updatedAt)) return "stale";
  return now - updatedAt <= article.definition.refresh.maxStalenessSeconds * 1_000
    ? "fresh"
    : "stale";
}
