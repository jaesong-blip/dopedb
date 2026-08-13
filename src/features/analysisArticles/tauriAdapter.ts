import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invoke } from "../../ipc/core";
import type {
  AnalysisArticleRecord,
  AnalysisArticleChanged,
  AnalysisArticleRevision,
  AnalysisCollaboratorDirectory,
  AnalysisNotification,
  AnalysisParameterValue,
  AnalysisPublication,
  AnalysisPublicationPreview,
  AnalysisPublicationRequest,
  AnalysisResult,
  AnalysisRun,
  AnalysisRunCommandResult,
  AnalysisRunPage,
  AnalysisRunner,
  AnalysisRunnerRevocation,
  AnalysisRunnerChanged,
  AnalysisSignal,
  AnalysisSignalCreate,
  AnalysisSignalHistoryReceipt,
  SharedAnalysisArticleCreate,
} from "./domain";

export function listAnalysisRunners(): Promise<AnalysisRunner[]> {
  return invoke("list_analysis_runners_command");
}

export function revokeAnalysisRunner(runnerId: string): Promise<AnalysisRunnerRevocation> {
  return invoke("revoke_analysis_runner_command", { runnerId });
}

export function listAnalysisArticles(
  projectEnvironmentId?: string | null,
): Promise<AnalysisArticleRecord[]> {
  return invoke("list_analysis_articles_command", {
    projectEnvironmentId: projectEnvironmentId ?? null,
  });
}

export function updateAnalysisArticle(
  articleId: string,
  expectedRevision: number,
  article: SharedAnalysisArticleCreate,
): Promise<AnalysisArticleRecord> {
  return invoke("update_analysis_article_command", {
    articleId,
    expectedRevision,
    article,
  });
}

export function transitionAnalysisArticle(
  articleId: string,
  expectedRevision: number,
  action: "submitReview" | "returnDraft" | "publishLive" | "archive",
): Promise<AnalysisArticleRecord> {
  return invoke("transition_analysis_article_command", {
    articleId,
    expectedRevision,
    action,
  });
}

export function transferAnalysisArticle(
  articleId: string,
  expectedRevision: number,
  ownerMemberId: string,
): Promise<AnalysisArticleRecord> {
  return invoke("transfer_analysis_article_command", {
    articleId,
    expectedRevision,
    ownerMemberId,
  });
}

export function restoreAnalysisArticleRevision(
  articleId: string,
  expectedRevision: number,
  revision: number,
): Promise<AnalysisArticleRecord> {
  return invoke("restore_analysis_article_revision_command", {
    articleId,
    expectedRevision,
    revision,
  });
}

export function deleteAnalysisArticle(
  articleId: string,
  expectedRevision: number,
): Promise<number> {
  return invoke("delete_analysis_article_command", { articleId, expectedRevision });
}

export function listAnalysisArticleRevisions(
  articleId: string,
): Promise<AnalysisArticleRevision[]> {
  return invoke("list_analysis_article_revisions_command", { articleId });
}

export function listAnalysisArticleRuns(
  articleId: string,
  before?: string | null,
): Promise<AnalysisRunPage> {
  return invoke("list_analysis_article_runs_command", {
    articleId,
    before: before ?? null,
  });
}

export function getAnalysisArticleResult(
  articleId: string,
  runId: string,
): Promise<AnalysisResult> {
  return invoke("get_analysis_article_result_command", { articleId, runId });
}

export function getLocalAnalysisArticleResult(
  articleId: string,
  runId?: string | null,
): Promise<import("./domain").AnalysisDefinitionRunReceipt | null> {
  return invoke("get_local_analysis_article_result_command", {
    articleId,
    runId: runId ?? null,
  });
}

export function runAnalysisArticle(
  articleId: string,
  articleRevision: number,
  runId: string,
  parameterValues: Record<string, AnalysisParameterValue>,
): Promise<AnalysisRunCommandResult> {
  return invoke("run_analysis_article_command", {
    articleId,
    articleRevision,
    runId,
    parameterValues,
  });
}

export function cancelAnalysisArticleRun(
  articleId: string,
  runId: string,
): Promise<AnalysisRun> {
  return invoke("cancel_analysis_article_run", { articleId, runId });
}

export function onAnalysisRunnerChanged(
  listener: (change: AnalysisRunnerChanged) => void,
): Promise<UnlistenFn> {
  return listen<AnalysisRunnerChanged>("analysis-runner:changed", (event) =>
    listener(event.payload),
  );
}

export function onAnalysisArticleChanged(
  listener: (change: AnalysisArticleChanged) => void,
): Promise<UnlistenFn> {
  return listen<AnalysisArticleChanged>("analysis-article:changed", (event) =>
    listener(event.payload),
  );
}

export function listAnalysisPublications(
  articleId: string,
): Promise<AnalysisPublication[]> {
  return invoke("list_analysis_publications_command", { articleId });
}

export function previewAnalysisPublication(
  articleId: string,
  request: AnalysisPublicationRequest,
): Promise<AnalysisPublicationPreview> {
  return invoke("preview_analysis_publication_command", { articleId, request });
}

export function publishAnalysisSnapshot(
  articleId: string,
  request: AnalysisPublicationRequest,
): Promise<AnalysisPublication> {
  return invoke("create_analysis_publication_command", { articleId, request });
}

export function revokeAnalysisPublication(
  articleId: string,
  publicationId: string,
): Promise<string> {
  return invoke("revoke_analysis_publication_command", { articleId, publicationId });
}

export function analysisPublicationUrl(slug: string): Promise<string> {
  return invoke("analysis_publication_url_command", { slug });
}

export function listAnalysisCollaborators(): Promise<AnalysisCollaboratorDirectory> {
  return invoke("list_analysis_collaborators_command");
}

export function listAnalysisSignals(articleId: string): Promise<AnalysisSignal[]> {
  return invoke("list_analysis_signals_command", { articleId });
}

export function createAnalysisSignal(
  articleId: string,
  signal: AnalysisSignalCreate,
): Promise<AnalysisSignal> {
  return invoke("create_analysis_signal_command", { articleId, signal });
}

export function updateAnalysisSignal(
  articleId: string,
  signalId: string,
  expectedRevision: number,
  signal: AnalysisSignalCreate,
): Promise<AnalysisSignal> {
  return invoke("update_analysis_signal_command", {
    articleId,
    signalId,
    expectedRevision,
    signal,
  });
}

export function setAnalysisSignalEnabled(
  articleId: string,
  signalId: string,
  expectedRevision: number,
  enabled: boolean,
): Promise<AnalysisSignal> {
  return invoke("set_analysis_signal_enabled_command", {
    articleId,
    signalId,
    expectedRevision,
    enabled,
  });
}

export function deleteAnalysisSignal(
  articleId: string,
  signalId: string,
  expectedRevision: number,
): Promise<number> {
  return invoke("delete_analysis_signal_command", {
    articleId,
    signalId,
    expectedRevision,
  });
}

export function listAnalysisSignalReceipts(
  articleId: string,
  signalId: string,
): Promise<AnalysisSignalHistoryReceipt[]> {
  return invoke("list_analysis_signal_receipts_command", { articleId, signalId });
}

export function listAnalysisNotifications(): Promise<AnalysisNotification[]> {
  return invoke("list_analysis_notifications_command");
}

export function markAnalysisNotificationsRead(
  notificationIds: string[],
): Promise<string[]> {
  return invoke("mark_analysis_notifications_read_command", { notificationIds });
}
