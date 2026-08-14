// Analysis management owns the workspace-visible Article and operational DTOs.
import type { AnalysisPublicSnapshot } from "../../lib/workspace-analysis-publications";
import type { AnalysisArticleDefinition, AnalysisParameterValue } from "../../lib/workspace-analysis-articles";
import type { AnalysisResultFragmentPayload } from "../../lib/workspace-analysis-runs";

export type AnalysisArticle = {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  connections: Array<{ connectionId: string; connectionRevision: number; alias: string }>;
  definition: AnalysisArticleDefinition;
  state: "draft" | "review" | "live" | "archived";
  revision: number;
  liveRevision: number | null;
  liveRunId: string | null;
  nextRefreshAt: string | null;
  latestSuccessfulRunId: string | null;
  updatedAt: string;
};

export type AnalysisRun = {
  id: string;
  articleRevision: number;
  trigger: "manual" | "schedule" | "signal" | "publication";
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "stale";
  rowCount: number;
  byteCount: number;
  errorKind: string | null;
  errorMessage: string | null;
  parameterValues: Record<string, AnalysisParameterValue>;
  createdAt: string;
  finishedAt: string | null;
};

export type AnalysisResult = {
  run: {
    id: string;
    articleId: string;
    articleRevision: number;
    state: "succeeded";
    resultHash: string | null;
    rowCount: number;
    byteCount: number;
    finishedAt: string | null;
  };
  fragments: AnalysisResultFragmentPayload[];
};

export type AnalysisSignal = {
  id: string;
  articleRevision: number;
  blockId: string;
  definition: {
    severity: "info" | "warning" | "critical";
    channels: Array<"desktop" | "workspace_web" | "email">;
  };
  enabled: boolean;
  revision: number;
  lastObservedState: string;
  updatedAt: string;
};

export type AnalysisPublication = {
  id: string;
  slug: string;
  version: number;
  visibility: "unlisted" | "public";
  title: string;
  publishedAt: string;
  revokedAt: string | null;
};

export type AnalysisRunner = {
  id: string;
  displayName: string;
  backgroundAllowed: boolean;
  lastSeenAt: string;
  online: boolean;
  scheduledArticleCount: number;
};

export type AnalysisNotification = {
  id: string;
  articleId: string;
  articleTitle: string;
  signalId: string;
  blockId: string;
  signalRevision: number;
  state: string;
  observedState: string;
  severity: string;
  deliveryState: string;
  evaluatedAt: string;
  createdAt: string;
  readAt: string | null;
};

export type AnalysisMigrationFailure = {
  id: string;
  sourceKind: "dashboard" | "funnel_analysis" | "report" | "signal";
  sourceId: string;
  sourceRevision: number;
  title: string;
  projectEnvironmentId: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  failureReason: string;
  originalCreatedAt: string | null;
  archivedAt: string;
  resolvedArticleId: string | null;
  resolvedAt: string | null;
};

export type Detail = {
  runs: AnalysisRun[];
  signals: AnalysisSignal[];
  publications: AnalysisPublication[];
};

export type PanelTab = "library" | "inbox" | "runners" | "recovery";

const fixedControlKinds = new Set([
  "date_range_control",
  "comparison_control",
  "segment_control",
]);

export function workspaceResultDocument(
  article: AnalysisArticle,
  run: AnalysisRun,
  fragments: AnalysisResultFragmentPayload[],
): AnalysisPublicSnapshot {
  const fragmentsByBlock = new Map<string, AnalysisResultFragmentPayload[]>();
  for (const fragment of fragments) {
    const values = fragmentsByBlock.get(fragment.blockId) ?? [];
    values.push(fragment);
    fragmentsByBlock.set(fragment.blockId, values);
  }
  return {
    version: 1,
    title: article.definition.title,
    description: article.definition.question,
    summary: article.definition.summary,
    timezone: article.definition.timezone,
    dataAsOf: run.finishedAt ?? run.createdAt,
    searchIndexable: false,
    parameters: article.definition.parameters.map((parameter) => ({
      label: parameter.label,
      value: run.parameterValues[parameter.id] ?? parameter.defaultValue,
    })),
    blocks: article.definition.blocks
      .filter((block) => !fixedControlKinds.has(block.kind))
      .map((block) => {
        const metric = block.kind === "metric"
          ? article.definition.metrics.find((candidate) => candidate.id === block.config.metricId)
          : null;
        return {
          id: block.id,
          kind: block.kind,
          title: block.title,
          width: block.width,
          config: metric ? {
            ...block.config,
            publicMetric: {
              label: metric.label,
              description: metric.description,
              valueColumn: metric.valueColumn,
              unit: metric.unit,
              lowerIsBetter: metric.lowerIsBetter,
              format: metric.format,
            },
          } : block.config,
          fragments: (fragmentsByBlock.get(block.id) ?? [])
            .sort((left, right) => left.ordinal - right.ordinal),
        };
      }),
  };
}
