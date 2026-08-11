import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import ConfirmButton from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { AnalysisArticleEditor } from "../../features/analysisArticles/AnalysisArticleEditor";
import { AnalysisArticleVisualization } from "../../features/analysisArticles/AnalysisArticleVisualization";
import { AnalysisPublicationPanel } from "../../features/analysisArticles/AnalysisPublicationPanel";
import { AnalysisSignalPanel } from "../../features/analysisArticles/AnalysisSignalPanel";
import {
  articleFreshness,
  mergeAnalysisFragments,
  type AnalysisArticleRecord,
  type AnalysisArticleState,
  type AnalysisDefinitionRunReceipt,
  type AnalysisParameterValue,
  type AnalysisRunnerChanged,
  type AnalysisRunner,
  type SharedAnalysisArticleCreate,
} from "../../features/analysisArticles/domain";
import {
  cancelAnalysisArticleRun,
  createAnalysisArticle,
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
} from "../../features/analysisArticles/tauriAdapter";
import type {
  EnvironmentConnection,
  KnowledgeEnvironment,
} from "../../features/knowledge/domain";
import { Button } from "../../design-system/components/Button";
import {
  SelectInput,
  TextInput,
} from "../../design-system/components/FormControls";
import { PanelTabs } from "../../design-system/components/PanelTabs";
import {
  InlineNotice,
  LoadingLabel,
  StatusBadge,
  StatusDot,
  type StatusTone,
} from "../../design-system/components/Status";
import {
  MetadataDot,
  WorkbenchButton,
  WorkbenchDivider,
  WorkbenchEmptyState,
  WorkbenchToolbar,
} from "../../design-system/components/Workbench";
import { errMessage } from "../../ipc/types";

type DetailTab = "article" | "definition" | "lineage" | "signals" | "sharing" | "history";

const detailTabs = [
  { id: "article", label: "Article" },
  { id: "definition", label: "Definition" },
  { id: "lineage", label: "Lineage" },
  { id: "signals", label: "Signals" },
  { id: "sharing", label: "Sharing" },
  { id: "history", label: "History" },
] as const;

function stateTone(state: AnalysisArticleState): StatusTone {
  if (state === "live") return "success";
  if (state === "review") return "warning";
  return "neutral";
}

function runTone(state: string): StatusTone {
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "cancelled" || state === "stale") return "danger";
  return "warning";
}

function relativeTime(value: string | null): string {
  if (!value) return "Never";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.round((time - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function byteSize(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function sourceLabel(article: AnalysisArticleRecord): string {
  if (article.definition.source === "dopedb.acp.claude") return "Claude";
  if (article.definition.source === "dopedb.acp.codex") return "Codex";
  if (article.definition.source === "migration") return "Migrated";
  return "Human";
}

function defaultParameters(article: AnalysisArticleRecord): Record<string, AnalysisParameterValue> {
  return Object.fromEntries(
    article.definition.parameters.map((parameter) => [parameter.id, parameter.defaultValue]),
  );
}

export default function AnalysisArticles({
  projectName,
  environment,
  bindings,
  sharedWorkspace,
  focusId,
  onOpenAgent,
  onNewConnection,
}: {
  projectName: string;
  environment: KnowledgeEnvironment;
  bindings: readonly EnvironmentConnection[];
  sharedWorkspace: boolean;
  focusId?: string | null;
  onOpenAgent?: (connectionId: string) => void;
  onNewConnection?: () => void;
}) {
  const queryClient = useQueryClient();
  const articleKey = ["analysis-articles", environment.id] as const;
  const articles = useQuery({
    queryKey: articleKey,
    queryFn: () => listAnalysisArticles(environment.id),
    enabled: sharedWorkspace,
    retry: false,
  });
  const runners = useQuery({
    queryKey: ["analysis-runners"] as const,
    queryFn: listAnalysisRunners,
    enabled: sharedWorkspace,
    retry: false,
  });
  const collaborators = useQuery({
    queryKey: ["analysis-collaborators"] as const,
    queryFn: listAnalysisCollaborators,
    enabled: sharedWorkspace,
    retry: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);
  const [tab, setTab] = useState<DetailTab>("article");
  const [filter, setFilter] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | AnalysisArticleState>("all");
  const [editorArticle, setEditorArticle] = useState<AnalysisArticleRecord | "new" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [parameterValues, setParameterValues] = useState<Record<string, AnalysisParameterValue>>({});
  const [localResults, setLocalResults] = useState(new Map<string, AnalysisDefinitionRunReceipt>());
  const [running, setRunning] = useState<{ articleId: string; runId: string } | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runnerState, setRunnerState] = useState<AnalysisRunnerChanged | null>(null);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return (articles.data ?? []).filter((article) =>
      (stateFilter === "all" || article.state === stateFilter)
      && (!needle
        || article.definition.title.toLocaleLowerCase().includes(needle)
        || article.definition.question.toLocaleLowerCase().includes(needle)),
    );
  }, [articles.data, filter, stateFilter]);

  useEffect(() => {
    if (focusId && articles.data?.some((article) => article.id === focusId)) {
      setSelectedId(focusId);
      return;
    }
    if (selectedId && articles.data?.some((article) => article.id === selectedId)) return;
    setSelectedId(articles.data?.[0]?.id ?? null);
  }, [articles.data, focusId, selectedId]);

  const selected = articles.data?.find((article) => article.id === selectedId) ?? null;
  const revisions = useQuery({
    queryKey: ["analysis-article-revisions", selected?.id] as const,
    queryFn: () => listAnalysisArticleRevisions(selected!.id),
    enabled: Boolean(selected) && tab === "history",
    retry: false,
  });
  const runs = useQuery({
    queryKey: ["analysis-article-runs", selected?.id] as const,
    queryFn: () => listAnalysisArticleRuns(selected!.id),
    enabled: Boolean(selected) && (tab === "history" || tab === "lineage" || tab === "article"),
    retry: false,
    refetchInterval: running?.articleId === selected?.id ? 2_000 : false,
  });
  const recoveredResult = useQuery({
    queryKey: ["analysis-article-local-result", selected?.id] as const,
    queryFn: () => getLocalAnalysisArticleResult(selected!.id),
    enabled: Boolean(selected),
    retry: false,
  });
  const memoryResult = selected ? localResults.get(selected.id) ?? null : null;
  const localResult = memoryResult
    ?? (recoveredResult.data?.articleRevision === selected?.revision
      ? recoveredResult.data
      : null);
  const effectiveRunId = selectedRunId
    ?? localResult?.runId
    ?? selected?.liveRunId
    ?? (selected?.state === "review" ? selected.latestSuccessfulRunId : null);
  const sharedResult = useQuery({
    queryKey: ["analysis-article-result", selected?.id, effectiveRunId] as const,
    queryFn: () => getAnalysisArticleResult(selected!.id, effectiveRunId!),
    enabled: Boolean(
      selected
      && effectiveRunId
      && localResult?.runId !== effectiveRunId
      && (selected.liveRunId === effectiveRunId || selected.state === "review"),
    ),
    retry: false,
  });
  const fragments = localResult?.runId === effectiveRunId
    ? localResult.fragments
    : sharedResult.data?.fragments ?? [];
  const blockData = useMemo(() => mergeAnalysisFragments(fragments), [fragments]);

  useEffect(() => {
    if (!selected) return;
    setParameterValues(defaultParameters(selected));
    setSelectedRunId(null);
  }, [selected?.id, selected?.revision]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onAnalysisRunnerChanged((change) => {
      if (disposed) return;
      setRunnerState(change);
      void queryClient.invalidateQueries({ queryKey: ["analysis-runners"] });
      if (change.articleId) {
        void queryClient.invalidateQueries({ queryKey: ["analysis-article-runs", change.articleId] });
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
  }, [environment.id, queryClient]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onAnalysisArticleChanged((change) => {
      if (disposed) return;
      void queryClient.invalidateQueries({ queryKey: articleKey });
      void queryClient.invalidateQueries({
        queryKey: ["analysis-article-revisions", change.articleId],
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
  }, [environment.id, queryClient]);

  const refreshArticle = async (articleId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: articleKey }),
      articleId
        ? queryClient.invalidateQueries({ queryKey: ["analysis-article-runs", articleId] })
        : Promise.resolve(),
      articleId
        ? queryClient.invalidateQueries({ queryKey: ["analysis-article-revisions", articleId] })
        : Promise.resolve(),
    ]);
  };

  const saveArticle = useMutation({
    mutationFn: (input: SharedAnalysisArticleCreate) =>
      editorArticle === "new"
        ? createAnalysisArticle(input)
        : updateAnalysisArticle(input.id, (editorArticle as AnalysisArticleRecord).revision, input),
    onSuccess: async (article) => {
      setActionError(null);
      setEditorArticle(null);
      setSelectedId(article.id);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const transition = useMutation({
    mutationFn: ({ article, action }: {
      article: AnalysisArticleRecord;
      action: "submitReview" | "returnDraft" | "publishLive" | "archive";
    }) => transitionAnalysisArticle(article.id, article.revision, action),
    onSuccess: async (article) => {
      setActionError(null);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (article: AnalysisArticleRecord) => deleteAnalysisArticle(article.id, article.revision),
    onSuccess: async (_, article) => {
      setActionError(null);
      setSelectedId(null);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const restore = useMutation({
    mutationFn: ({ article, revision }: { article: AnalysisArticleRecord; revision: number }) =>
      restoreAnalysisArticleRevision(article.id, article.revision, revision),
    onSuccess: async (article) => {
      setActionError(null);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const transfer = useMutation({
    mutationFn: ({ article, ownerMemberId }: { article: AnalysisArticleRecord; ownerMemberId: string }) =>
      transferAnalysisArticle(article.id, article.revision, ownerMemberId),
    onSuccess: async (article) => {
      setActionError(null);
      await refreshArticle(article.id);
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const execute = useMutation({
    mutationFn: async ({ article, runId }: { article: AnalysisArticleRecord; runId: string }) =>
      runAnalysisArticle(article.id, article.revision, runId, parameterValues),
    onMutate: ({ article, runId }) => {
      setActionError(null);
      setRunning({ articleId: article.id, runId });
      setSelectedRunId(runId);
    },
    onSuccess: async (value) => {
      setLocalResults((current) => new Map(current).set(value.result.articleId, value.result));
      setSelectedRunId(value.result.runId);
      setRunning(null);
      await refreshArticle(value.result.articleId);
    },
    onError: (error) => {
      setRunning(null);
      setActionError(errMessage(error));
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
        queryClient.invalidateQueries({ queryKey: ["analysis-runners"] }),
        queryClient.invalidateQueries({ queryKey: articleKey }),
      ]);
    },
    onError: (error) => setActionError(errMessage(error)),
  });

  const startRun = (article: AnalysisArticleRecord) => {
    const runId = crypto.randomUUID();
    execute.mutate({ article, runId });
  };

  if (!sharedWorkspace) {
    return (
      <WorkbenchEmptyState icon="chart">
        <strong>Analysis Articles live in a team workspace</strong>
        <span>They share definitions, policy, review state, and encrypted result blocks without sharing long-lived credentials.</span>
      </WorkbenchEmptyState>
    );
  }

  return (
    <div className="tw:flex tw:min-h-[calc(100dvh-90px)] tw:min-w-0 tw:flex-col tw:bg-background">
      <WorkbenchToolbar label="Analysis Articles">
        <WorkbenchButton onClick={() => setEditorArticle("new")}>
          <Icon name="plus" />
          New Article
        </WorkbenchButton>
        <WorkbenchDivider />
        <WorkbenchButton
          iconOnly
          title="Refresh Articles"
          aria-label="Refresh Articles"
          onClick={() => void articles.refetch()}
        >
          <Icon name="refresh" className={articles.isFetching ? "tw:animate-spin tw:motion-reduce:animate-none" : undefined} />
        </WorkbenchButton>
        <span className="tw:ml-auto tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:text-xs tw:text-muted-foreground">
          <StatusDot tone={runnerState?.state === "failed" || runnerState?.state === "deferred" ? "warning" : "success"} />
          <span className="tw:truncate">
            {runnerState?.state === "running" ? "Refreshing an Article" : `${runners.data?.filter((runner) => runner.online).length ?? 0} runner online`}
          </span>
        </span>
      </WorkbenchToolbar>

      {actionError ? (
        <div className="tw:px-3 tw:pt-3">
          <InlineNotice tone="danger" icon="alert" role="alert">{actionError}</InlineNotice>
        </div>
      ) : null}

      <div className="tw:grid tw:min-h-0 tw:min-w-0 tw:flex-1 tw:grid-cols-[280px_minmax(0,1fr)] tw:@max-[780px]:grid-cols-1">
        <aside className="tw:flex tw:min-h-0 tw:min-w-0 tw:flex-col tw:border-r tw:border-border-subtle tw:bg-card tw:@max-[780px]:max-h-[280px] tw:@max-[780px]:border-r-0 tw:@max-[780px]:border-b">
          <div className="tw:grid tw:gap-2 tw:border-b tw:border-border-subtle tw:p-2">
            <TextInput
              density="compact"
              type="search"
              placeholder="Filter Articles"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <SelectInput density="compact" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}>
              <option value="all">All states</option>
              <option value="draft">Draft</option>
              <option value="review">In review</option>
              <option value="live">Live</option>
              <option value="archived">Archived</option>
            </SelectInput>
          </div>
          <div className="scrollbar-sleek tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-1">
            {articles.isPending ? (
              <div className="tw:p-3"><LoadingLabel>Loading Articles…</LoadingLabel></div>
            ) : articles.error ? (
              <div className="tw:p-2"><InlineNotice tone="danger" icon="alert">{errMessage(articles.error)}</InlineNotice></div>
            ) : filtered.length === 0 ? (
              <div className="tw:grid tw:gap-2 tw:p-4 tw:text-sm tw:text-muted-foreground">
                <Icon name="chart" />
                <span>{articles.data?.length ? "No Article matches this filter." : "No Analysis Article yet."}</span>
              </div>
            ) : filtered.map((article) => {
              const freshness = articleFreshness(article);
              return (
                <button
                  key={article.id}
                  type="button"
                  data-selected={selected?.id === article.id}
                  className="tw:grid tw:w-full tw:min-w-0 tw:cursor-pointer tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-start tw:gap-x-2 tw:gap-y-1 tw:rounded-sm tw:border-0 tw:bg-transparent tw:px-2 tw:py-2 tw:text-left tw:font-sans tw:text-foreground tw:data-[selected=true]:bg-selection tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                  onClick={() => {
                    setSelectedId(article.id);
                    setTab("article");
                  }}
                >
                  <StatusDot tone={stateTone(article.state)} />
                  <strong className="tw:min-w-0 tw:truncate tw:text-sm tw:font-medium">{article.definition.title}</strong>
                  <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">r{article.revision}</span>
                  <span className="tw:col-start-2 tw:min-w-0 tw:truncate tw:text-xs tw:text-muted-foreground">
                    {article.definition.question || article.definition.summary || "No question supplied"}
                  </span>
                  <span className="tw:col-start-2 tw:flex tw:min-w-0 tw:items-center tw:gap-1 tw:text-2xs tw:text-muted-foreground">
                    <span>{article.state}</span>
                    <MetadataDot />
                    <span>{freshness.replace(/_/g, " ")}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="tw:flex tw:min-h-0 tw:min-w-0 tw:flex-col tw:overflow-hidden">
          {!selected ? (
            <WorkbenchEmptyState icon="chart">
              <strong>{projectName} / {environment.name}</strong>
              <span>Create a versioned Article or ask the Agent to propose one from verified reads.</span>
              <span className="tw:flex tw:flex-wrap tw:items-center tw:justify-center tw:gap-2">
                <Button variant="primary" onClick={() => setEditorArticle("new")}>
                  <Icon name="plus" /> New Article
                </Button>
                {bindings[0]?.connectionId && onOpenAgent ? (
                  <Button onClick={() => onOpenAgent(bindings[0]!.connectionId!)}>
                    <Icon name="terminal" /> Ask Agent
                  </Button>
                ) : null}
                {bindings.length === 0 && onNewConnection ? (
                  <Button onClick={onNewConnection}><Icon name="database" /> Connect database</Button>
                ) : null}
              </span>
            </WorkbenchEmptyState>
          ) : (
            <>
              <ArticleHeader
                article={selected}
                running={running?.articleId === selected.id}
                busy={transition.isPending || remove.isPending || execute.isPending}
                canPublish={selected.state === "review" && selected.latestSuccessfulRunId !== null}
                onEdit={() => setEditorArticle(selected)}
                onRun={() => startRun(selected)}
                onCancel={() => running && cancel.mutate(running)}
                onTransition={(action) => transition.mutate({ article: selected, action })}
                onDelete={() => remove.mutate(selected)}
              />
              <PanelTabs tabs={detailTabs} active={tab} onChange={setTab} label="Analysis Article details" />
              <div className="scrollbar-sleek tw:min-h-0 tw:flex-1 tw:overflow-auto tw:overscroll-contain">
                {tab === "article" ? (
                  <ArticleView
                    article={selected}
                    data={blockData}
                    parameterValues={parameterValues}
                    onParameterChange={(id, value) => setParameterValues((current) => ({ ...current, [id]: value }))}
                    runId={effectiveRunId}
                    loadingResult={recoveredResult.isFetching || sharedResult.isFetching}
                    resultError={sharedResult.error}
                    runs={runs.data?.runs ?? []}
                    selectedRunId={effectiveRunId}
                    onSelectRun={setSelectedRunId}
                  />
                ) : tab === "definition" ? (
                  <DefinitionView article={selected} />
                ) : tab === "lineage" ? (
                  <LineageView
                    article={selected}
                    runs={runs.data?.runs ?? []}
                    loading={runs.isPending}
                    runners={runners.data ?? []}
                    revokingRunnerId={revokeRunner.variables ?? null}
                    onRevokeRunner={(runnerId) => revokeRunner.mutate(runnerId)}
                    collaborators={collaborators.data}
                    transferring={transfer.isPending}
                    onTransfer={(ownerMemberId) => transfer.mutate({ article: selected, ownerMemberId })}
                  />
                ) : tab === "signals" ? (
                  <AnalysisSignalPanel article={selected} />
                ) : tab === "sharing" ? (
                  <AnalysisPublicationPanel article={selected} />
                ) : (
                  <HistoryView
                    article={selected}
                    revisions={revisions.data ?? []}
                    runs={runs.data?.runs ?? []}
                    loading={revisions.isPending || runs.isPending}
                    restoring={restore.isPending}
                    onRestore={(revision) => restore.mutate({ article: selected, revision })}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {editorArticle ? (
        <AnalysisArticleEditor
          article={editorArticle === "new" ? null : editorArticle}
          environment={environment}
          bindings={bindings}
          runners={runners.data ?? []}
          saving={saveArticle.isPending}
          onSave={(input) => saveArticle.mutate(input)}
          onClose={() => setEditorArticle(null)}
        />
      ) : null}
    </div>
  );
}

function ArticleHeader({
  article,
  running,
  busy,
  canPublish,
  onEdit,
  onRun,
  onCancel,
  onTransition,
  onDelete,
}: {
  article: AnalysisArticleRecord;
  running: boolean;
  busy: boolean;
  canPublish: boolean;
  onEdit: () => void;
  onRun: () => void;
  onCancel: () => void;
  onTransition: (action: "submitReview" | "returnDraft" | "publishLive" | "archive") => void;
  onDelete: () => void;
}) {
  return (
    <header className="tw:grid tw:shrink-0 tw:gap-2 tw:border-b tw:border-border-subtle tw:bg-background tw:px-4 tw:py-3">
      <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:min-w-0 tw:gap-1">
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
            <h1 className="tw:m-0 tw:min-w-0 tw:truncate tw:text-title tw:font-semibold tw:tracking-tight">{article.definition.title}</h1>
            <StatusBadge density="compact" tone={stateTone(article.state)}>{article.state}</StatusBadge>
            <StatusBadge density="compact">{sourceLabel(article)}</StatusBadge>
            <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">r{article.revision}</span>
          </div>
          {article.definition.question ? (
            <p className="tw:m-0 tw:max-w-[88ch] tw:text-sm tw:leading-body tw:text-muted-foreground">{article.definition.question}</p>
          ) : null}
        </div>
        <div className="ds-control-row tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-1">
          {running ? (
            <Button variant="danger" size="compact" onClick={onCancel}>
              <Icon name="stop" /> Cancel
            </Button>
          ) : (
            <Button variant="primary" size="compact" disabled={busy} onClick={onRun}>
              <Icon name="play" /> Run current data
            </Button>
          )}
          <Button size="compact" disabled={busy} onClick={onEdit}><Icon name="pencil" /> Edit</Button>
          {article.state === "draft" ? (
            <Button size="compact" disabled={busy} onClick={() => onTransition("submitReview")}><Icon name="arrowRight" /> Submit review</Button>
          ) : null}
          {article.state === "review" ? (
            <>
              <Button size="compact" disabled={busy} onClick={() => onTransition("returnDraft")}><Icon name="arrowLeft" /> Return draft</Button>
              <Button size="compact" variant="primary" disabled={busy || !canPublish} title={canPublish ? "Publish this exact successful revision" : "Run this exact review successfully before publishing"} onClick={() => onTransition("publishLive")}><Icon name="check" /> Publish live</Button>
            </>
          ) : null}
          {article.state === "live" ? (
            <ConfirmButton size="compact" disabled={busy} confirmLabel="Archive this live Article?" onConfirm={() => onTransition("archive")}>
              Archive
            </ConfirmButton>
          ) : null}
          {article.state === "draft" || article.state === "archived" ? (
            <ConfirmButton iconOnly size="xs" variant="ghost" label="Delete Article" disabled={busy} onConfirm={onDelete}>
              <Icon name="trash" />
            </ConfirmButton>
          ) : null}
        </div>
      </div>
      {article.definition.warnings.length > 0 ? (
        <div className="tw:flex tw:flex-wrap tw:gap-1">
          {article.definition.warnings.map((warning) => <StatusBadge key={warning} density="compact" tone="warning" title={warning}>{warning}</StatusBadge>)}
        </div>
      ) : null}
    </header>
  );
}

function ArticleView({
  article,
  data,
  parameterValues,
  onParameterChange,
  runId,
  loadingResult,
  resultError,
  runs,
  selectedRunId,
  onSelectRun,
}: {
  article: AnalysisArticleRecord;
  data: ReturnType<typeof mergeAnalysisFragments>;
  parameterValues: Record<string, AnalysisParameterValue>;
  onParameterChange: (id: string, value: AnalysisParameterValue) => void;
  runId: string | null;
  loadingResult: boolean;
  resultError: Error | null;
  runs: Array<{ id: string; state: string; finishedAt: string | null; articleRevision: number }>;
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
}) {
  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1320px] tw:gap-4 tw:p-5 tw:@max-[760px]:p-3">
      <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
        <StatusBadge density="compact" tone={articleFreshness(article) === "fresh" ? "success" : "warning"}>
          {articleFreshness(article).replace(/_/g, " ")}
        </StatusBadge>
        <span className="tw:text-xs tw:text-muted-foreground">
          Updated {relativeTime(article.updatedAt)} · {article.definition.timezone}
        </span>
        {runs.length ? (
          <label className="tw:ml-auto tw:inline-flex tw:items-center tw:gap-2 tw:text-xs tw:text-muted-foreground">
            Result
            <select
              className="tw:h-control-sm tw:max-w-[260px] tw:rounded-sm tw:border tw:border-input tw:bg-background tw:px-2 tw:text-xs tw:text-foreground"
              value={selectedRunId ?? ""}
              onChange={(event) => onSelectRun(event.target.value || null)}
            >
              {runs.filter((run) => run.state === "succeeded").map((run) => (
                <option key={run.id} value={run.id}>r{run.articleRevision} · {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : run.id.slice(0, 8)}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {article.definition.summary ? (
        <p className="tw:m-0 tw:max-w-[90ch] tw:text-sm tw:leading-relaxed tw:text-foreground">{article.definition.summary}</p>
      ) : null}
      {loadingResult ? <LoadingLabel>Decrypting reviewed result blocks…</LoadingLabel> : null}
      {resultError && runId ? (
        <InlineNotice tone="warning" icon="alert">This run has no shared result blocks on this device. Run the current revision locally, or select its published live result.</InlineNotice>
      ) : null}
      <AnalysisArticleVisualization
        definition={article.definition}
        data={data}
        parameterValues={parameterValues}
        onParameterChange={onParameterChange}
      />
      {article.definition.claims.length > 0 ? (
        <section className="tw:grid tw:gap-2 tw:border-t tw:border-border-subtle tw:pt-4">
          <h2 className="tw:m-0 tw:text-sm tw:font-semibold">Evidence-backed claims</h2>
          <ol className="tw:m-0 tw:grid tw:gap-2 tw:pl-5 tw:text-sm tw:leading-body">
            {article.definition.claims.map((claim) => <li key={claim.id}>{claim.text}</li>)}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function DefinitionView({ article }: { article: AnalysisArticleRecord }) {
  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1100px] tw:gap-5 tw:p-5 tw:@max-[760px]:p-3">
      <DefinitionSection title="Parameters" count={article.definition.parameters.length}>
        {article.definition.parameters.map((parameter) => (
          <DefinitionRow key={parameter.id} title={parameter.label} metadata={`${parameter.type} · ${parameter.required ? "required" : "optional"}`} detail={parameter.id} />
        ))}
      </DefinitionSection>
      <DefinitionSection title="Queries" count={article.definition.queries.length}>
        {article.definition.queries.map((query) => (
          <details key={query.id} className="tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <summary className="tw:cursor-pointer tw:text-sm tw:font-medium">{query.title} <span className="tw:text-xs tw:font-normal tw:text-muted-foreground">· {query.connectionRole} · {query.maxRows.toLocaleString()} rows · {byteSize(query.maxBytes)}</span></summary>
            <pre className="scrollbar-sleek tw:mt-3 tw:max-h-[360px] tw:overflow-auto tw:whitespace-pre-wrap tw:rounded-sm tw:bg-muted tw:p-3 tw:font-mono tw:text-xs tw:leading-body">{query.sql}</pre>
            <div className="tw:mt-2 tw:flex tw:flex-wrap tw:gap-1">
              {query.columns.map((column) => <StatusBadge key={column.name} density="compact" title={`${column.sensitivity} · ${column.masking}`}>{column.name}: {column.type}</StatusBadge>)}
            </div>
          </details>
        ))}
      </DefinitionSection>
      <DefinitionSection title="Transforms" count={article.definition.transforms.length}>
        {article.definition.transforms.map((transform) => (
          <DefinitionRow key={transform.id} title={transform.title} metadata={transform.operation.replace(/_/g, " ")} detail={`${transform.inputNodeIds.join(" + ")} → ${transform.id}`} />
        ))}
      </DefinitionSection>
      <DefinitionSection title="Metrics" count={article.definition.metrics.length}>
        {article.definition.metrics.map((metric) => (
          <DefinitionRow key={metric.id} title={metric.label} metadata={`${metric.format.style} · ${metric.sourceNodeId}.${metric.valueColumn}`} detail={metric.description || metric.id} />
        ))}
      </DefinitionSection>
      <DefinitionSection title="Layout blocks" count={article.definition.blocks.length}>
        {article.definition.blocks.map((block) => (
          <DefinitionRow key={block.id} title={block.title || block.id} metadata={`${block.kind.replace(/_/g, " ")} · ${block.width}/12`} detail={block.sourceNodeId ?? "Narrative / control"} />
        ))}
      </DefinitionSection>
    </div>
  );
}

function DefinitionSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="tw:grid tw:gap-2">
      <h2 className="tw:m-0 tw:flex tw:items-center tw:gap-2 tw:text-sm tw:font-semibold">{title}<StatusBadge density="compact">{count}</StatusBadge></h2>
      {count ? <div className="tw:grid tw:gap-2">{children}</div> : <span className="tw:text-sm tw:text-muted-foreground">None</span>}
    </section>
  );
}

function DefinitionRow({ title, metadata, detail }: { title: string; metadata: string; detail: string }) {
  return (
    <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-x-3 tw:gap-y-1 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:px-3 tw:py-2">
      <strong className="tw:min-w-0 tw:truncate tw:text-sm tw:font-medium">{title}</strong>
      <span className="tw:text-xs tw:text-muted-foreground">{metadata}</span>
      <code className="tw:col-span-2 tw:min-w-0 tw:truncate tw:text-xs tw:text-muted-foreground">{detail}</code>
    </div>
  );
}

function LineageView({
  article,
  runs,
  loading,
  runners,
  revokingRunnerId,
  onRevokeRunner,
  collaborators,
  transferring,
  onTransfer,
}: {
  article: AnalysisArticleRecord;
  runs: Array<{
    id: string;
    state: string;
    articleRevision: number;
    rowCount: number;
    byteCount: number;
    resultHash: string | null;
    definitionHash: string;
    schemaFingerprints: Record<string, string>;
    finishedAt: string | null;
  }>;
  loading: boolean;
  runners: readonly AnalysisRunner[];
  revokingRunnerId: string | null;
  onRevokeRunner: (runnerId: string) => void;
  collaborators: Awaited<ReturnType<typeof listAnalysisCollaborators>> | undefined;
  transferring: boolean;
  onTransfer: (ownerMemberId: string) => void;
}) {
  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1100px] tw:gap-5 tw:p-5 tw:@max-[760px]:p-3">
      <section className="tw:grid tw:gap-3">
        <h2 className="tw:m-0 tw:text-base tw:font-semibold">Authority chain</h2>
        <div className="tw:grid tw:grid-cols-[repeat(4,minmax(0,1fr))] tw:gap-px tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-border-subtle tw:@max-[720px]:grid-cols-2 tw:@max-[420px]:grid-cols-1">
          {[
            ["Environment", `r${article.environmentRevision}`],
            ["Connections", `${article.connections.length} exact revisions`],
            ["Knowledge graphs", article.graphRevisionIds.length ? `${article.graphRevisionIds.length} pinned` : "None"],
            ["Definition", `r${article.revision}`],
          ].map(([label, value]) => (
            <div key={label} className="tw:grid tw:gap-1 tw:bg-card tw:p-3">
              <span className="tw:text-xs tw:text-muted-foreground">{label}</span>
              <strong className="tw:text-sm tw:font-medium">{value}</strong>
            </div>
          ))}
        </div>
        <OwnershipControl
          article={article}
          collaborators={collaborators}
          transferring={transferring}
          onTransfer={onTransfer}
        />
      </section>
      <section className="tw:grid tw:gap-2">
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">Desktop runners</h2>
        <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">
          Scheduled refreshes use one member-owned Desktop device. Forgetting a device immediately stops its schedules and active leases without moving credentials to the workspace.
        </p>
        {article.definition.refresh.mode === "scheduled"
          && article.definition.refresh.runnerId
          && !runners.some((runner) => runner.id === article.definition.refresh.runnerId) ? (
            <InlineNotice tone="warning" icon="alert">
              This Article is assigned to a runner that is no longer available. Edit the Article and choose an online runner before scheduling resumes.
            </InlineNotice>
          ) : null}
        {runners.length === 0 ? (
          <InlineNotice tone="warning" icon="alert">
            No Desktop runner is registered for your account in this workspace. Keep DopeDB open once to register this device, then enable background automation in Settings if schedules must run after the window closes.
          </InlineNotice>
        ) : runners.map((runner) => {
          const assigned = article.definition.refresh.runnerId === runner.id;
          return (
            <div key={runner.id} className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-x-3 tw:gap-y-1 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
              <span className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                <StatusDot tone={runner.online ? "success" : "neutral"} />
                <strong className="tw:min-w-0 tw:truncate tw:text-sm tw:font-medium">{runner.displayName}</strong>
                {runner.isCurrent ? <StatusBadge density="compact">This device</StatusBadge> : null}
                {assigned ? <StatusBadge density="compact" tone="success">Assigned</StatusBadge> : null}
              </span>
              {runner.isCurrent ? (
                <span className="tw:text-xs tw:text-muted-foreground">Managed in Settings</span>
              ) : (
                <ConfirmButton
                  size="xs"
                  variant="dangerGhost"
                  disabled={revokingRunnerId !== null}
                  confirmLabel={`Forget this runner and stop ${runner.scheduledArticleCount} scheduled Article${runner.scheduledArticleCount === 1 ? "" : "s"}?`}
                  onConfirm={() => onRevokeRunner(runner.id)}
                >
                  Forget
                </ConfirmButton>
              )}
              <span className="tw:min-w-0 tw:truncate tw:text-xs tw:text-muted-foreground">
                {runner.online ? "Online" : `Last seen ${relativeTime(runner.lastSeenAt)}`}
                {runner.backgroundAllowed ? " · background enabled" : " · foreground only"}
                {runner.scheduledArticleCount > 0 ? ` · ${runner.scheduledArticleCount} scheduled` : ""}
              </span>
              <code className="tw:max-w-48 tw:truncate tw:text-right tw:text-2xs tw:text-muted-foreground">{runner.id}</code>
            </div>
          );
        })}
      </section>
      <section className="tw:grid tw:gap-2">
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">Connection pins</h2>
        {article.connections.map((connection) => (
          <div key={connection.connectionId} className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-1 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <strong className="tw:truncate tw:text-sm">{connection.alias}</strong>
            <StatusBadge density="compact">{connection.role} · r{connection.connectionRevision}</StatusBadge>
            <code className="tw:col-span-2 tw:truncate tw:text-xs tw:text-muted-foreground">{connection.connectionId}</code>
          </div>
        ))}
      </section>
      <section className="tw:grid tw:gap-2">
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">Execution evidence</h2>
        {loading ? <LoadingLabel>Loading run evidence…</LoadingLabel> : runs.length === 0 ? (
          <span className="tw:text-sm tw:text-muted-foreground">No execution receipt yet.</span>
        ) : runs.map((run) => (
          <details key={run.id} className="tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <summary className="tw:flex tw:cursor-pointer tw:items-center tw:gap-2 tw:text-sm">
              <StatusDot tone={runTone(run.state)} />
              <strong className="tw:font-medium">{run.state}</strong>
              <span className="tw:text-xs tw:text-muted-foreground">r{run.articleRevision} · {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "in progress"}</span>
              <span className="tw:ml-auto tw:font-mono tw:text-2xs tw:text-muted-foreground">{run.rowCount.toLocaleString()} rows · {byteSize(run.byteCount)}</span>
            </summary>
            <dl className="tw:mt-3 tw:grid tw:grid-cols-[120px_minmax(0,1fr)] tw:gap-x-3 tw:gap-y-2 tw:text-xs">
              <dt className="tw:text-muted-foreground">Run ID</dt><dd className="tw:m-0 tw:truncate tw:font-mono">{run.id}</dd>
              <dt className="tw:text-muted-foreground">Definition hash</dt><dd className="tw:m-0 tw:truncate tw:font-mono">{run.definitionHash}</dd>
              <dt className="tw:text-muted-foreground">Result hash</dt><dd className="tw:m-0 tw:truncate tw:font-mono">{run.resultHash ?? "None"}</dd>
              {Object.entries(run.schemaFingerprints).map(([node, hash]) => (
                <span className="tw:col-span-2 tw:grid tw:grid-cols-[120px_minmax(0,1fr)] tw:gap-x-3" key={node}>
                  <dt className="tw:text-muted-foreground">Schema · {node}</dt><dd className="tw:m-0 tw:truncate tw:font-mono">{hash}</dd>
                </span>
              ))}
            </dl>
          </details>
        ))}
      </section>
    </div>
  );
}

function OwnershipControl({
  article,
  collaborators,
  transferring,
  onTransfer,
}: {
  article: AnalysisArticleRecord;
  collaborators: Awaited<ReturnType<typeof listAnalysisCollaborators>> | undefined;
  transferring: boolean;
  onTransfer: (ownerMemberId: string) => void;
}) {
  const [target, setTarget] = useState(article.ownerMemberId);
  useEffect(() => setTarget(article.ownerMemberId), [article.ownerMemberId]);
  const current = collaborators?.members.find((member) => member.id === article.ownerMemberId);
  const allowed = collaborators
    ? collaborators.currentMemberId === article.ownerMemberId
      || collaborators.currentRole === "admin"
      || collaborators.currentRole === "owner"
    : false;
  return (
    <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(180px,300px)_auto] tw:items-end tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3 tw:@max-[680px]:grid-cols-1">
      <span className="tw:grid tw:gap-1">
        <strong className="tw:text-sm tw:font-medium">Article owner</strong>
        <span className="tw:text-xs tw:text-muted-foreground">{current?.name ?? article.ownerMemberId} owns lifecycle and transfer decisions.</span>
      </span>
      {allowed ? (
        <SelectInput density="compact" aria-label="New Article owner" value={target} onChange={(event) => setTarget(event.target.value)}>
          {(collaborators?.members ?? []).filter((member) => member.canOwnAnalysis).map((member) => (
            <option key={member.id} value={member.id}>{member.name} · {member.role}</option>
          ))}
        </SelectInput>
      ) : <span className="tw:text-xs tw:text-muted-foreground">Only the owner or a workspace administrator can transfer ownership.</span>}
      {allowed ? (
        <Button size="compact" disabled={transferring || target === article.ownerMemberId} onClick={() => onTransfer(target)}>
          Transfer
        </Button>
      ) : null}
    </div>
  );
}

function HistoryView({
  article,
  revisions,
  runs,
  loading,
  restoring,
  onRestore,
}: {
  article: AnalysisArticleRecord;
  revisions: Array<{ revision: number; operation: string; payloadHash: string; createdByMemberId: string; createdAt: string }>;
  runs: Array<{ id: string; articleRevision: number; state: string; trigger: string; startedAt: string | null; finishedAt: string | null; errorMessage: string | null }>;
  loading: boolean;
  restoring: boolean;
  onRestore: (revision: number) => void;
}) {
  if (loading) return <div className="tw:p-5"><LoadingLabel>Loading immutable history…</LoadingLabel></div>;
  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1100px] tw:grid-cols-2 tw:gap-5 tw:p-5 tw:@max-[760px]:grid-cols-1 tw:@max-[760px]:p-3">
      <section className="tw:grid tw:content-start tw:gap-2">
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">Definition revisions</h2>
        {revisions.map((revision) => (
          <div key={revision.revision} className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <StatusDot tone={revision.revision === article.liveRevision ? "success" : "neutral"} />
            <span className="tw:grid tw:min-w-0 tw:gap-0.5">
              <strong className="tw:text-sm tw:font-medium">r{revision.revision} · {revision.operation.replace(/_/g, " ")}</strong>
              <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{new Date(revision.createdAt).toLocaleString()} · {revision.createdByMemberId}</span>
              <code className="tw:truncate tw:text-2xs tw:text-muted-foreground">{revision.payloadHash}</code>
            </span>
            {revision.revision !== article.revision ? (
              <ConfirmButton size="xs" variant="ghost" disabled={restoring} confirmLabel={`Restore revision ${revision.revision} as a new draft?`} onConfirm={() => onRestore(revision.revision)}>
                Restore
              </ConfirmButton>
            ) : <StatusBadge density="compact">Current</StatusBadge>}
          </div>
        ))}
      </section>
      <section className="tw:grid tw:content-start tw:gap-2">
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">Runs</h2>
        {runs.map((run) => (
          <div key={run.id} className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <StatusDot tone={runTone(run.state)} />
            <span className="tw:grid tw:min-w-0 tw:gap-0.5">
              <strong className="tw:text-sm tw:font-medium">{run.state} · {run.trigger} · r{run.articleRevision}</strong>
              <span className="tw:text-xs tw:text-muted-foreground">{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : run.startedAt ? `Started ${new Date(run.startedAt).toLocaleString()}` : "Queued"}</span>
              {run.errorMessage ? <span className="tw:text-xs tw:text-danger">{run.errorMessage}</span> : null}
              <code className="tw:truncate tw:text-2xs tw:text-muted-foreground">{run.id}</code>
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
