"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useWorkspaceLocale } from "../../app/components/WorkspaceLocale";
import { analysisManagementText } from "./copy";
import type { AnalysisArticle, AnalysisMigrationFailure, Detail, PanelTab } from "./domain";
import {
  loadAnalysisDetail,
  loadAnalysisOverview,
  resolveAnalysisMigrationFailure,
} from "./transport";

const emptyDetail: Detail = { runs: [], publications: [] };

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
  const [migrationFailures, setMigrationFailures] = useState<AnalysisMigrationFailure[]>([]);
  const [replacementByFailure, setReplacementByFailure] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState(initialArticleId ?? "");
  const [detail, setDetail] = useState<Detail>(emptyDetail);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");

  const selected = useMemo(
    () => articles.find((article) => article.id === selectedId) ?? null,
    [articles, selectedId],
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const overview = await loadAnalysisOverview(workspaceId, canEdit, text.loadError, signal);
      if (signal?.aborted) return;
      setArticles(overview.articles);
      setMigrationFailures(overview.migrationFailures);
      setSelectedId((current) => overview.articles.some((article) => article.id === current)
        ? current
        : overview.articles[0]?.id ?? "");
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
      const nextDetail = await loadAnalysisDetail(workspaceId, articleId, text.detailError, signal);
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

  async function resolveFailure(failureId: string) {
    const articleId = replacementByFailure[failureId];
    if (!articleId || mutating) return;
    setMutating(true);
    try {
      await resolveAnalysisMigrationFailure(workspaceId, failureId, articleId, text.mutationError);
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : text.mutationError);
    } finally {
      setMutating(false);
    }
  }

  return {
    text,
    tab,
    setTab,
    articles,
    migrationFailures,
    replacementByFailure,
    setReplacementByFailure,
    selectedId,
    setSelectedId,
    detail,
    loading,
    detailLoading,
    mutating,
    error,
    detailError,
    selected,
    load,
    resolveFailure,
  };
}

export type AnalysisManagementController = ReturnType<typeof useAnalysisManagement>;
