"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ControlButton, ControlSelect } from "../components/Controls";
import { useWorkspaceLocale } from "../components/WorkspaceLocale";
import { AnalysisArticleDocument } from "../analyses/[slug]/PublicAnalysisArticle";
import type { AnalysisPublicSnapshot } from "../../lib/workspace-analysis-publications";
import type { AnalysisArticleDefinition, AnalysisParameterValue } from "../../lib/workspace-analysis-articles";
import type { AnalysisResultFragmentPayload } from "../../lib/workspace-analysis-runs";

type AnalysisArticle = {
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

type AnalysisRun = {
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

type AnalysisResult = {
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

type AnalysisSignal = {
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

type AnalysisPublication = {
  id: string;
  slug: string;
  version: number;
  visibility: "unlisted" | "public";
  title: string;
  publishedAt: string;
  revokedAt: string | null;
};

type AnalysisRunner = {
  id: string;
  displayName: string;
  backgroundAllowed: boolean;
  lastSeenAt: string;
  online: boolean;
  scheduledArticleCount: number;
};

type AnalysisNotification = {
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

type AnalysisMigrationFailure = {
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

type Detail = {
  runs: AnalysisRun[];
  signals: AnalysisSignal[];
  publications: AnalysisPublication[];
};

type PanelTab = "library" | "inbox" | "runners" | "recovery";

const textByLocale = {
  en: {
    tabs: { library: "Library", inbox: "Signal inbox", runners: "Desktop runners", recovery: "Legacy recovery" },
    refresh: "Refresh",
    loading: "Loading Analysis Articles…",
    loadError: "Could not load the shared Analysis library.",
    detailError: "Could not load this Article's operational history.",
    mutationError: "Could not update the notification inbox.",
    empty: "No Analysis Articles are visible with your current database grants.",
    select: "Select an Analysis Article",
    articleMeta: "Article state",
    sourceScope: "Exact source scope",
    freshness: "Freshness",
    latestRuns: "Recent runs",
    signals: "Signals",
    publications: "Fixed public publications",
    noRuns: "No runs have been recorded.",
    articleResult: "Current workspace result",
    resultAsOf: "Reviewed result",
    noCompatibleResult: "Run this exact revision successfully in DopeDB Desktop to make its reviewed result available to the team.",
    resultUnavailable: "This reviewed result is temporarily unavailable.",
    resultRevision: "Result revision",
    noSignals: "No metric signals are attached.",
    noPublications: "No fixed snapshot has been published.",
    openPublication: "Open public snapshot",
    revoked: "Revoked",
    live: "Live",
    working: "Working revision",
    manual: "Manual refresh",
    scheduled: "Scheduled refresh",
    never: "Never",
    next: "Next",
    lastSuccess: "Last success",
    openDesktop: "Editing, execution, review, recovery, and publication approval remain in DopeDB Desktop.",
    inboxEmpty: "No Analysis signal transition needs your attention.",
    markRead: "Mark selected read",
    unread: "Unread",
    read: "Read",
    block: "Block",
    runnersEmpty: "No member-owned Desktop runner is registered. Open DopeDB Desktop while signed into this workspace.",
    online: "Online",
    offline: "Offline",
    background: "Background enabled",
    foreground: "Foreground only",
    schedules: "scheduled Articles",
    lastSeen: "Last seen",
    healthy: "Ready for scheduled work",
    unavailable: "Scheduled work is unavailable",
    recoveryEmpty: "No unresolved legacy BI record remains.",
    recoveryDescription: "These definitions were preserved instead of being made executable with invented schema or sensitivity. Rebuild and review a replacement Article in Desktop, then bind it here.",
    original: "Original definition",
    replacement: "Reviewed replacement Article",
    chooseReplacement: "Choose an Article",
    resolve: "Mark recovered",
    resolving: "Saving…",
    resolved: "Recovered",
  },
  ko: {
    tabs: { library: "분석 보관함", inbox: "Signal 알림함", runners: "Desktop 실행기", recovery: "레거시 복구" },
    refresh: "새로고침",
    loading: "Analysis Article을 불러오는 중…",
    loadError: "공유 분석 보관함을 불러오지 못했습니다.",
    detailError: "이 Article의 실행 내역을 불러오지 못했습니다.",
    mutationError: "알림함 상태를 변경하지 못했습니다.",
    empty: "현재 DB 권한으로 볼 수 있는 Analysis Article이 없습니다.",
    select: "Analysis Article을 선택하세요",
    articleMeta: "Article 상태",
    sourceScope: "정확한 원본 범위",
    freshness: "최신 상태",
    latestRuns: "최근 실행",
    signals: "Signal",
    publications: "고정 공개본",
    noRuns: "기록된 실행이 없습니다.",
    articleResult: "현재 워크스페이스 결과",
    resultAsOf: "검토된 결과",
    noCompatibleResult: "이 정확한 revision을 DopeDB Desktop에서 성공적으로 실행하면 팀이 검토된 결과를 볼 수 있습니다.",
    resultUnavailable: "검토된 결과를 현재 불러올 수 없습니다.",
    resultRevision: "결과 revision",
    noSignals: "연결된 지표 Signal이 없습니다.",
    noPublications: "공개한 고정 snapshot이 없습니다.",
    openPublication: "공개 snapshot 열기",
    revoked: "회수됨",
    live: "Live",
    working: "작업 revision",
    manual: "수동 새로고침",
    scheduled: "예약 새로고침",
    never: "없음",
    next: "다음 실행",
    lastSuccess: "최근 성공",
    openDesktop: "편집·실행·검토·복구·공개 승인은 DopeDB Desktop에서 수행합니다.",
    inboxEmpty: "확인할 Analysis Signal 상태 변화가 없습니다.",
    markRead: "선택 항목 읽음",
    unread: "읽지 않음",
    read: "읽음",
    block: "블록",
    runnersEmpty: "등록된 개인 Desktop 실행기가 없습니다. 이 워크스페이스로 로그인한 DopeDB Desktop을 여세요.",
    online: "온라인",
    offline: "오프라인",
    background: "백그라운드 허용",
    foreground: "포그라운드 전용",
    schedules: "개 예약 Article",
    lastSeen: "마지막 확인",
    healthy: "예약 실행 가능",
    unavailable: "예약 실행 불가",
    recoveryEmpty: "복구되지 않은 레거시 BI 기록이 없습니다.",
    recoveryDescription: "스키마나 민감도를 추측해 실행 가능 상태로 만들지 않고 원본을 보존했습니다. Desktop에서 대체 Article을 재작성·검토한 뒤 여기에서 연결하세요.",
    original: "원본 정의",
    replacement: "검토된 대체 Article",
    chooseReplacement: "Article 선택",
    resolve: "복구 완료로 표시",
    resolving: "저장 중…",
    resolved: "복구됨",
  },
} as const;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

async function responseError(response: Response | null, fallback: string) {
  const body = await response?.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

function dateTime(value: string | null, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toLocaleString();
}

function bytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

const fixedControlKinds = new Set([
  "date_range_control",
  "comparison_control",
  "segment_control",
]);

function workspaceResultDocument(
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

function stateTone(state: string) {
  if (["live", "succeeded", "normal", "recovered", "online"].includes(state)) return "success";
  if (["failed", "cancelled", "stale", "firing", "critical", "offline"].includes(state)) return "danger";
  return "neutral";
}

function StatusPill({ value, label = value }: { value: string; label?: string }) {
  return (
    <span
      className="tw:inline-flex tw:items-center tw:gap-1.5 tw:rounded-full tw:border tw:border-border tw:bg-surface-inset tw:px-2 tw:py-1 tw:font-mono tw:text-2xs tw:text-muted-foreground tw:data-[tone=success]:border-success/25 tw:data-[tone=success]:bg-success/5 tw:data-[tone=success]:text-success tw:data-[tone=danger]:border-danger/25 tw:data-[tone=danger]:bg-danger/5 tw:data-[tone=danger]:text-danger"
      data-tone={stateTone(value)}
    >
      <i className="tw:size-1.5 tw:rounded-full tw:bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

export function AnalysisManagementPanel({
  workspaceId,
  initialArticleId,
  initialBlockId,
  canEdit,
}: {
  workspaceId: string;
  initialArticleId: string | null;
  initialBlockId: string | null;
  canEdit: boolean;
}) {
  const locale = useWorkspaceLocale();
  const text = textByLocale[locale];
  const [tab, setTab] = useState<PanelTab>("library");
  const [articles, setArticles] = useState<AnalysisArticle[]>([]);
  const [runners, setRunners] = useState<AnalysisRunner[]>([]);
  const [notifications, setNotifications] = useState<AnalysisNotification[]>([]);
  const [migrationFailures, setMigrationFailures] = useState<AnalysisMigrationFailure[]>([]);
  const [replacementByFailure, setReplacementByFailure] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState(initialArticleId ?? "");
  const [detail, setDetail] = useState<Detail>({ runs: [], signals: [], publications: [] });
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
    const [articleResponse, runnerResponse, notificationResponse, migrationResponse] = await Promise.all([
      fetch(`/api/v1/workspaces/${workspaceId}/analyses`, { cache: "no-store", signal }).catch(() => null),
      fetch(`/api/v1/workspaces/${workspaceId}/analyses/runners`, { cache: "no-store", signal }).catch(() => null),
      fetch(`/api/v1/workspaces/${workspaceId}/analyses/notifications?channel=workspace_web`, {
        cache: "no-store",
        signal,
      }).catch(() => null),
      canEdit
        ? fetch(`/api/v1/workspaces/${workspaceId}/analyses/migration-failures`, {
          cache: "no-store",
          signal,
        }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (signal?.aborted) return;
    const failed = [articleResponse, runnerResponse, notificationResponse, migrationResponse]
      .find((response) => !response?.ok) ?? null;
    if (failed) {
      setError(await responseError(failed, text.loadError));
      setLoading(false);
      return;
    }
    const [articleBody, runnerBody, notificationBody, migrationBody] = await Promise.all([
      articleResponse!.json().catch(() => null),
      runnerResponse!.json().catch(() => null),
      notificationResponse!.json().catch(() => null),
      migrationResponse?.json().catch(() => null) ?? null,
    ]);
    const nextArticles = array<AnalysisArticle>(object(articleBody)?.articles);
    setArticles(nextArticles);
    setRunners(array<AnalysisRunner>(object(runnerBody)?.runners));
    setNotifications(array<AnalysisNotification>(object(notificationBody)?.notifications));
    setMigrationFailures(array<AnalysisMigrationFailure>(object(migrationBody)?.failures));
    setSelectedId((current) => nextArticles.some((article) => article.id === current)
      ? current
      : nextArticles[0]?.id ?? "");
    setSelectedNotifications((current) => new Set(
      [...current].filter((id) => array<AnalysisNotification>(object(notificationBody)?.notifications)
        .some((notification) => notification.id === id && !notification.readAt)),
    ));
    setError("");
    setLoading(false);
  }, [canEdit, text.loadError, workspaceId]);

  const loadDetail = useCallback(async (articleId: string, signal?: AbortSignal) => {
    if (!articleId) {
      setDetail({ runs: [], signals: [], publications: [] });
      return;
    }
    setDetailLoading(true);
    const prefix = `/api/v1/workspaces/${workspaceId}/analyses/${articleId}`;
    const [runResponse, signalResponse, publicationResponse] = await Promise.all([
      fetch(`${prefix}/runs`, { cache: "no-store", signal }).catch(() => null),
      fetch(`${prefix}/signals`, { cache: "no-store", signal }).catch(() => null),
      fetch(`${prefix}/publications`, { cache: "no-store", signal }).catch(() => null),
    ]);
    if (signal?.aborted) return;
    const failed = [runResponse, signalResponse, publicationResponse]
      .find((response) => !response?.ok) ?? null;
    if (failed) {
      setDetailError(await responseError(failed, text.detailError));
      setDetailLoading(false);
      return;
    }
    const [runBody, signalBody, publicationBody] = await Promise.all([
      runResponse!.json().catch(() => null),
      signalResponse!.json().catch(() => null),
      publicationResponse!.json().catch(() => null),
    ]);
    setDetail({
      runs: array<AnalysisRun>(object(runBody)?.runs),
      signals: array<AnalysisSignal>(object(signalBody)?.signals),
      publications: array<AnalysisPublication>(object(publicationBody)?.publications),
    });
    setDetailError("");
    setDetailLoading(false);
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
    void fetch(
      `/api/v1/workspaces/${workspaceId}/analyses/${selectedId}/runs/${resultRunId}/results`,
      { cache: "no-store", signal: controller.signal },
    ).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response, text.resultUnavailable));
      const body = await response.json() as AnalysisResult;
      if (!controller.signal.aborted) setResult(body);
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
    const response = await fetch(
      `/api/v1/workspaces/${workspaceId}/analyses/notifications?channel=workspace_web`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notificationIds: ids }),
      },
    ).catch(() => null);
    if (!response?.ok) {
      setError(await responseError(response, text.mutationError));
      setMutating(false);
      return;
    }
    setSelectedNotifications(new Set());
    await load();
    setMutating(false);
  }

  async function resolveFailure(failureId: string) {
    const articleId = replacementByFailure[failureId];
    if (!articleId || mutating) return;
    setMutating(true);
    const response = await fetch(
      `/api/v1/workspaces/${workspaceId}/analyses/migration-failures`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ failureId, articleId }),
      },
    ).catch(() => null);
    if (!response?.ok) {
      setError(await responseError(response, text.mutationError));
      setMutating(false);
      return;
    }
    await load();
    setMutating(false);
  }

  function selectNotification(notification: AnalysisNotification) {
    setSelectedId(notification.articleId);
    setTab("library");
  }

  return (
    <div className="tw:min-w-0">
      <div className="tw:flex tw:min-h-12 tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:px-5">
        <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-1" role="tablist" aria-label="Analysis management">
          {(Object.keys(text.tabs) as PanelTab[]).filter((item) => item !== "recovery" || canEdit).map((item) => (
            <button
              className="tw:relative tw:h-12 tw:border-0 tw:bg-transparent tw:px-3 tw:text-xs tw:font-medium tw:text-muted-foreground tw:after:absolute tw:after:inset-x-3 tw:after:bottom-0 tw:after:h-0.5 tw:after:scale-x-0 tw:after:bg-primary tw:after:transition-transform tw:hover:text-foreground tw:data-[active=true]:text-foreground tw:data-[active=true]:after:scale-x-100"
              data-active={tab === item}
              key={item}
              onClick={() => setTab(item)}
              role="tab"
              type="button"
              aria-selected={tab === item}
            >
              {text.tabs[item]}
              {item === "inbox" && unreadCount > 0 ? (
                <span className="tw:ml-2 tw:rounded-full tw:bg-danger tw:px-1.5 tw:py-0.5 tw:font-mono tw:text-2xs tw:text-primary-foreground">
                  {unreadCount}
                </span>
              ) : null}
              {item === "recovery" && migrationFailures.length > 0 ? (
                <span className="tw:ml-2 tw:rounded-full tw:bg-warning tw:px-1.5 tw:py-0.5 tw:font-mono tw:text-2xs tw:text-foreground">
                  {migrationFailures.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <ControlButton onClick={() => void load()} disabled={loading}>
          {text.refresh}
        </ControlButton>
      </div>

      {error ? (
        <p className="tw:m-5 tw:rounded-surface tw:border tw:border-danger/25 tw:bg-danger/5 tw:px-4 tw:py-3 tw:text-xs tw:text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {tab === "library" ? (
        <div className="tw:grid tw:min-h-[560px] tw:grid-cols-[minmax(220px,0.38fr)_minmax(0,1fr)] tw:max-[760px]:grid-cols-1">
          <aside className="tw:min-w-0 tw:border-r tw:border-border tw:bg-surface-inset/45 tw:max-[760px]:max-h-64 tw:max-[760px]:overflow-auto tw:max-[760px]:border-r-0 tw:max-[760px]:border-b">
            {loading ? <p className="tw:m-0 tw:px-5 tw:py-8 tw:text-xs tw:text-muted-foreground">{text.loading}</p> : null}
            {!loading && articles.length === 0 ? <p className="tw:m-0 tw:px-5 tw:py-8 tw:text-xs tw:leading-body tw:text-muted-foreground">{text.empty}</p> : null}
            <ol className="tw:m-0 tw:list-none tw:p-0">
              {articles.map((article) => (
                <li className="tw:border-b tw:border-border" key={article.id}>
                  <button
                    className="tw:grid tw:w-full tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-3 tw:border-0 tw:bg-transparent tw:px-5 tw:py-4 tw:text-left tw:hover:bg-surface-raised tw:data-[active=true]:bg-selection"
                    data-active={article.id === selectedId}
                    onClick={() => setSelectedId(article.id)}
                    type="button"
                  >
                    <span className="tw:min-w-0">
                      <strong className="tw:block tw:truncate tw:text-xs tw:font-medium tw:text-foreground">{article.definition.title}</strong>
                      <small className="tw:mt-1 tw:block tw:truncate tw:font-mono tw:text-2xs tw:text-muted-foreground">
                        r{article.revision} · {article.connections.length} DB · {article.definition.blocks.length} blocks
                      </small>
                    </span>
                    <StatusPill value={article.state} />
                  </button>
                </li>
              ))}
            </ol>
          </aside>

          <section className="tw:min-w-0 tw:p-6 tw:max-[560px]:p-4" aria-live="polite">
            {!selected ? <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.select}</p> : (
              <div className="tw:grid tw:gap-6">
                <header className="tw:grid tw:gap-2 tw:border-b tw:border-border tw:pb-5">
                  <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3">
                    <h3 className="tw:m-0 tw:text-xl tw:font-medium tw:tracking-tight tw:text-foreground">{selected.definition.title}</h3>
                    <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                      <StatusPill value={selected.state} />
                      {selected.liveRevision ? <StatusPill value="live" label={`${text.live} r${selected.liveRevision}`} /> : null}
                    </div>
                  </div>
                  <p className="tw:m-0 tw:max-w-3xl tw:text-xs tw:leading-body tw:text-muted-foreground">{selected.definition.summary || selected.definition.question}</p>
                  <p className="tw:m-0 tw:font-mono tw:text-2xs tw:text-muted-foreground">{text.openDesktop}</p>
                </header>

                <dl className="tw:grid tw:grid-cols-3 tw:gap-px tw:overflow-hidden tw:rounded-surface tw:border tw:border-border tw:bg-border tw:max-[760px]:grid-cols-1">
                  <div className="tw:grid tw:gap-1 tw:bg-surface tw:p-4"><dt className="tw:font-mono tw:text-2xs tw:text-muted-foreground">{text.articleMeta}</dt><dd className="tw:m-0 tw:text-xs tw:text-foreground">{text.working} r{selected.revision} · {selected.definition.blocks.length} blocks</dd></div>
                  <div className="tw:grid tw:gap-1 tw:bg-surface tw:p-4"><dt className="tw:font-mono tw:text-2xs tw:text-muted-foreground">{text.sourceScope}</dt><dd className="tw:m-0 tw:text-xs tw:text-foreground">Environment r{selected.environmentRevision} · {selected.connections.length} DB · {selected.definition.queries.length} queries</dd></div>
                  <div className="tw:grid tw:gap-1 tw:bg-surface tw:p-4"><dt className="tw:font-mono tw:text-2xs tw:text-muted-foreground">{text.freshness}</dt><dd className="tw:m-0 tw:text-xs tw:text-foreground">{selected.definition.refresh.mode === "scheduled" ? text.scheduled : text.manual} · {text.next} {dateTime(selected.nextRefreshAt, text.never)}</dd></div>
                </dl>

                {initialBlockId && selected.id === initialArticleId ? (
                  <p className="tw:m-0 tw:rounded-surface tw:border tw:border-primary/20 tw:bg-selection tw:px-4 tw:py-3 tw:font-mono tw:text-2xs tw:text-primary">
                    {text.block}: {initialBlockId}
                  </p>
                ) : null}
                {detailError ? <p className="tw:m-0 tw:text-xs tw:text-danger" role="alert">{detailError}</p> : null}
                {detailLoading ? <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.loading}</p> : null}

                <section className="tw:min-w-0 tw:overflow-hidden tw:rounded-surface tw:border tw:border-border">
                  <header className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:py-3">
                    <h4 className="tw:m-0 tw:text-xs tw:font-medium">{text.articleResult}</h4>
                    {compatibleRuns.length > 0 ? (
                      <label className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-2xs tw:text-muted-foreground">
                        {text.resultRevision}
                        <ControlSelect
                          value={resultRunId}
                          onChange={(event) => setResultRunId(event.target.value)}
                        >
                          {compatibleRuns.map((run) => (
                            <option value={run.id} key={run.id}>
                              r{run.articleRevision} · {dateTime(run.finishedAt, text.never)}
                            </option>
                          ))}
                        </ControlSelect>
                      </label>
                    ) : null}
                  </header>
                  <div className="tw:min-w-0 tw:bg-surface-inset/20 tw:p-6 tw:max-[560px]:p-4">
                    {resultLoading ? <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.loading}</p> : null}
                    {resultError ? <p className="tw:m-0 tw:text-xs tw:text-danger" role="alert">{resultError}</p> : null}
                    {!resultLoading && !resultError && compatibleRuns.length === 0 ? (
                      <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">{text.noCompatibleResult}</p>
                    ) : null}
                    {!resultLoading && !resultError && resultDocument ? (
                      <AnalysisArticleDocument
                        article={resultDocument}
                        eyebrow={text.articleResult}
                        resultLabel={text.resultAsOf}
                      />
                    ) : null}
                  </div>
                </section>

                <div className="tw:grid tw:grid-cols-2 tw:gap-5 tw:max-[880px]:grid-cols-1">
                  <section className="tw:min-w-0 tw:rounded-surface tw:border tw:border-border">
                    <h4 className="tw:m-0 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:text-xs tw:font-medium">{text.latestRuns}</h4>
                    {detail.runs.length === 0 ? <p className="tw:m-0 tw:px-4 tw:py-5 tw:text-xs tw:text-muted-foreground">{text.noRuns}</p> : (
                      <ol className="tw:m-0 tw:list-none tw:p-0">
                        {detail.runs.slice(0, 8).map((run) => (
                          <li className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:last:border-b-0" key={run.id}>
                            <StatusPill value={run.state} />
                            <span className="tw:min-w-0 tw:text-2xs tw:text-muted-foreground">
                              <strong className="tw:block tw:truncate tw:font-medium tw:text-foreground">r{run.articleRevision} · {run.trigger} · {run.rowCount} rows · {bytes(run.byteCount)}</strong>
                              <time>{dateTime(run.finishedAt ?? run.createdAt, text.never)}</time>
                              {run.errorKind ? <small className="tw:mt-1 tw:block tw:truncate tw:text-danger">{run.errorKind}: {run.errorMessage}</small> : null}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>

                  <section className="tw:min-w-0 tw:rounded-surface tw:border tw:border-border">
                    <h4 className="tw:m-0 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:text-xs tw:font-medium">{text.signals}</h4>
                    {detail.signals.length === 0 ? <p className="tw:m-0 tw:px-4 tw:py-5 tw:text-xs tw:text-muted-foreground">{text.noSignals}</p> : (
                      <ol className="tw:m-0 tw:list-none tw:p-0">
                        {detail.signals.map((signal) => (
                          <li className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:last:border-b-0" key={signal.id}>
                            <span className="tw:min-w-0 tw:text-2xs tw:text-muted-foreground">
                              <strong className="tw:block tw:truncate tw:font-medium tw:text-foreground">{signal.blockId} · r{signal.revision}</strong>
                              {signal.definition.channels.join(" · ")}
                            </span>
                            <StatusPill value={signal.enabled ? signal.lastObservedState : "disabled"} label={signal.enabled ? signal.lastObservedState : "disabled"} />
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                </div>

                <section className="tw:min-w-0 tw:rounded-surface tw:border tw:border-border">
                  <h4 className="tw:m-0 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:text-xs tw:font-medium">{text.publications}</h4>
                  {detail.publications.length === 0 ? <p className="tw:m-0 tw:px-4 tw:py-5 tw:text-xs tw:text-muted-foreground">{text.noPublications}</p> : (
                    <ol className="tw:m-0 tw:list-none tw:p-0">
                      {detail.publications.map((publication) => (
                        <li className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:last:border-b-0" key={publication.id}>
                          <span className="tw:min-w-0">
                            <strong className="tw:block tw:truncate tw:text-xs tw:font-medium">{publication.title}</strong>
                            <small className="tw:font-mono tw:text-2xs tw:text-muted-foreground">v{publication.version} · {publication.visibility} · {dateTime(publication.publishedAt, text.never)}</small>
                          </span>
                          {publication.revokedAt ? <StatusPill value="revoked" label={text.revoked} /> : (
                            <a className="tw:text-xs tw:font-medium tw:text-primary tw:hover:underline" href={`/analyses/${encodeURIComponent(publication.slug)}`} target="_blank" rel="noreferrer">
                              {text.openPublication}
                            </a>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {tab === "inbox" ? (
        <section className="tw:p-6 tw:max-[560px]:p-4">
          <div className="tw:mb-4 tw:flex tw:justify-end">
            <ControlButton disabled={selectedNotifications.size === 0 || mutating} onClick={() => void markSelectedRead()}>
              {text.markRead}
            </ControlButton>
          </div>
          {notifications.length === 0 ? <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.inboxEmpty}</p> : (
            <ol className="tw:m-0 tw:list-none tw:overflow-hidden tw:rounded-surface tw:border tw:border-border tw:p-0">
              {notifications.map((notification) => (
                <li className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-4 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:last:border-b-0 tw:max-[620px]:grid-cols-[auto_minmax(0,1fr)]" key={notification.id}>
                  <input
                    aria-label={`${notification.articleTitle} ${notification.state}`}
                    checked={selectedNotifications.has(notification.id)}
                    disabled={Boolean(notification.readAt)}
                    onChange={(event) => setSelectedNotifications((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(notification.id);
                      else next.delete(notification.id);
                      return next;
                    })}
                    type="checkbox"
                  />
                  <button className="tw:min-w-0 tw:border-0 tw:bg-transparent tw:text-left" onClick={() => selectNotification(notification)} type="button">
                    <strong className="tw:block tw:truncate tw:text-xs tw:font-medium tw:text-foreground">{notification.articleTitle}</strong>
                    <small className="tw:mt-1 tw:block tw:truncate tw:font-mono tw:text-2xs tw:text-muted-foreground">{notification.blockId} · signal r{notification.signalRevision} · {dateTime(notification.evaluatedAt, text.never)}</small>
                  </button>
                  <div className="tw:flex tw:items-center tw:gap-2 tw:max-[620px]:col-start-2">
                    <StatusPill value={notification.state} />
                    <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">{notification.readAt ? text.read : text.unread}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {tab === "runners" ? (
        <section className="tw:p-6 tw:max-[560px]:p-4">
          {runners.length === 0 ? <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">{text.runnersEmpty}</p> : (
            <ol className="tw:m-0 tw:grid tw:list-none tw:grid-cols-2 tw:gap-4 tw:p-0 tw:max-[760px]:grid-cols-1">
              {runners.map((runner) => (
                <li className="tw:grid tw:gap-4 tw:rounded-surface tw:border tw:border-border tw:bg-surface-inset/40 tw:p-4" key={runner.id}>
                  <div className="tw:flex tw:items-start tw:justify-between tw:gap-3">
                    <span className="tw:min-w-0">
                      <strong className="tw:block tw:truncate tw:text-xs tw:font-medium">{runner.displayName}</strong>
                      <small className="tw:mt-1 tw:block tw:font-mono tw:text-2xs tw:text-muted-foreground">{runner.backgroundAllowed ? text.background : text.foreground}</small>
                    </span>
                    <StatusPill value={runner.online ? "online" : "offline"} label={runner.online ? text.online : text.offline} />
                  </div>
                  <dl className="tw:m-0 tw:grid tw:grid-cols-2 tw:gap-3 tw:text-2xs">
                    <div><dt className="tw:text-muted-foreground">{text.lastSeen}</dt><dd className="tw:m-0 tw:mt-1 tw:text-foreground">{dateTime(runner.lastSeenAt, text.never)}</dd></div>
                    <div><dt className="tw:text-muted-foreground">Schedule</dt><dd className="tw:m-0 tw:mt-1 tw:text-foreground">{runner.scheduledArticleCount} {text.schedules}</dd></div>
                  </dl>
                  <p className="tw:m-0 tw:text-2xs tw:text-muted-foreground">{runner.online && runner.backgroundAllowed ? text.healthy : text.unavailable}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {tab === "recovery" && canEdit ? (
        <section className="tw:grid tw:gap-5 tw:p-6 tw:max-[560px]:p-4">
          <p className="tw:m-0 tw:max-w-3xl tw:text-xs tw:leading-body tw:text-muted-foreground">
            {text.recoveryDescription}
          </p>
          {migrationFailures.length === 0 ? (
            <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.recoveryEmpty}</p>
          ) : (
            <ol className="tw:m-0 tw:grid tw:list-none tw:gap-4 tw:p-0">
              {migrationFailures.map((failure) => (
                <li className="tw:grid tw:gap-4 tw:rounded-surface tw:border tw:border-warning/35 tw:bg-warning/5 tw:p-4" key={failure.id}>
                  <div className="tw:flex tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
                    <span className="tw:min-w-0">
                      <strong className="tw:block tw:truncate tw:text-sm tw:font-medium">{failure.title}</strong>
                      <small className="tw:mt-1 tw:block tw:font-mono tw:text-2xs tw:text-muted-foreground">
                        {failure.sourceKind.replaceAll("_", " ")} · r{failure.sourceRevision} · {failure.sourceId}
                      </small>
                    </span>
                    <StatusPill value="stale" label={failure.sourceKind.replaceAll("_", " ")} />
                  </div>
                  <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-foreground">{failure.failureReason}</p>
                  <details className="tw:min-w-0 tw:rounded-control tw:border tw:border-border tw:bg-surface">
                    <summary className="tw:cursor-pointer tw:px-3 tw:py-2 tw:text-xs tw:font-medium tw:text-muted-foreground">{text.original}</summary>
                    <pre className="tw:m-0 tw:max-h-80 tw:overflow-auto tw:border-t tw:border-border tw:p-3 tw:font-mono tw:text-2xs tw:leading-body tw:text-muted-foreground">{JSON.stringify(failure.payload, null, 2)}</pre>
                  </details>
                  <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-3 tw:max-[620px]:grid-cols-1">
                    <label className="tw:grid tw:gap-2">
                      <span className="tw:font-mono tw:text-2xs tw:font-medium tw:uppercase tw:text-muted-foreground">{text.replacement}</span>
                      <ControlSelect
                        value={replacementByFailure[failure.id] ?? ""}
                        onChange={(event) => setReplacementByFailure((current) => ({
                          ...current,
                          [failure.id]: event.target.value,
                        }))}
                      >
                        <option value="">{text.chooseReplacement}</option>
                        {articles.map((article) => (
                          <option value={article.id} key={article.id}>{article.definition.title} · r{article.revision} · {article.state}</option>
                        ))}
                      </ControlSelect>
                    </label>
                    <ControlButton
                      disabled={!replacementByFailure[failure.id] || mutating}
                      onClick={() => void resolveFailure(failure.id)}
                    >
                      {mutating ? text.resolving : text.resolve}
                    </ControlButton>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
