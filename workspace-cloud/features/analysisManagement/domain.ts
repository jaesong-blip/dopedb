// Analysis management exposes the shared HTML document, manual run history,
// publication history, and legacy recovery only. Query results stay local to
// Desktop and schedules/signals are not part of the current product surface.
import type { AnalysisArticleDefinition } from "../../lib/workspace-analysis-articles";

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
  createdAt: string;
  finishedAt: string | null;
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
  publications: AnalysisPublication[];
};

export type PanelTab = "library" | "recovery";
