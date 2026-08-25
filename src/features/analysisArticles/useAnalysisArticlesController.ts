// Owns the Analysis Article collection, run recovery, live events, and mutations
// so the screen remains a projection of one feature workflow.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import { useCatalogScope } from "../../lib/queries";
import type {
  EnvironmentConnection,
  KnowledgeEnvironment,
} from "../knowledge/domain";
import {
  mergeAnalysisFragments,
  type AnalysisArticleRecord,
  type AnalysisDefinitionRunReceipt,
  type AnalysisParameterValue,
  type AnalysisRunnerChanged,
  type SharedAnalysisArticleCreate,
} from "./domain";
import {
  beginAnalysisArticleStateTransitionOutcome,
  beginManualAnalysisRunOutcome,
} from "./productAnalytics";
import { analysisQueryKeys } from "./queryKeys";
import {
  cancelAnalysisArticleRun,
  deleteAnalysisArticle,
  getAnalysisArticleResult,
  getLocalAnalysisArticleResult,
  listAnalysisArticleRevisions,
  listAnalysisArticleRuns,
  listAnalysisArticles,
  listAnalysisCollaborators,
  listAnalysisRunners,
  onAnalysisArticleChanged,
  onAnalysisRunnerChanged,
  revokeAnalysisRunner,
  restoreAnalysisArticleRevision,
  runAnalysisArticle,
  transitionAnalysisArticle,
  transferAnalysisArticle,
  updateAnalysisArticle,
} from "./tauriAdapter";

export type AnalysisArticleDetailTab =
  | "article"
  | "definition"
  | "lineage"
  | "signals"
  | "sharing"
  | "history";

type Params = {
  environment: KnowledgeEnvironment;
  bindings: readonly EnvironmentConnection[];
  sharedWorkspace: boolean;
  scopeKey: string;
  focusId?: string | null;
  onOpenAgent?: (connectionId: string, environmentId?: string, prompt?: string) => void;
};

function defaultParameters(
  article: AnalysisArticleRecord,
): Record<string, AnalysisParameterValue> {
  return Object.fromEntries(
    article.definition.parameters.map((parameter) => [
      parameter.id,
      parameter.defaultValue,
    ]),
  );
}

const EMPTY_ANALYSIS_FRAGMENTS = [] as const;

export function useAnalysisArticlesController({
  environment,
  bindings,
  sharedWorkspace,
  scopeKey,
  focusId,
  onOpenAgent,
}: Params) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const catalogScope = useCatalogScope();
  const detailTabs = useMemo(
    () =>
      [
        { id: "article", label: t("analysis.tabArticle") },
        { id: "definition", label: t("analysis.tabDefinition") },
        { id: "lineage", label: t("analysis.tabLineage") },
        { id: "signals", label: t("analysis.tabSignals") },
        { id: "sharing", label: t("analysis.tabSharing") },
        { id: "history", label: t("analysis.tabHistory") },
      ] as const,
    [t],
  );
  const articleKey = useMemo(
    () => analysisQueryKeys.articles(scopeKey, environment.id),
    [environment.id, scopeKey],
  );
  const articles = useQuery({
    queryKey: articleKey,
    queryFn: () => listAnalysisArticles(environment.id),
    enabled: sharedWorkspace,
    retry: false,
  });
  const runners = useQuery({
    queryKey: analysisQueryKeys.runners(scopeKey),
    queryFn: listAnalysisRunners,
    enabled: sharedWorkspace,
    retry: false,
  });
  const collaborators = useQuery({
    queryKey: analysisQueryKeys.collaborators(scopeKey),
    queryFn: listAnalysisCollaborators,
    enabled: sharedWorkspace,
    retry: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);
  const [tab, setTab] = useState<AnalysisArticleDetailTab>("article");
  const [editorArticle, setEditorArticle] =
    useState<AnalysisArticleRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [parameterValues, setParameterValues] = useState<
    Record<string, AnalysisParameterValue>
  >({});
  const [localResults, setLocalResults] = useState(
    new Map<string, AnalysisDefinitionRunReceipt>(),
  );
  const [running, setRunning] = useState<{
    articleId: string;
    runId: string;
  } | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runnerState, setRunnerState] =
    useState<AnalysisRunnerChanged | null>(null);

  useEffect(() => {
    if (focusId && articles.data?.some((article) => article.id === focusId)) {
      setSelectedId(focusId);
      return;
    }
    if (
      selectedId &&
      articles.data?.some((article) => article.id === selectedId)
    ) {
      return;
    }
    setSelectedId(articles.data?.[0]?.id ?? null);
  }, [articles.data, focusId, selectedId]);

  const selected =
    articles.data?.find((article) => article.id === selectedId) ?? null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const revisions = useQuery({
    queryKey: analysisQueryKeys.revisions(scopeKey, selected?.id),
    queryFn: () => listAnalysisArticleRevisions(selected!.id),
    enabled: Boolean(selected) && tab === "history",
    retry: false,
  });
  const runs = useQuery({
    queryKey: analysisQueryKeys.runs(scopeKey, selected?.id),
    queryFn: () => listAnalysisArticleRuns(selected!.id),
    enabled:
      Boolean(selected) &&
      (tab === "history" || tab === "lineage" || tab === "article"),
    retry: false,
  });
  const recoveredResult = useQuery({
    queryKey: analysisQueryKeys.localResult(scopeKey, selected?.id),
    queryFn: () => getLocalAnalysisArticleResult(selected!.id),
    enabled: Boolean(selected),
    retry: false,
  });
  const memoryResult = selected
    ? localResults.get(selected.id) ?? null
    : null;
  const localResult =
    memoryResult ??
    (recoveredResult.data?.articleRevision === selected?.revision
      ? recoveredResult.data
      : null);
  const effectiveRunId =
    selectedRunId ??
    localResult?.runId ??
    selected?.liveRunId ??
    (selected?.state === "review" ? selected.latestSuccessfulRunId : null);
  const sharedResult = useQuery({
    queryKey: analysisQueryKeys.result(
      scopeKey,
      selected?.id,
      effectiveRunId,
    ),
    queryFn: () => getAnalysisArticleResult(selected!.id, effectiveRunId!),
    enabled: Boolean(
      selected &&
        effectiveRunId &&
        running?.runId !== effectiveRunId &&
        localResult?.runId !== effectiveRunId &&
        (selected.liveRunId === effectiveRunId || selected.state === "review"),
    ),
    retry: false,
  });
  const fragments =
    localResult?.runId === effectiveRunId
      ? localResult.fragments
      : (sharedResult.data?.fragments ?? EMPTY_ANALYSIS_FRAGMENTS);
  const blockData = useMemo(
    () => mergeAnalysisFragments(fragments),
    [fragments],
  );

  useEffect(() => {
    const current = selectedRef.current;
    if (!current) return;
    setParameterValues(defaultParameters(current));
    setSelectedRunId(null);
  }, [selected?.id, selected?.revision]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onAnalysisRunnerChanged((change) => {
      if (disposed) return;
      setRunnerState(change);
      void queryClient.invalidateQueries({
        queryKey: analysisQueryKeys.runners(scopeKey),
      });
      if (change.articleId) {
        void queryClient.invalidateQueries({
          queryKey: analysisQueryKeys.runs(scopeKey, change.articleId),
        });
        void queryClient.invalidateQueries({ queryKey: articleKey });
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [articleKey, queryClient, scopeKey]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onAnalysisArticleChanged((change) => {
      if (disposed) return;
      void queryClient.invalidateQueries({ queryKey: articleKey });
      void queryClient.invalidateQueries({
        queryKey: analysisQueryKeys.revisions(scopeKey, change.articleId),
      });
      setSelectedId(change.articleId);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [articleKey, queryClient, scopeKey]);

  const refreshArticle = async (articleId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: articleKey }),
      articleId
        ? queryClient.invalidateQueries({
            queryKey: analysisQueryKeys.runs(scopeKey, articleId),
          })
        : Promise.resolve(),
      articleId
        ? queryClient.invalidateQueries({
            queryKey: analysisQueryKeys.revisions(scopeKey, articleId),
          })
        : Promise.resolve(),
    ]);
  };

  const saveArticle = useMutation({
    mutationFn: (input: SharedAnalysisArticleCreate) =>
      updateAnalysisArticle(input.id, editorArticle!.revision, input),
    onSuccess: async (article) => {
      setActionError(null);
      setEditorArticle(null);
      setSelectedId(article.id);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const transition = useMutation({
    mutationFn: ({
      article,
      action,
    }: {
      article: AnalysisArticleRecord;
      action: "submitReview" | "returnDraft" | "publishLive" | "archive";
    }) => transitionAnalysisArticle(article.id, article.revision, action),
    onMutate: ({ article }) => ({
      completeAnalytics: beginAnalysisArticleStateTransitionOutcome(
        catalogScope,
        article.state,
      ),
    }),
    onSuccess: async (article, _variables, analyticsAttempt) => {
      setActionError(null);
      analyticsAttempt?.completeAnalytics(article.state);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (article: AnalysisArticleRecord) =>
      deleteAnalysisArticle(article.id, article.revision),
    onSuccess: async (_, article) => {
      setActionError(null);
      setSelectedId(null);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const restore = useMutation({
    mutationFn: ({
      article,
      revision,
    }: {
      article: AnalysisArticleRecord;
      revision: number;
    }) =>
      restoreAnalysisArticleRevision(article.id, article.revision, revision),
    onSuccess: async (article) => {
      setActionError(null);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const transfer = useMutation({
    mutationFn: ({
      article,
      ownerMemberId,
    }: {
      article: AnalysisArticleRecord;
      ownerMemberId: string;
    }) => transferAnalysisArticle(article.id, article.revision, ownerMemberId),
    onSuccess: async (article) => {
      setActionError(null);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const execute = useMutation({
    mutationFn: async ({
      article,
      runId,
    }: {
      article: AnalysisArticleRecord;
      runId: string;
    }) => runAnalysisArticle(article.id, article.revision, runId, parameterValues),
    onMutate: ({ article, runId }) => {
      setActionError(null);
      setRunning({ articleId: article.id, runId });
      setSelectedRunId(runId);
      return {
        completeAnalytics: beginManualAnalysisRunOutcome(catalogScope),
      };
    },
    onSuccess: async (value, _variables, analyticsAttempt) => {
      analyticsAttempt?.completeAnalytics(value.run);
      setLocalResults((current) =>
        new Map(current).set(value.result.articleId, value.result),
      );
      setSelectedRunId(value.result.runId);
      setRunning(null);
      await refreshArticle(value.result.articleId);
    },
    onError: async (error, variables, analyticsAttempt) => {
      setRunning(null);
      setActionError(errMessage(error));
      try {
        const page = await listAnalysisArticleRuns(variables.article.id);
        analyticsAttempt?.completeAnalytics(
          page.runs.find((run) => run.id === variables.runId),
        );
      } catch {
        // The mutation error alone is not a terminal run receipt. If recovery
        // cannot prove the exact run outcome, do not infer an analytics event.
      }
    },
  });
  const cancel = useMutation({
    mutationFn: ({ articleId, runId }: { articleId: string; runId: string }) =>
      cancelAnalysisArticleRun(articleId, runId),
    onSuccess: async (run) => {
      setActionError(null);
      await refreshArticle(run.articleId);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const revokeRunner = useMutation({
    mutationFn: (runnerId: string) => revokeAnalysisRunner(runnerId),
    onSuccess: async () => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: analysisQueryKeys.runners(scopeKey),
        }),
        queryClient.invalidateQueries({ queryKey: articleKey }),
      ]);
    },
    onError: (error) => setActionError(errMessage(error)),
  });

  const startRun = (article: AnalysisArticleRecord) => {
    execute.mutate({ article, runId: crypto.randomUUID() });
  };

  const agentBinding = bindings.find((binding) => binding.connectionId);
  const askAgent = () => {
    if (!agentBinding?.connectionId || !onOpenAgent) return;
    onOpenAgent(
      agentBinding.connectionId,
      environment.id,
      t("analysis.agentPrompt"),
    );
  };

  return {
    actionError,
    agentBinding,
    articles,
    askAgent,
    blockData,
    cancel,
    collaborators,
    detailTabs,
    editorArticle,
    effectiveRunId,
    execute,
    parameterValues,
    recoveredResult,
    remove,
    restore,
    revisions,
    revokeRunner,
    runnerState,
    runners,
    running,
    runs,
    saveArticle,
    selected,
    setEditorArticle,
    setParameterValues,
    setSelectedRunId,
    setTab,
    sharedResult,
    startRun,
    tab,
    transfer,
    transition,
  };
}
