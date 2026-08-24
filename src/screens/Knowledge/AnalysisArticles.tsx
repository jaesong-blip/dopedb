import { useEffect, useState } from "react";

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
  type AnalysisCollaboratorDirectory,
  type AnalysisParameterValue,
  type AnalysisRunner,
} from "../../features/analysisArticles/domain";
import { useAnalysisArticlesController } from "../../features/analysisArticles/useAnalysisArticlesController";
import type {
  EnvironmentConnection,
  KnowledgeEnvironment,
} from "../../features/knowledge/domain";
import { Button } from "../../design-system/components/Button";
import { SelectInput } from "../../design-system/components/FormControls";
import { PanelTabs } from "../../design-system/components/PanelTabs";
import {
  InlineNotice,
  LoadingLabel,
  StatusBadge,
  StatusDot,
  type StatusTone,
} from "../../design-system/components/Status";
import {
  WorkbenchButton,
  WorkbenchDivider,
  WorkbenchEmptyState,
  WorkbenchToolbar,
} from "../../design-system/components/Workbench";
import { useI18n } from "../../lib/i18n";

type Translate = ReturnType<typeof useI18n>["t"];

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

function relativeTime(value: string | null, locale: string, never: string): string {
  if (!value) return never;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.round((time - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
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

function sourceLabel(article: AnalysisArticleRecord, t: Translate): string {
  if (article.definition.source === "dopedb.acp.claude") return "Claude";
  if (article.definition.source === "dopedb.acp.codex") return "Codex";
  if (article.definition.source === "migration") return t("analysis.sourceMigrated");
  return t("analysis.sourceHuman");
}

function stateLabel(state: AnalysisArticleState, t: Translate): string {
  if (state === "draft") return t("analysis.stateDraft");
  if (state === "review") return t("analysis.stateReview");
  if (state === "live") return t("analysis.stateLive");
  return t("analysis.stateArchived");
}

function freshnessLabel(value: ReturnType<typeof articleFreshness>, t: Translate): string {
  if (value === "fresh") return t("analysis.freshnessFresh");
  if (value === "never_run") return t("analysis.freshnessNeverRun");
  if (value === "running") return t("analysis.freshnessRunning");
  if (value === "failed") return t("analysis.freshnessFailed");
  return t("analysis.freshnessStale");
}

export default function AnalysisArticles({
  projectName,
  environment,
  bindings,
  sharedWorkspace,
  scopeKey,
  focusId,
  onOpenAgent,
  onNewConnection,
}: {
  projectName: string;
  environment: KnowledgeEnvironment;
  bindings: readonly EnvironmentConnection[];
  sharedWorkspace: boolean;
  scopeKey: string;
  focusId?: string | null;
  onOpenAgent?: (connectionId: string, environmentId?: string, prompt?: string) => void;
  onNewConnection?: () => void;
}) {
  const { t } = useI18n();
  const {
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
  } = useAnalysisArticlesController({
    environment,
    bindings,
    sharedWorkspace,
    scopeKey,
    focusId,
    onOpenAgent,
  });

  if (!sharedWorkspace) {
    return (
      <WorkbenchEmptyState icon="chart">
        <strong>{t("analysis.teamOnlyTitle")}</strong>
        <span>{t("analysis.teamOnlyBody")}</span>
      </WorkbenchEmptyState>
    );
  }

  return (
    <div className="tw:flex tw:min-h-[calc(100dvh-90px)] tw:min-w-0 tw:flex-col tw:bg-background">
      <WorkbenchToolbar label={t("analysis.title")}>
        {agentBinding?.connectionId && onOpenAgent ? (
          <>
            <WorkbenchButton onClick={askAgent}>
              <Icon name="terminal" />
              {t("analysis.askAgent")}
            </WorkbenchButton>
            <WorkbenchDivider />
          </>
        ) : null}
        <WorkbenchButton
          iconOnly
          title={t("analysis.refresh")}
          aria-label={t("analysis.refresh")}
          onClick={() => void articles.refetch()}
        >
          <Icon name="refresh" className={articles.isFetching ? "tw:animate-spin tw:motion-reduce:animate-none" : undefined} />
        </WorkbenchButton>
        <span className="tw:ml-auto tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:text-xs tw:text-muted-foreground">
          <StatusDot tone={runnerState?.state === "failed" || runnerState?.state === "deferred" ? "warning" : "success"} />
          <span className="tw:truncate">
            {runnerState?.state === "running"
              ? t("analysis.runnerRefreshing")
              : t("analysis.runnerOnline", { count: runners.data?.filter((runner) => runner.online).length ?? 0 })}
          </span>
        </span>
      </WorkbenchToolbar>

      {actionError ? (
        <div className="tw:px-3 tw:pt-3">
          <InlineNotice tone="danger" icon="alert" role="alert">{actionError}</InlineNotice>
        </div>
      ) : null}

      <main className="tw:flex tw:min-h-0 tw:min-w-0 tw:flex-1 tw:flex-col tw:overflow-hidden">
          {!selected ? (
            <WorkbenchEmptyState icon="chart">
              <strong>{projectName} / {environment.name}</strong>
              <span>{t("analysis.emptyBody")}</span>
              <span className="tw:text-xs tw:text-muted-foreground">
                {t("analysis.emptyFlow")}
              </span>
              <span className="tw:flex tw:flex-wrap tw:items-center tw:justify-center tw:gap-2">
                {agentBinding?.connectionId && onOpenAgent ? (
                  <Button variant="primary" onClick={askAgent}>
                    <Icon name="terminal" /> {t("analysis.askAgent")}
                  </Button>
                ) : null}
                {bindings.length === 0 && onNewConnection ? (
                  <Button variant="primary" onClick={onNewConnection}>
                    <Icon name="database" /> {t("analysis.connectDatabase")}
                  </Button>
                ) : null}
              </span>
            </WorkbenchEmptyState>
          ) : (
            <>
              <ArticleHeader
                article={selected}
                running={running?.articleId === selected.id}
                busy={transition.isPending || remove.isPending || execute.isPending}
                canPublish={selected.state === "review" && Boolean(
                  selected.latestSuccessfulRunId
                  && runs.data?.runs.some((run) =>
                    run.id === selected.latestSuccessfulRunId
                    && run.articleRevision === selected.revision
                    && run.state === "succeeded"
                  ),
                )}
                onEdit={() => setEditorArticle(selected)}
                onRun={() => startRun(selected)}
                onCancel={() => running && cancel.mutate(running)}
                onTransition={(action) => transition.mutate({ article: selected, action })}
                onDelete={() => remove.mutate(selected)}
              />
              <PanelTabs tabs={detailTabs} active={tab} onChange={setTab} label={t("analysis.details")} />
              <div className="scrollbar-sleek tw:min-h-0 tw:flex-1 tw:overflow-auto tw:overscroll-contain">
                {tab === "article" ? (
                  <ArticleView
                    article={selected}
                    data={blockData}
                    parameterValues={parameterValues}
                    onParameterChange={(id, value) => setParameterValues((current) => ({ ...current, [id]: value }))}
                    runId={effectiveRunId}
                    loadingResult={recoveredResult.isFetching || sharedResult.isFetching}
                    resultError={blockData.size > 0 ? null : sharedResult.error}
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
                  <AnalysisSignalPanel article={selected} scopeKey={scopeKey} />
                ) : tab === "sharing" ? (
                  <AnalysisPublicationPanel article={selected} scopeKey={scopeKey} />
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

      {editorArticle ? (
        <AnalysisArticleEditor
          article={editorArticle}
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
  const { t } = useI18n();
  return (
    <header className="tw:grid tw:shrink-0 tw:gap-2 tw:border-b tw:border-border-subtle tw:bg-background tw:px-4 tw:py-3">
      <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:min-w-0 tw:gap-1">
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
            <h1 className="tw:m-0 tw:min-w-0 tw:truncate tw:text-title tw:font-semibold tw:tracking-tight">{article.definition.title}</h1>
            <StatusBadge density="compact" tone={stateTone(article.state)}>{stateLabel(article.state, t)}</StatusBadge>
            <StatusBadge density="compact">{sourceLabel(article, t)}</StatusBadge>
            <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">r{article.revision}</span>
          </div>
          {article.definition.question ? (
            <p className="tw:m-0 tw:max-w-[88ch] tw:text-sm tw:leading-body tw:text-muted-foreground">{article.definition.question}</p>
          ) : null}
        </div>
        <div className="ds-control-row tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-1">
          {running ? (
            <Button variant="danger" size="compact" onClick={onCancel}>
              <Icon name="stop" /> {t("analysis.cancelRun")}
            </Button>
          ) : (
            <Button variant="primary" size="compact" disabled={busy} onClick={onRun}>
              <Icon name="play" /> {t("analysis.runCurrent")}
            </Button>
          )}
          <Button size="compact" disabled={busy} onClick={onEdit}><Icon name="pencil" /> {t("analysis.edit")}</Button>
          {article.state === "draft" ? (
            <Button size="compact" disabled={busy} onClick={() => onTransition("submitReview")}><Icon name="arrowRight" /> {t("analysis.submitReview")}</Button>
          ) : null}
          {article.state === "review" ? (
            <>
              <Button size="compact" disabled={busy} onClick={() => onTransition("returnDraft")}><Icon name="arrowLeft" /> {t("analysis.returnDraft")}</Button>
              <Button size="compact" variant="primary" disabled={busy || !canPublish} title={canPublish ? t("analysis.publishExactTitle") : t("analysis.publishNeedsRunTitle")} onClick={() => onTransition("publishLive")}><Icon name="check" /> {t("analysis.publishLive")}</Button>
            </>
          ) : null}
          {article.state === "live" ? (
            <ConfirmButton size="compact" disabled={busy} confirmLabel={t("analysis.archiveConfirm")} onConfirm={() => onTransition("archive")}>
              {t("analysis.archive")}
            </ConfirmButton>
          ) : null}
          {article.state === "draft" || article.state === "archived" ? (
            <ConfirmButton iconOnly size="xs" variant="ghost" label={t("analysis.deleteLabel")} disabled={busy} onConfirm={onDelete}>
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
  const { lang, t } = useI18n();
  const locale = lang === "ko" ? "ko-KR" : "en-US";
  const freshness = articleFreshness(article);
  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1320px] tw:gap-4 tw:p-5 tw:@max-[760px]:p-3">
      <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
        <StatusBadge density="compact" tone={freshness === "fresh" ? "success" : "warning"}>
          {freshnessLabel(freshness, t)}
        </StatusBadge>
        <span className="tw:text-xs tw:text-muted-foreground">
          {t("analysis.updated", {
            time: relativeTime(article.updatedAt, locale, t("analysis.never")),
            timezone: article.definition.timezone,
          })}
        </span>
        {runs.length ? (
          <label className="tw:ml-auto tw:inline-flex tw:items-center tw:gap-2 tw:text-xs tw:text-muted-foreground">
            {t("analysis.result")}
            <span className="tw:w-[min(260px,40vw)]">
              <SelectInput
                density="compact"
                value={selectedRunId ?? ""}
                onChange={(event) => onSelectRun(event.target.value || null)}
                aria-label={t("analysis.result")}
              >
                {runs.filter((run) => run.state === "succeeded").map((run) => (
                  <option key={run.id} value={run.id}>r{run.articleRevision} · {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : run.id.slice(0, 8)}</option>
                ))}
              </SelectInput>
            </span>
          </label>
        ) : null}
      </div>
      {article.definition.summary ? (
        <p className="tw:m-0 tw:max-w-[90ch] tw:text-sm tw:leading-relaxed tw:text-foreground">{article.definition.summary}</p>
      ) : null}
      {loadingResult ? <LoadingLabel>{t("analysis.decrypting")}</LoadingLabel> : null}
      {resultError && runId ? (
        <InlineNotice tone="warning" icon="alert">{t("analysis.sharedResultMissing")}</InlineNotice>
      ) : null}
      <AnalysisArticleVisualization
        definition={article.definition}
        data={data}
        parameterValues={parameterValues}
        mode="interactive"
        onParameterChange={onParameterChange}
      />
      {article.definition.claims.length > 0 ? (
        <section className="tw:grid tw:gap-2 tw:border-t tw:border-border-subtle tw:pt-4">
          <h2 className="tw:m-0 tw:text-sm tw:font-semibold">{t("analysis.evidenceClaims")}</h2>
          <ol className="tw:m-0 tw:grid tw:gap-2 tw:pl-5 tw:text-sm tw:leading-body">
            {article.definition.claims.map((claim) => <li key={claim.id}>{claim.text}</li>)}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function DefinitionView({ article }: { article: AnalysisArticleRecord }) {
  const { t } = useI18n();
  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1100px] tw:gap-5 tw:p-5 tw:@max-[760px]:p-3">
      <DefinitionSection title={t("analysis.parameters")} count={article.definition.parameters.length}>
        {article.definition.parameters.map((parameter) => (
          <DefinitionRow key={parameter.id} title={parameter.label} metadata={`${parameter.type} · ${parameter.required ? t("analysis.required") : t("analysis.optional")}`} detail={parameter.id} />
        ))}
      </DefinitionSection>
      <DefinitionSection title={t("analysis.queries")} count={article.definition.queries.length}>
        {article.definition.queries.map((query) => (
          <details key={query.id} className="tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <summary className="tw:cursor-pointer tw:text-sm tw:font-medium">{query.title} <span className="tw:text-xs tw:font-normal tw:text-muted-foreground">· {query.connectionRole} · {t("analysis.rows", { count: query.maxRows.toLocaleString() })} · {byteSize(query.maxBytes)}</span></summary>
            <pre className="scrollbar-sleek tw:mt-3 tw:max-h-[360px] tw:overflow-auto tw:whitespace-pre-wrap tw:rounded-sm tw:bg-muted tw:p-3 tw:font-mono tw:text-xs tw:leading-body">{query.sql}</pre>
            <div className="tw:mt-2 tw:flex tw:flex-wrap tw:gap-1">
              {query.columns.map((column) => <StatusBadge key={column.name} density="compact" title={`${column.sensitivity} · ${column.masking}`}>{column.name}: {column.type}</StatusBadge>)}
            </div>
          </details>
        ))}
      </DefinitionSection>
      <DefinitionSection title={t("analysis.transforms")} count={article.definition.transforms.length}>
        {article.definition.transforms.map((transform) => (
          <DefinitionRow key={transform.id} title={transform.title} metadata={transform.operation.replace(/_/g, " ")} detail={`${transform.inputNodeIds.join(" + ")} → ${transform.id}`} />
        ))}
      </DefinitionSection>
      <DefinitionSection title={t("analysis.metrics")} count={article.definition.metrics.length}>
        {article.definition.metrics.map((metric) => (
          <DefinitionRow key={metric.id} title={metric.label} metadata={`${metric.format.style} · ${metric.sourceNodeId}.${metric.valueColumn}`} detail={metric.description || metric.id} />
        ))}
      </DefinitionSection>
      <DefinitionSection title={t("analysis.layoutBlocks")} count={article.definition.blocks.length}>
        {article.definition.blocks.map((block) => (
          <DefinitionRow key={block.id} title={block.title || block.id} metadata={`${block.kind.replace(/_/g, " ")} · ${block.width}/12`} detail={block.sourceNodeId ?? t("analysis.narrativeControl")} />
        ))}
      </DefinitionSection>
    </div>
  );
}

function DefinitionSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="tw:grid tw:gap-2">
      <h2 className="tw:m-0 tw:flex tw:items-center tw:gap-2 tw:text-sm tw:font-semibold">{title}<StatusBadge density="compact">{count}</StatusBadge></h2>
      {count ? <div className="tw:grid tw:gap-2">{children}</div> : <span className="tw:text-sm tw:text-muted-foreground">{t("analysis.none")}</span>}
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
  collaborators: AnalysisCollaboratorDirectory | undefined;
  transferring: boolean;
  onTransfer: (ownerMemberId: string) => void;
}) {
  const { lang, t } = useI18n();
  const locale = lang === "ko" ? "ko-KR" : "en-US";
  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1100px] tw:gap-5 tw:p-5 tw:@max-[760px]:p-3">
      <section className="tw:grid tw:gap-3">
        <h2 className="tw:m-0 tw:text-base tw:font-semibold">{t("analysis.authorityChain")}</h2>
        <div className="tw:grid tw:grid-cols-[repeat(4,minmax(0,1fr))] tw:gap-px tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-border-subtle tw:@max-[720px]:grid-cols-2 tw:@max-[420px]:grid-cols-1">
          {[
            [t("analysis.environment"), `r${article.environmentRevision}`],
            [t("analysis.connections"), t("analysis.exactRevisions", { count: article.connections.length })],
            [t("analysis.knowledgeGraphs"), article.graphRevisionIds.length ? t("analysis.pinnedCount", { count: article.graphRevisionIds.length }) : t("analysis.none")],
            [t("analysis.definition"), `r${article.revision}`],
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
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">{t("analysis.desktopRunners")}</h2>
        <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">
          {t("analysis.desktopRunnersBody")}
        </p>
        {article.definition.refresh.mode === "scheduled"
          && article.definition.refresh.runnerId
          && !runners.some((runner) => runner.id === article.definition.refresh.runnerId) ? (
            <InlineNotice tone="warning" icon="alert">
              {t("analysis.runnerUnavailable")}
            </InlineNotice>
          ) : null}
        {runners.length === 0 ? (
          <InlineNotice tone="warning" icon="alert">
            {t("analysis.noRunner")}
          </InlineNotice>
        ) : runners.map((runner) => {
          const assigned = article.definition.refresh.runnerId === runner.id;
          return (
            <div key={runner.id} className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-x-3 tw:gap-y-1 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
              <span className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                <StatusDot tone={runner.online ? "success" : "neutral"} />
                <strong className="tw:min-w-0 tw:truncate tw:text-sm tw:font-medium">{runner.displayName}</strong>
                {runner.isCurrent ? <StatusBadge density="compact">{t("analysis.thisDevice")}</StatusBadge> : null}
                {assigned ? <StatusBadge density="compact" tone="success">{t("analysis.assigned")}</StatusBadge> : null}
              </span>
              {runner.isCurrent ? (
                <span className="tw:text-xs tw:text-muted-foreground">{t("analysis.managedInSettings")}</span>
              ) : (
                <ConfirmButton
                  size="xs"
                  variant="dangerGhost"
                  disabled={revokingRunnerId !== null}
                  confirmLabel={t("analysis.forgetRunnerConfirm", { count: runner.scheduledArticleCount })}
                  onConfirm={() => onRevokeRunner(runner.id)}
                >
                  {t("analysis.forgetRunner")}
                </ConfirmButton>
              )}
              <span className="tw:min-w-0 tw:truncate tw:text-xs tw:text-muted-foreground">
                {runner.online
                  ? t("analysis.online")
                  : t("analysis.lastSeen", { time: relativeTime(runner.lastSeenAt, locale, t("analysis.never")) })}
                {runner.backgroundAllowed ? ` · ${t("analysis.backgroundEnabled")}` : ` · ${t("analysis.foregroundOnly")}`}
                {runner.scheduledArticleCount > 0 ? ` · ${t("analysis.scheduledCount", { count: runner.scheduledArticleCount })}` : ""}
              </span>
              <code className="tw:max-w-48 tw:truncate tw:text-right tw:text-2xs tw:text-muted-foreground">{runner.id}</code>
            </div>
          );
        })}
      </section>
      <section className="tw:grid tw:gap-2">
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">{t("analysis.connectionPins")}</h2>
        {article.connections.map((connection) => (
          <div key={connection.connectionId} className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-1 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <strong className="tw:truncate tw:text-sm">{connection.alias}</strong>
            <StatusBadge density="compact">{connection.role} · r{connection.connectionRevision}</StatusBadge>
            <code className="tw:col-span-2 tw:truncate tw:text-xs tw:text-muted-foreground">{connection.connectionId}</code>
          </div>
        ))}
      </section>
      <section className="tw:grid tw:gap-2">
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">{t("analysis.executionEvidence")}</h2>
        {loading ? <LoadingLabel>{t("analysis.loadingEvidence")}</LoadingLabel> : runs.length === 0 ? (
          <span className="tw:text-sm tw:text-muted-foreground">{t("analysis.noExecution")}</span>
        ) : runs.map((run) => (
          <details key={run.id} className="tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <summary className="tw:flex tw:cursor-pointer tw:items-center tw:gap-2 tw:text-sm">
              <StatusDot tone={runTone(run.state)} />
              <strong className="tw:font-medium">{run.state}</strong>
              <span className="tw:text-xs tw:text-muted-foreground">r{run.articleRevision} · {run.finishedAt ? new Date(run.finishedAt).toLocaleString(locale) : t("analysis.inProgress")}</span>
              <span className="tw:ml-auto tw:font-mono tw:text-2xs tw:text-muted-foreground">{t("analysis.rows", { count: run.rowCount.toLocaleString(locale) })} · {byteSize(run.byteCount)}</span>
            </summary>
            <dl className="tw:mt-3 tw:grid tw:grid-cols-[120px_minmax(0,1fr)] tw:gap-x-3 tw:gap-y-2 tw:text-xs">
              <dt className="tw:text-muted-foreground">{t("analysis.runId")}</dt><dd className="tw:m-0 tw:truncate tw:font-mono">{run.id}</dd>
              <dt className="tw:text-muted-foreground">{t("analysis.definitionHash")}</dt><dd className="tw:m-0 tw:truncate tw:font-mono">{run.definitionHash}</dd>
              <dt className="tw:text-muted-foreground">{t("analysis.resultHash")}</dt><dd className="tw:m-0 tw:truncate tw:font-mono">{run.resultHash ?? t("analysis.none")}</dd>
              {Object.entries(run.schemaFingerprints).map(([node, hash]) => (
                <span className="tw:col-span-2 tw:grid tw:grid-cols-[120px_minmax(0,1fr)] tw:gap-x-3" key={node}>
                  <dt className="tw:text-muted-foreground">{t("analysis.schema", { node })}</dt><dd className="tw:m-0 tw:truncate tw:font-mono">{hash}</dd>
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
  collaborators: AnalysisCollaboratorDirectory | undefined;
  transferring: boolean;
  onTransfer: (ownerMemberId: string) => void;
}) {
  const { t } = useI18n();
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
        <strong className="tw:text-sm tw:font-medium">{t("analysis.owner")}</strong>
        <span className="tw:text-xs tw:text-muted-foreground">{t("analysis.ownerBody", { name: current?.name ?? article.ownerMemberId })}</span>
      </span>
      {allowed ? (
        <SelectInput density="compact" aria-label={t("analysis.ownerSelect")} value={target} onChange={(event) => setTarget(event.target.value)}>
          {(collaborators?.members ?? []).filter((member) => member.canOwnAnalysis).map((member) => (
            <option key={member.id} value={member.id}>{member.name} · {member.role}</option>
          ))}
        </SelectInput>
      ) : <span className="tw:text-xs tw:text-muted-foreground">{t("analysis.ownerRestricted")}</span>}
      {allowed ? (
        <Button size="compact" disabled={transferring || target === article.ownerMemberId} onClick={() => onTransfer(target)}>
          {t("analysis.transfer")}
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
  const { lang, t } = useI18n();
  const locale = lang === "ko" ? "ko-KR" : "en-US";
  if (loading) return <div className="tw:p-5"><LoadingLabel>{t("analysis.loadingHistory")}</LoadingLabel></div>;
  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1100px] tw:grid-cols-2 tw:gap-5 tw:p-5 tw:@max-[760px]:grid-cols-1 tw:@max-[760px]:p-3">
      <section className="tw:grid tw:content-start tw:gap-2">
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">{t("analysis.definitionRevisions")}</h2>
        {revisions.map((revision) => (
          <div key={revision.revision} className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <StatusDot tone={revision.revision === article.liveRevision ? "success" : "neutral"} />
            <span className="tw:grid tw:min-w-0 tw:gap-0.5">
              <strong className="tw:text-sm tw:font-medium">r{revision.revision} · {revision.operation.replace(/_/g, " ")}</strong>
              <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{new Date(revision.createdAt).toLocaleString(locale)} · {revision.createdByMemberId}</span>
              <code className="tw:truncate tw:text-2xs tw:text-muted-foreground">{revision.payloadHash}</code>
            </span>
            {revision.revision !== article.revision ? (
              <ConfirmButton size="xs" variant="ghost" disabled={restoring} confirmLabel={t("analysis.restoreConfirm", { revision: revision.revision })} onConfirm={() => onRestore(revision.revision)}>
                {t("analysis.restore")}
              </ConfirmButton>
            ) : <StatusBadge density="compact">{t("analysis.current")}</StatusBadge>}
          </div>
        ))}
      </section>
      <section className="tw:grid tw:content-start tw:gap-2">
        <h2 className="tw:m-0 tw:text-sm tw:font-semibold">{t("analysis.runs")}</h2>
        {runs.map((run) => (
          <div key={run.id} className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <StatusDot tone={runTone(run.state)} />
            <span className="tw:grid tw:min-w-0 tw:gap-0.5">
              <strong className="tw:text-sm tw:font-medium">{run.state} · {run.trigger} · r{run.articleRevision}</strong>
              <span className="tw:text-xs tw:text-muted-foreground">{run.finishedAt ? new Date(run.finishedAt).toLocaleString(locale) : run.startedAt ? t("analysis.startedAt", { time: new Date(run.startedAt).toLocaleString(locale) }) : t("analysis.queued")}</span>
              {run.errorMessage ? <span className="tw:text-xs tw:text-danger">{run.errorMessage}</span> : null}
              <code className="tw:truncate tw:text-2xs tw:text-muted-foreground">{run.id}</code>
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
