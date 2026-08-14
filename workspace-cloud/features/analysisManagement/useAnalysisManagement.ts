"use client";

// The controller is the single owner of Analysis management workflow state.
import { useCallback, useEffect, useMemo, useState } from "react";

import { useWorkspaceLocale } from "../../app/components/WorkspaceLocale";
import { analysisManagementText } from "./copy";
import {
  workspaceResultDocument,
  type AnalysisArticle,
  type AnalysisMigrationFailure,
  type AnalysisNotification,
  type AnalysisResult,
  type AnalysisRunner,
  type Detail,
  type PanelTab,
} from "./domain";
import {
  loadAnalysisDetail,
  loadAnalysisOverview,
  loadAnalysisResult,
  markAnalysisNotificationsRead,
  resolveAnalysisMigrationFailure,
} from "./transport";

const emptyDetail: Detail = { runs: [], signals: [], publications: [] };

export function useAnalysisManagement({
  workspaceId,
  initialArticleId,
  canEdit,
}: {
  workspaceId: string;
  initialArticleId: string | null;
  canEdit: boolean;
}) {
  const locale = useWorkspaceLocale();
  const text = analysisManagementText[locale];
  const [tab, setTab] = useState<PanelTab>("library");
  const [articles, setArticles] = useState<AnalysisArticle[]>([]);
  const [runners, setRunners] = useState<AnalysisRunner[]>([]);
  const [notifications, setNotifications] = useState<AnalysisNotification[]>([]);
  const [migrationFailures, setMigrationFailures] = useState<AnalysisMigrationFailure[]>([]);
  const [replacementByFailure, setReplacementByFailure] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState(initialArticleId ?? "");
  const [detail, setDetail] = useState<Detail>(emptyDetail);
  const [selectedNotifications, setSelectedNotifications] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resultRunId, setResultRunId] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const [resultError, setResultError] = useState("");
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");

  const selected = useMemo(
    () => articles.find((article) => article.id === selectedId) ?? null,
    [articles, selectedId],
  );
  const unreadCount = notifications.filter((notification) => !notification.readAt).length;
  const compatibleRuns = useMemo(
    () => detail.runs.filter((run) => (
      run.state === "succeeded" && run.articleRevision === selected?.revision
    )),
    [detail.runs, selected?.revision],
  );
  const selectedResultRun = compatibleRuns.find((run) => run.id === resultRunId) ?? null;
  const resultDocument = selected && selectedResultRun && result?.run.id === selectedResultRun.id
    ? workspaceResultDocument(selected, selectedResultRun, result.fragments)
    : null;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const overview = await loadAnalysisOverview(
        workspaceId,
        canEdit,
        text.loadError,
        signal,
      );
      if (signal?.aborted) return;
      setArticles(overview.articles);
      setRunners(overview.runners);
      setNotifications(overview.notifications);
      setMigrationFailures(overview.migrationFailures);
      setSelectedId((current) => overview.articles.some((article) => article.id === current)
        ? current
        : overview.articles[0]?.id ?? "");
      setSelectedNotifications((current) => new Set(
        [...current].filter((id) => overview.notifications.some((notification) => (
          notification.id === id && !notification.readAt
        ))),
      ));
      setError("");
    } catch (nextError) {
      if (!signal?.aborted) {
        setError(nextError instanceof Error ? nextError.message : text.loadError);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [canEdit, text.loadError, workspaceId]);

  const loadDetail = useCallback(async (articleId: string, signal?: AbortSignal) => {
    if (!articleId) {
      setDetail(emptyDetail);
      setDetailError("");
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    try {
      const nextDetail = await loadAnalysisDetail(
        workspaceId,
        articleId,
        text.detailError,
        signal,
      );
      if (signal?.aborted) return;
      setDetail(nextDetail);
      setDetailError("");
    } catch (nextError) {
      if (!signal?.aborted) {
        setDetailError(nextError instanceof Error ? nextError.message : text.detailError);
      }
    } finally {
      if (!signal?.aborted) setDetailLoading(false);
    }
  }, [text.detailError, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void loadDetail(selectedId, controller.signal);
    return () => controller.abort();
  }, [loadDetail, selectedId]);

  useEffect(() => {
    setResultRunId((current) => {
      if (compatibleRuns.some((run) => run.id === current)) return current;
      const live = compatibleRuns.find((run) => run.id === selected?.liveRunId);
      return live?.id ?? compatibleRuns[0]?.id ?? "";
    });
  }, [compatibleRuns, selected?.liveRunId]);

  useEffect(() => {
    const controller = new AbortController();
    if (!selectedId || !resultRunId) {
      setResult(null);
      setResultError("");
      setResultLoading(false);
      return () => controller.abort();
    }
    setResultLoading(true);
    setResultError("");
    void loadAnalysisResult(
      workspaceId,
      selectedId,
      resultRunId,
      text.resultUnavailable,
      controller.signal,
    ).then((nextResult) => {
      if (!controller.signal.aborted) setResult(nextResult);
    }).catch((nextError: unknown) => {
      if (!controller.signal.aborted) {
        setResult(null);
        setResultError(nextError instanceof Error ? nextError.message : text.resultUnavailable);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setResultLoading(false);
    });
    return () => controller.abort();
  }, [resultRunId, selectedId, text.resultUnavailable, workspaceId]);

  async function markSelectedRead() {
    const ids = [...selectedNotifications];
    if (ids.length === 0 || mutating) return;
    setMutating(true);
    try {
      await markAnalysisNotificationsRead(workspaceId, ids, text.mutationError);
      setSelectedNotifications(new Set());
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : text.mutationError);
    } finally {
      setMutating(false);
    }
  }

  async function resolveFailure(failureId: string) {
    const articleId = replacementByFailure[failureId];
    if (!articleId || mutating) return;
    setMutating(true);
    try {
      await resolveAnalysisMigrationFailure(
        workspaceId,
        failureId,
        articleId,
        text.mutationError,
      );
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : text.mutationError);
    } finally {
      setMutating(false);
    }
  }

  function selectNotification(notification: AnalysisNotification) {
    setSelectedId(notification.articleId);
    setTab("library");
  }

  return {
    locale,
    text,
    tab,
    setTab,
    articles,
    runners,
    notifications,
    migrationFailures,
    replacementByFailure,
    setReplacementByFailure,
    selectedId,
    setSelectedId,
    detail,
    selectedNotifications,
    setSelectedNotifications,
    loading,
    detailLoading,
    resultRunId,
    setResultRunId,
    resultLoading,
    resultError,
    mutating,
    error,
    detailError,
    selected,
    unreadCount,
    compatibleRuns,
    resultDocument,
    load,
    markSelectedRead,
    resolveFailure,
    selectNotification,
  };
}

export type AnalysisManagementController = ReturnType<typeof useAnalysisManagement>;
