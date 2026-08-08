"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ControlButton,
  ControlField,
  ControlInput,
  ControlSelect,
} from "../components/Controls";
import { useWorkspaceLocale } from "../components/WorkspaceLocale";

type Runner = {
  id: string;
  displayName: string;
  backgroundAllowed: boolean;
  lastSeenAt: string;
  online: boolean;
};
type Recipient = { id: string; name: string; email: string; role: string };
type Analysis = {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  revision: number;
  connections: Array<{
    connectionId: string;
    connectionRevision: number;
    role: string;
    alias: string;
  }>;
  definition: {
    title: string;
    timezone: string;
    tiles: Array<{ id: string; title: string; kind: string; dashboardId?: string }>;
  };
};
type SignalState = "normal" | "firing" | "recovered" | "no_data" | "error" | "stale" | "runner_offline";
type Rule = {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceAnalysisId: string;
  sourceAnalysisRevision: number;
  sourceTileId: string;
  metricSemanticId: string;
  connections: Array<{ connectionId: string; connectionRevision: number }>;
  definition: {
    schedule: string;
    timezone: string;
    condition: { kind: string; value?: number; percentage?: number; count?: number };
    severity: string;
    channels: string[];
  };
  runnerId: string | null;
  enabled: boolean;
  status: "active" | "paused" | "disabled";
  revision: number;
  nextEvaluationAt: string;
  latestEvaluation: null | {
    state: SignalState;
    observedState: string;
    evaluatedAt: string;
    errorKind: string | null;
  };
  runner: Runner | null;
  actuallyMonitoring: boolean;
};
type Notification = {
  id: string;
  ruleId: string;
  metricSemanticId: string;
  severity: string;
  state: SignalState;
  observedState: string;
  createdAt: string;
  readAt: string | null;
};
type Receipt = {
  id: string;
  ruleRevision: number;
  environmentRevision: number;
  evaluatedAt: string;
  observedState: string;
  state: SignalState;
  connectionIds: string[];
  durationMs: number;
  rowCountCategory: string;
  transitionSequence: number;
  errorKind: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).valueOf());
}

function validRunner(value: unknown): value is Runner {
  const row = object(value);
  return Boolean(row && typeof row.id === "string" && typeof row.displayName === "string"
    && typeof row.backgroundAllowed === "boolean" && validDate(row.lastSeenAt)
    && typeof row.online === "boolean");
}

function validRecipient(value: unknown): value is Recipient {
  const row = object(value);
  return Boolean(row && typeof row.id === "string" && typeof row.name === "string"
    && typeof row.email === "string" && typeof row.role === "string");
}

function validAnalysis(value: unknown): value is Analysis {
  const row = object(value);
  const definition = object(row?.definition);
  return Boolean(row && definition && typeof row.id === "string"
    && typeof row.projectEnvironmentId === "string" && Number.isSafeInteger(row.environmentRevision)
    && Number.isSafeInteger(row.revision) && typeof definition.title === "string"
    && typeof definition.timezone === "string" && Array.isArray(definition.tiles)
    && definition.tiles.every((tile) => {
      const item = object(tile);
      return item && typeof item.id === "string" && typeof item.title === "string"
        && typeof item.kind === "string"
        && (item.dashboardId === undefined || typeof item.dashboardId === "string");
    }) && Array.isArray(row.connections) && row.connections.every((connection) => {
      const item = object(connection);
      return item && typeof item.connectionId === "string"
        && Number.isSafeInteger(item.connectionRevision)
        && typeof item.role === "string" && typeof item.alias === "string";
    }));
}

function validRule(value: unknown): value is Rule {
  const row = object(value);
  const definition = object(row?.definition);
  const condition = object(definition?.condition);
  const evaluation = row?.latestEvaluation === null ? null : object(row?.latestEvaluation);
  const runner = row?.runner === null ? null : object(row?.runner);
  return Boolean(row && definition && condition && typeof row.id === "string"
    && typeof row.projectEnvironmentId === "string" && Number.isSafeInteger(row.environmentRevision)
    && typeof row.sourceAnalysisId === "string" && Number.isSafeInteger(row.sourceAnalysisRevision)
    && typeof row.sourceTileId === "string" && Array.isArray(row.connections)
    && row.connections.every((connection) => {
      const item = object(connection);
      return item && typeof item.connectionId === "string"
        && Number.isSafeInteger(item.connectionRevision);
    })
    && typeof row.metricSemanticId === "string" && typeof definition.schedule === "string"
    && typeof definition.timezone === "string" && typeof condition.kind === "string"
    && typeof definition.severity === "string" && Array.isArray(definition.channels)
    && (row.runnerId === null || typeof row.runnerId === "string")
    && typeof row.enabled === "boolean" && ["active", "paused", "disabled"].includes(String(row.status))
    && Number.isSafeInteger(row.revision) && validDate(row.nextEvaluationAt)
    && typeof row.actuallyMonitoring === "boolean"
    && (evaluation === null || (typeof evaluation.state === "string"
      && typeof evaluation.observedState === "string" && validDate(evaluation.evaluatedAt)
      && (evaluation.errorKind === null || typeof evaluation.errorKind === "string")))
    && (runner === null || validRunner(runner)));
}

function validNotification(value: unknown): value is Notification {
  const row = object(value);
  return Boolean(row && typeof row.id === "string" && typeof row.ruleId === "string"
    && typeof row.metricSemanticId === "string" && typeof row.severity === "string"
    && typeof row.state === "string" && typeof row.observedState === "string"
    && validDate(row.createdAt) && (row.readAt === null || validDate(row.readAt)));
}

function validReceipt(value: unknown): value is Receipt {
  const row = object(value);
  return Boolean(row && typeof row.id === "string" && Number.isSafeInteger(row.ruleRevision)
    && Number.isSafeInteger(row.environmentRevision) && validDate(row.evaluatedAt)
    && typeof row.observedState === "string" && typeof row.state === "string"
    && Array.isArray(row.connectionIds) && row.connectionIds.every((id) => typeof id === "string")
    && Number.isSafeInteger(row.durationMs) && typeof row.rowCountCategory === "string"
    && Number.isSafeInteger(row.transitionSequence)
    && (row.errorKind === null || typeof row.errorKind === "string"));
}

const copyByLocale = {
  en: {
    tabs: ["Rules", "Firing", "Health"], create: "New rule", cancel: "Cancel",
    configured: "Configured", monitoring: "Actually monitoring", active: "Active",
    paused: "Paused", disabled: "Disabled", online: "Online", offline: "Offline",
    noRunner: "No Desktop runner", noRules: "No signal rules yet.", noFiring: "Nothing needs attention.",
    noHealth: "No Desktop runner has registered for this workspace. Open DopeDB Desktop while signed in.",
    runNow: "Run now", pause: "Pause", enable: "Enable", disable: "Disable", timeline: "Timeline",
    source: "Published metric", runner: "Desktop runner", schedule: "Schedule", condition: "Condition",
    value: "Condition value", severity: "Severity", recipients: "Recipients", channels: "Delivery",
    window: "Evaluation window", createAction: "Create signal", creating: "Creating…",
    production: "I approve monitoring this Environment if it is classified as production.",
    enabled: "Start monitoring immediately", refresh: "Refresh", markRead: "Mark read",
    loadError: "Could not load monitoring state.", mutationError: "The signal changed. Refresh and try again.",
    requirement: "Publish a funnel analysis with a metric tile and open Desktop before creating a rule.",
    desktop: "Desktop", web: "Workspace inbox", email: "Email",
    review: "Execution boundary", revision: "Pinned revisions", databaseScope: "Database scope",
    readOnly: "Read-only grants are rechecked by the server and Desktop before every evaluation.",
    expectedLoad: "Expected load", openDashboard: "Open dashboard revision",
    offlineEnable: "Choose an online Desktop runner before enabling monitoring.",
  },
  ko: {
    tabs: ["규칙", "발생 중", "상태"], create: "새 규칙", cancel: "취소",
    configured: "설정 상태", monitoring: "실제 감시", active: "활성",
    paused: "일시정지", disabled: "비활성", online: "온라인", offline: "오프라인",
    noRunner: "Desktop 실행기 없음", noRules: "아직 신호 규칙이 없습니다.", noFiring: "확인할 신호가 없습니다.",
    noHealth: "이 워크스페이스에 등록된 Desktop 실행기가 없습니다. 로그인한 DopeDB Desktop을 열어 두세요.",
    runNow: "지금 실행", pause: "일시정지", enable: "활성화", disable: "비활성화", timeline: "타임라인",
    source: "발행된 지표", runner: "Desktop 실행기", schedule: "주기", condition: "조건",
    value: "조건값", severity: "심각도", recipients: "수신자", channels: "알림 채널",
    window: "평가 구간", createAction: "신호 만들기", creating: "생성 중…",
    production: "이 Environment가 운영으로 분류된 경우 감시 실행을 승인합니다.",
    enabled: "만든 직후 감시 시작", refresh: "새로고침", markRead: "읽음 처리",
    loadError: "모니터링 상태를 불러오지 못했습니다.", mutationError: "신호가 변경되었습니다. 새로고침 후 다시 시도하세요.",
    requirement: "지표 타일이 있는 퍼널 분석을 발행하고 Desktop을 연 뒤 규칙을 만드세요.",
    desktop: "Desktop", web: "워크스페이스 보관함", email: "이메일",
    review: "실행 경계", revision: "고정된 revision", databaseScope: "DB 범위",
    readOnly: "서버와 Desktop이 매 평가 전에 읽기 전용 grant를 다시 확인합니다.",
    expectedLoad: "예상 부하", openDashboard: "대시보드 revision 열기",
    offlineEnable: "감시를 활성화하려면 온라인 Desktop 실행기를 선택하세요.",
  },
} as const;

function date(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function conditionLabel(rule: Rule) {
  const condition = rule.definition.condition;
  if (condition.kind === "threshold_above") return `> ${condition.value}`;
  if (condition.kind === "threshold_below") return `< ${condition.value}`;
  if (condition.kind === "percentage_change") return `Δ ${condition.percentage}%`;
  if (condition.kind === "absolute_change") return `Δ ${condition.value}`;
  return `${condition.kind.replaceAll("_", " ")} × ${condition.count}`;
}

export function SignalMonitoringPanel({
  workspaceId,
  canEditWorkspace,
}: {
  workspaceId: string;
  canEditWorkspace: boolean;
}) {
  const locale = useWorkspaceLocale();
  const copy = copyByLocale[locale];
  const [tab, setTab] = useState<"rules" | "firing" | "health">("rules");
  const [rules, setRules] = useState<Rule[]>([]);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [source, setSource] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [schedule, setSchedule] = useState("*/15 * * * *");
  const [conditionKind, setConditionKind] = useState("threshold_above");
  const [conditionValue, setConditionValue] = useState("1");
  const [severity, setSeverity] = useState("warning");
  const [windowSeconds, setWindowSeconds] = useState("3600");
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>(["desktop", "workspace_web"]);
  const [enabled, setEnabled] = useState(true);
  const [productionConfirmed, setProductionConfirmed] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [receipts, setReceipts] = useState<Receipt[]>([]);

  const metricSources = useMemo(() => analyses.flatMap((analysis) =>
    analysis.definition.tiles.filter((tile) => tile.kind === "metric").map((tile) => ({ analysis, tile }))), [analyses]);
  const selectedSource = metricSources.find(({ analysis, tile }) => `${analysis.id}:${tile.id}` === source) ?? null;
  const selectedRunner = runners.find((runner) => runner.id === runnerId) ?? null;
  const firing = rules.filter((rule) => rule.latestEvaluation
    && ["firing", "no_data", "error", "stale", "runner_offline"].includes(rule.latestEvaluation.state));

  const responseError = useCallback(async (response: Response | null, fallback: string) => {
    const body = await response?.json().catch(() => null);
    return typeof body?.error === "string" ? body.error : fallback;
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const base = `/api/v1/workspaces/${workspaceId}/signals`;
    const responses = await Promise.all([
      fetch(base, { cache: "no-store", signal }).catch(() => null),
      fetch(`${base}/runners`, { cache: "no-store", signal }).catch(() => null),
      fetch(`${base}/recipients`, { cache: "no-store", signal }).catch(() => null),
      fetch(`${base}/notifications`, { cache: "no-store", signal }).catch(() => null),
      fetch(`/api/v1/workspaces/${workspaceId}/funnel-analyses`, { cache: "no-store", signal }).catch(() => null),
    ]);
    if (signal?.aborted) return;
    const failed = responses.find((response) => !response?.ok) ?? null;
    if (failed || responses.some((response) => response === null)) {
      setError(await responseError(failed, copy.loadError));
      setLoading(false);
      return;
    }
    const bodies = await Promise.all(responses.map((response) => response!.json().catch(() => null)));
    if (!Array.isArray(bodies[0]?.rules) || !bodies[0].rules.every(validRule)
      || !Array.isArray(bodies[1]?.runners) || !bodies[1].runners.every(validRunner)
      || !Array.isArray(bodies[2]?.recipients) || !bodies[2].recipients.every(validRecipient)
      || !Array.isArray(bodies[3]?.notifications) || !bodies[3].notifications.every(validNotification)
      || !Array.isArray(bodies[4]?.analyses) || !bodies[4].analyses.every(validAnalysis)) {
      setError(copy.loadError);
      setLoading(false);
      return;
    }
    setRules(bodies[0].rules);
    setRunners(bodies[1].runners);
    setRecipients(bodies[2].recipients);
    setNotifications(bodies[3].notifications);
    setAnalyses(bodies[4].analyses);
    setRunnerId((current) => current || bodies[1].runners.find((runner: Runner) => runner.online)?.id || bodies[1].runners[0]?.id || "");
    setSelectedRecipients((current) => current.length > 0 ? current : bodies[2].recipients.slice(0, 1).map((member: Recipient) => member.id));
    setSource((current) => current || (() => {
      const analysis = bodies[4].analyses.find((candidate: Analysis) => candidate.definition.tiles.some((tile) => tile.kind === "metric"));
      const tile = analysis?.definition.tiles.find((candidate: { kind: string }) => candidate.kind === "metric");
      return analysis && tile ? `${analysis.id}:${tile.id}` : "";
    })());
    setError("");
    setLoading(false);
  }, [copy.loadError, responseError, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const ruleId = new URLSearchParams(window.location.search).get("signal");
    if (ruleId) setSelectedRuleId(ruleId);
  }, []);

  useEffect(() => {
    if (!selectedRuleId) {
      setReceipts([]);
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/v1/workspaces/${workspaceId}/signals/${selectedRuleId}/receipts`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.receipts) || !body.receipts.every(validReceipt)) {
        setError(typeof body?.error === "string" ? body.error : copy.loadError);
        return;
      }
      setReceipts(body.receipts);
      window.setTimeout(() => document.getElementById(`signal-${selectedRuleId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [copy.loadError, selectedRuleId, workspaceId]);

  async function command(rule: Rule, action: "pause" | "enable" | "disable" | "run_now" | "runner_change", nextRunnerId?: string) {
    setMutating(true);
    const response = await fetch(`/api/v1/workspaces/${workspaceId}/signals/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": `"${rule.revision}"` },
      body: JSON.stringify(action === "runner_change" ? { action, runnerId: nextRunnerId } : { action }),
    }).catch(() => null);
    if (!response?.ok) setError(await responseError(response, copy.mutationError));
    else await load();
    setMutating(false);
  }

  async function createRule() {
    if (!selectedSource || !runnerId || selectedRecipients.length === 0 || channels.length === 0) return;
    setMutating(true);
    const numeric = Number(conditionValue);
    const condition = conditionKind === "percentage_change"
      ? { kind: conditionKind, percentage: numeric }
      : conditionKind === "missing_data" || conditionKind === "consecutive_failure"
        ? { kind: conditionKind, count: numeric }
        : { kind: conditionKind, value: numeric };
    const response = await fetch(`/api/v1/workspaces/${workspaceId}/signals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": '"0"' },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        projectEnvironmentId: selectedSource.analysis.projectEnvironmentId,
        environmentRevision: selectedSource.analysis.environmentRevision,
        sourceAnalysisId: selectedSource.analysis.id,
        sourceAnalysisRevision: selectedSource.analysis.revision,
        sourceTileId: selectedSource.tile.id,
        metricSemanticId: selectedSource.tile.id,
        connections: selectedSource.analysis.connections.map(({ connectionId, connectionRevision }) => ({ connectionId, connectionRevision })),
        schedule,
        timezone: selectedSource.analysis.definition.timezone,
        evaluationWindowSeconds: Number(windowSeconds),
        condition,
        baselineWindowSeconds: conditionKind.includes("change") ? 86400 : null,
        minimumSampleCount: 1,
        cooldownSeconds: 3600,
        rearmAfterNormalCount: 1,
        severity,
        recipientMemberIds: selectedRecipients,
        channels,
        runnerId,
        enabled,
        productionConfirmed,
      }),
    }).catch(() => null);
    if (!response?.ok) setError(await responseError(response, copy.mutationError));
    else {
      setCreating(false);
      await load();
    }
    setMutating(false);
  }

  async function markRead(ids: string[]) {
    const response = await fetch(`/api/v1/workspaces/${workspaceId}/signals/notifications`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_read", notificationIds: ids }),
    }).catch(() => null);
    if (!response?.ok) setError(await responseError(response, copy.mutationError));
    else await load();
  }

  const toggle = (values: string[], value: string, setter: (next: string[]) => void) => {
    setter(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  };

  return (
    <div className="tw:min-w-0">
      <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:px-5 tw:py-3">
        <div className="tw:flex tw:gap-1" role="tablist">
          {(["rules", "firing", "health"] as const).map((item, index) => (
            <button className="tw:rounded-control tw:px-3 tw:py-2 tw:text-2xs tw:font-medium tw:text-muted-foreground tw:data-[active=true]:bg-selection tw:data-[active=true]:text-primary" data-active={tab === item} key={item} onClick={() => setTab(item)} role="tab" type="button">
              {copy.tabs[index]}{item === "firing" && firing.length > 0 ? ` · ${firing.length}` : ""}
            </button>
          ))}
        </div>
        <div className="tw:flex tw:gap-2">
          <ControlButton disabled={loading || mutating} onClick={() => void load()}>{copy.refresh}</ControlButton>
          {tab === "rules" && canEditWorkspace ? <ControlButton tone="primary" onClick={() => setCreating((value) => !value)}>{creating ? copy.cancel : copy.create}</ControlButton> : null}
        </div>
      </div>

      {error ? <p className="tw:m-5 tw:rounded-surface tw:border tw:border-danger/30 tw:bg-danger/5 tw:px-4 tw:py-3 tw:text-xs tw:text-danger">{error}</p> : null}

      {tab === "rules" && creating ? (
        <section className="tw:grid tw:gap-5 tw:border-b tw:border-border tw:bg-surface-inset/45 tw:p-5">
          <div className="tw:grid tw:grid-cols-3 tw:gap-4 tw:max-[860px]:grid-cols-2 tw:max-[560px]:grid-cols-1">
            <ControlField label={copy.source}><ControlSelect value={source} onChange={(event) => setSource(event.target.value)}><option value="">—</option>{metricSources.map(({ analysis, tile }) => <option key={`${analysis.id}:${tile.id}`} value={`${analysis.id}:${tile.id}`}>{analysis.definition.title} · {tile.title}</option>)}</ControlSelect></ControlField>
            <ControlField label={copy.runner}><ControlSelect value={runnerId} onChange={(event) => setRunnerId(event.target.value)}><option value="">—</option>{runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.displayName} · {runner.online ? copy.online : copy.offline}</option>)}</ControlSelect></ControlField>
            <ControlField label={copy.schedule}><ControlSelect value={schedule} onChange={(event) => setSchedule(event.target.value)}><option value="*/5 * * * *">5 min</option><option value="*/15 * * * *">15 min</option><option value="0 * * * *">1 hour</option><option value="0 9 * * *">09:00 daily</option></ControlSelect></ControlField>
            <ControlField label={copy.condition}><ControlSelect value={conditionKind} onChange={(event) => setConditionKind(event.target.value)}><option value="threshold_above">Above</option><option value="threshold_below">Below</option><option value="absolute_change">Absolute change</option><option value="percentage_change">Percentage change</option><option value="missing_data">Missing data</option><option value="consecutive_failure">Consecutive failure</option></ControlSelect></ControlField>
            <ControlField label={copy.value}><ControlInput min="0" step="any" type="number" value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} /></ControlField>
            <ControlField label={copy.window}><ControlSelect value={windowSeconds} onChange={(event) => setWindowSeconds(event.target.value)}><option value="900">15 min</option><option value="3600">1 hour</option><option value="86400">24 hours</option><option value="604800">7 days</option></ControlSelect></ControlField>
            <ControlField label={copy.severity}><ControlSelect value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></ControlSelect></ControlField>
          </div>
          <fieldset className="tw:grid tw:gap-2"><legend className="tw:mb-2 tw:font-mono tw:text-2xs tw:font-medium tw:tracking-[0.06em] tw:uppercase tw:text-muted-foreground">{copy.recipients}</legend><div className="tw:flex tw:flex-wrap tw:gap-2">{recipients.map((member) => <label className="tw:flex tw:items-center tw:gap-2 tw:rounded-control tw:border tw:border-border tw:bg-surface tw:px-3 tw:py-2 tw:text-2xs" key={member.id}><input checked={selectedRecipients.includes(member.id)} onChange={() => toggle(selectedRecipients, member.id, setSelectedRecipients)} type="checkbox" />{member.name} · {member.role}</label>)}</div></fieldset>
          <fieldset className="tw:grid tw:gap-2"><legend className="tw:mb-2 tw:font-mono tw:text-2xs tw:font-medium tw:tracking-[0.06em] tw:uppercase tw:text-muted-foreground">{copy.channels}</legend><div className="tw:flex tw:flex-wrap tw:gap-2">{[["desktop", copy.desktop], ["workspace_web", copy.web], ["email", copy.email]].map(([value, label]) => <label className="tw:flex tw:items-center tw:gap-2 tw:rounded-control tw:border tw:border-border tw:bg-surface tw:px-3 tw:py-2 tw:text-2xs" key={value}><input checked={channels.includes(value)} onChange={() => toggle(channels, value, setChannels)} type="checkbox" />{label}</label>)}</div></fieldset>
          <div className="tw:grid tw:gap-2 tw:text-xs tw:text-muted-foreground"><label className="tw:flex tw:items-start tw:gap-2"><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />{copy.enabled}</label><label className="tw:flex tw:items-start tw:gap-2"><input checked={productionConfirmed} onChange={(event) => setProductionConfirmed(event.target.checked)} type="checkbox" />{copy.production}</label></div>
          {selectedSource ? <section className="tw:grid tw:gap-3 tw:border-y tw:border-border tw:py-4" aria-label={copy.review}><div className="tw:grid tw:grid-cols-3 tw:gap-4 tw:text-2xs tw:max-[720px]:grid-cols-1"><div><strong className="tw:block tw:font-medium tw:text-foreground">{copy.revision}</strong><span className="tw:mt-1 tw:block tw:font-mono tw:text-muted-foreground">Environment r{selectedSource.analysis.environmentRevision} · Analysis r{selectedSource.analysis.revision}</span></div><div><strong className="tw:block tw:font-medium tw:text-foreground">{copy.databaseScope}</strong><span className="tw:mt-1 tw:block tw:text-muted-foreground">{selectedSource.analysis.connections.map((connection) => `${connection.alias} · r${connection.connectionRevision}`).join(", ")}</span></div><div><strong className="tw:block tw:font-medium tw:text-foreground">{copy.expectedLoad}</strong><span className="tw:mt-1 tw:block tw:text-muted-foreground">{schedule} · {Number(windowSeconds) / 60} min window</span></div></div><p className="tw:m-0 tw:text-2xs tw:text-muted-foreground">{copy.readOnly}</p></section> : null}
          <div className="tw:flex tw:items-center tw:justify-between tw:gap-4"><p className="tw:text-2xs tw:text-muted-foreground">{enabled && selectedRunner && !selectedRunner.online ? copy.offlineEnable : copy.requirement}</p><ControlButton disabled={mutating || !selectedSource || !runnerId || (enabled && !selectedRunner?.online) || selectedRecipients.length === 0 || channels.length === 0} onClick={() => void createRule()} tone="primary">{mutating ? copy.creating : copy.createAction}</ControlButton></div>
        </section>
      ) : null}

      {tab === "rules" ? <div className="tw:divide-y tw:divide-border">{rules.map((rule) => (
        <article className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-5 tw:p-5 tw:max-[720px]:grid-cols-1" id={`signal-${rule.id}`} key={rule.id}>
          <div className="tw:min-w-0"><div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2"><h4 className="tw:truncate tw:text-sm tw:font-medium">{rule.metricSemanticId}</h4><span className="tw:rounded-full tw:bg-surface-inset tw:px-2 tw:py-1 tw:font-mono tw:text-2xs tw:text-muted-foreground">{conditionLabel(rule)}</span></div><dl className="tw:mt-3 tw:grid tw:grid-cols-2 tw:gap-x-5 tw:gap-y-2 tw:text-2xs tw:max-[480px]:grid-cols-1"><div className="tw:flex tw:justify-between tw:gap-3"><dt className="tw:text-muted-foreground">{copy.configured}</dt><dd>{rule.status === "active" ? copy.active : rule.status === "paused" ? copy.paused : copy.disabled}</dd></div><div className="tw:flex tw:justify-between tw:gap-3"><dt className="tw:text-muted-foreground">{copy.monitoring}</dt><dd className={rule.actuallyMonitoring ? "tw:text-success" : "tw:text-danger"}>{rule.actuallyMonitoring ? copy.online : copy.offline}</dd></div><div className="tw:flex tw:justify-between tw:gap-3"><dt className="tw:text-muted-foreground">{copy.runner}</dt><dd className="tw:truncate">{rule.runner?.displayName ?? copy.noRunner}</dd></div><div className="tw:flex tw:justify-between tw:gap-3"><dt className="tw:text-muted-foreground">Next</dt><dd>{date(rule.nextEvaluationAt)}</dd></div></dl></div>
          <div className="tw:flex tw:flex-wrap tw:items-start tw:justify-end tw:gap-2"><ControlButton onClick={() => setSelectedRuleId((current) => current === rule.id ? "" : rule.id)}>{copy.timeline}</ControlButton>{canEditWorkspace ? <><ControlButton disabled={mutating || !rule.runner?.online} onClick={() => void command(rule, "run_now")}>{copy.runNow}</ControlButton>{rule.status === "active" ? <ControlButton disabled={mutating} onClick={() => void command(rule, "pause")}>{copy.pause}</ControlButton> : <ControlButton disabled={mutating || !rule.runner?.online} onClick={() => void command(rule, "enable")}>{copy.enable}</ControlButton>}<ControlButton disabled={mutating || rule.status === "disabled"} onClick={() => void command(rule, "disable")} tone="danger">{copy.disable}</ControlButton><div className="tw:min-w-44"><ControlSelect aria-label={copy.runner} disabled={mutating} value={rule.runnerId ?? ""} onChange={(event) => void command(rule, "runner_change", event.target.value)}><option value="">—</option>{runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.displayName}</option>)}</ControlSelect></div></> : null}</div>
          {selectedRuleId === rule.id ? <section className="tw:col-span-2 tw:grid tw:gap-3 tw:border-t tw:border-border tw:pt-4 tw:max-[720px]:col-span-1"><div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:text-2xs tw:text-muted-foreground"><span className="tw:font-mono">Rule r{rule.revision} · Environment r{rule.environmentRevision} · Analysis r{rule.sourceAnalysisRevision}</span>{(() => { const analysis = analyses.find((candidate) => candidate.id === rule.sourceAnalysisId); const tile = analysis?.definition.tiles.find((candidate) => candidate.id === rule.sourceTileId); return tile?.dashboardId ? <a className="tw:font-medium tw:text-primary tw:hover:underline" href={`?workspace=${encodeURIComponent(workspaceId)}&section=dashboards&dashboard=${encodeURIComponent(tile.dashboardId)}`}>{copy.openDashboard}</a> : null; })()}</div><p className="tw:m-0 tw:font-mono tw:text-2xs tw:text-muted-foreground">{rule.connections.map((connection) => `${connection.connectionId} · r${connection.connectionRevision}`).join(" · ")}</p><ol className="tw:grid tw:gap-2">{receipts.map((receipt) => <li className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:rounded-surface tw:bg-surface-inset tw:px-3 tw:py-2 tw:text-2xs" key={receipt.id}><span className="tw:font-mono tw:text-muted-foreground">#{receipt.transitionSequence}</span><span className="tw:min-w-0 tw:truncate"><strong className={receipt.state === "normal" || receipt.state === "recovered" ? "tw:text-success" : "tw:text-danger"}>{receipt.state.replaceAll("_", " ")}</strong> · {receipt.connectionIds.length} DB · {receipt.durationMs} ms · {receipt.rowCountCategory}{receipt.errorKind ? ` · ${receipt.errorKind}` : ""}</span><time className="tw:text-muted-foreground">{date(receipt.evaluatedAt)}</time></li>)}</ol></section> : null}
        </article>
      ))}{!loading && rules.length === 0 ? <p className="tw:p-10 tw:text-center tw:text-xs tw:text-muted-foreground">{copy.noRules}</p> : null}</div> : null}

      {tab === "firing" ? <div className="tw:divide-y tw:divide-border">{firing.map((rule) => <article className="tw:flex tw:items-start tw:justify-between tw:gap-5 tw:p-5" key={rule.id}><div><h4 className="tw:text-sm tw:font-medium">{rule.metricSemanticId}</h4><p className="tw:mt-1 tw:text-xs tw:text-danger">{rule.latestEvaluation?.state.replaceAll("_", " ")}{rule.latestEvaluation?.errorKind ? ` · ${rule.latestEvaluation.errorKind}` : ""}</p><p className="tw:mt-2 tw:font-mono tw:text-2xs tw:text-muted-foreground">{rule.latestEvaluation ? date(rule.latestEvaluation.evaluatedAt) : ""}</p></div>{canEditWorkspace ? <ControlButton disabled={mutating || !rule.runner?.online} onClick={() => void command(rule, "run_now")}>{copy.runNow}</ControlButton> : null}</article>)}{firing.length === 0 ? <p className="tw:p-10 tw:text-center tw:text-xs tw:text-muted-foreground">{copy.noFiring}</p> : null}{notifications.filter((item) => !item.readAt).map((item) => <article className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:bg-selection/40 tw:px-5 tw:py-3" key={item.id}><p className="tw:text-xs"><strong>{item.metricSemanticId}</strong> · {item.state.replaceAll("_", " ")} · {date(item.createdAt)}</p><ControlButton onClick={() => { setTab("rules"); setSelectedRuleId(item.ruleId); void markRead([item.id]); }}>{copy.timeline}</ControlButton></article>)}</div> : null}

      {tab === "health" ? <div className="tw:divide-y tw:divide-border">{runners.map((runner) => <article className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-4 tw:p-5" key={runner.id}><div><h4 className="tw:text-sm tw:font-medium">{runner.displayName}</h4><p className="tw:mt-1 tw:font-mono tw:text-2xs tw:text-muted-foreground">Last seen {date(runner.lastSeenAt)} · {runner.backgroundAllowed ? "background allowed" : "foreground only"}</p></div><span className={`tw:flex tw:items-center tw:gap-2 tw:text-xs ${runner.online ? "tw:text-success" : "tw:text-danger"}`}><i className="tw:size-1.5 tw:rounded-full tw:bg-current" />{runner.online ? copy.online : copy.offline}</span></article>)}{runners.length === 0 ? <p className="tw:p-10 tw:text-center tw:text-xs tw:text-muted-foreground">{copy.noHealth}</p> : null}</div> : null}
    </div>
  );
}
