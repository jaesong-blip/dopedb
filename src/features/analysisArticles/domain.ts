export const analysisArticleStates = ["draft", "review", "live", "archived"] as const;

export type AnalysisArticleState = (typeof analysisArticleStates)[number];
export type AnalysisArticleSource =
  | "human"
  | "dopedb.acp.claude"
  | "dopedb.acp.codex"
  | "migration";
export type AnalysisParameterValue = string | number | boolean | null;

export type AnalysisArticleConnection = {
  connectionId: string;
  connectionRevision: number;
  role: string;
  alias: string;
};

// Parameters remain readable for legacy Articles that were projected into the
// simple model. New Articles always create an empty list.
export type AnalysisParameter = {
  id: string;
  label: string;
  type: "string" | "number" | "boolean" | "date" | "datetime" | "enum";
  required: boolean;
  defaultValue: AnalysisParameterValue;
  options: string[];
};

export type AnalysisColumn = {
  name: string;
  type:
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "duration"
    | "currency"
    | "percent"
    | "json";
  nullable: boolean;
  role: "dimension" | "measure" | "time" | "identifier" | "free_text";
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  masking: "none" | "redact" | "hash" | "bucket";
};

export type AnalysisQueryNode = {
  id: string;
  title: string;
  connectionRole: string;
  sql: string;
  parameterIds: string[];
  maxRows: number;
  maxBytes: number;
  cacheTtlSeconds: 0;
  columns: AnalysisColumn[];
};

type AnalysisQueryResultBlock = {
  id: "query_result";
  kind: "table";
  title: string;
  sourceNodeId: string;
  width: 12;
  config: {
    columns: string[];
    pageSize: number;
  };
};

export type AnalysisArticleDefinition = {
  version: 2;
  source: AnalysisArticleSource;
  title: string;
  html: string;
  question: "";
  summary: "";
  timezone: "UTC";
  parameters: AnalysisParameter[];
  queries: [AnalysisQueryNode];
  transforms: never[];
  metrics: never[];
  blocks: [AnalysisQueryResultBlock];
  claims: never[];
  refresh: {
    mode: "manual";
    cron: null;
    timezone: "UTC";
    runnerId: null;
    maxStalenessSeconds: number;
    resultRetentionDays: number;
    shareReviewedResults: false;
  };
  warnings: never[];
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

export type AnalysisArticleChanged = {
  articleId: string;
  revision: number;
  action: "proposed" | "updated";
};

export type AnalysisPublicationRequest = {
  id: string;
  runId: string;
  slug: string;
  replacePublicationId: string | null;
  visibility: "unlisted" | "public";
  searchIndexable: boolean;
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
