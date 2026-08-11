import { useMemo, useState } from "react";

import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import {
  CheckboxField,
  PropertyRow,
  SelectInput,
  TextAreaInput,
  TextInput,
} from "../../design-system/components/FormControls";
import {
  ModalBackdrop,
  ModalFooter,
  ModalSurface,
  ModalTitleBar,
} from "../../design-system/components/Modal";
import { PanelTabs } from "../../design-system/components/PanelTabs";
import { InlineNotice, StatusBadge, StatusDot } from "../../design-system/components/Status";
import type { EnvironmentConnection, KnowledgeEnvironment } from "../knowledge/domain";
import type { AnalysisArticleRecord, SharedAnalysisArticleCreate } from "./domain";
import {
  AnalysisDataContractEditor,
  AnalysisLayoutEditor,
  AnalysisTransformEditor,
} from "./AnalysisDefinitionBuilder";

type EditorTab = "overview" | "data" | "transforms" | "layout" | "refresh" | "authority";

const editorTabs = [
  { id: "overview", label: "Overview" },
  { id: "data", label: "Data contract" },
  { id: "transforms", label: "Transforms" },
  { id: "layout", label: "Article layout" },
  { id: "refresh", label: "Refresh" },
  { id: "authority", label: "Authority" },
] as const;

function timezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function defaultArticle(
  environment: KnowledgeEnvironment,
  bindings: readonly EnvironmentConnection[],
): SharedAnalysisArticleCreate {
  const binding = bindings.find((candidate) => candidate.remoteConnectionId && !candidate.stale);
  const role = binding?.role || "primary";
  return {
    id: crypto.randomUUID(),
    projectEnvironmentId: environment.id,
    environmentRevision: environment.revision,
    sourceKnowledgeGrantId: null,
    graphRevisionIds: [],
    connections: binding?.remoteConnectionId
      ? [{
          connectionId: binding.remoteConnectionId,
          connectionRevision: binding.connectionRevision,
          role: binding.role,
          alias: binding.alias,
        }]
      : [],
    definition: {
      version: 1,
      source: "human",
      title: "Untitled analysis",
      question: "",
      summary: "",
      timezone: timezone(),
      parameters: [],
      queries: [{
        id: "primary_query",
        title: "Primary query",
        connectionRole: role,
        sql: "SELECT 1 AS value",
        parameterIds: [],
        maxRows: 5_000,
        maxBytes: 4 * 1024 * 1024,
        cacheTtlSeconds: 0,
        columns: [{
          name: "value",
          type: "number",
          nullable: false,
          role: "measure",
          sensitivity: "internal",
          masking: "none",
        }],
      }],
      transforms: [],
      metrics: [{
        id: "value",
        label: "Value",
        description: "",
        sourceNodeId: "primary_query",
        valueColumn: "value",
        unit: "",
        lowerIsBetter: null,
        format: { style: "number", decimals: 0, currency: null },
      }],
      blocks: [{
        id: "value_metric",
        kind: "metric",
        title: "Value",
        sourceNodeId: "primary_query",
        width: 4,
          config: {
            metricId: "value",
            comparisonColumn: null,
            sparklineColumn: null,
            sampleCountColumn: null,
          },
      }],
      claims: [],
      refresh: {
        mode: "manual",
        cron: null,
        timezone: timezone(),
        runnerId: null,
        maxStalenessSeconds: 86_400,
        resultRetentionDays: 30,
        shareReviewedResults: true,
      },
      warnings: [],
    },
  };
}

function existingInput(article: AnalysisArticleRecord): SharedAnalysisArticleCreate {
  return {
    id: article.id,
    projectEnvironmentId: article.projectEnvironmentId,
    environmentRevision: article.environmentRevision,
    sourceKnowledgeGrantId: article.sourceKnowledgeGrantId,
    graphRevisionIds: [...article.graphRevisionIds],
    connections: article.connections.map((connection) => ({ ...connection })),
    definition: structuredClone(article.definition),
  };
}

export function AnalysisArticleEditor({
  article,
  environment,
  bindings,
  runners,
  saving,
  onSave,
  onClose,
}: {
  article: AnalysisArticleRecord | null;
  environment: KnowledgeEnvironment;
  bindings: readonly EnvironmentConnection[];
  runners: ReadonlyArray<{
    id: string;
    displayName: string;
    online: boolean;
    backgroundAllowed: boolean;
  }>;
  saving: boolean;
  onSave: (article: SharedAnalysisArticleCreate) => void;
  onClose: () => void;
}) {
  const initial = useMemo(
    () => article ? existingInput(article) : defaultArticle(environment, bindings),
    [article, bindings, environment],
  );
  const [tab, setTab] = useState<EditorTab>("overview");
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const selectedConnectionIds = new Set(draft.connections.map((connection) => connection.connectionId));

  const patchDefinition = (patch: Partial<SharedAnalysisArticleCreate["definition"]>) => {
    setDraft((current) => ({
      ...current,
      definition: { ...current.definition, ...patch },
    }));
  };

  const toggleBinding = (binding: EnvironmentConnection) => {
    if (!binding.remoteConnectionId) return;
    setDraft((current) => {
      const exists = current.connections.some(
        (connection) => connection.connectionId === binding.remoteConnectionId,
      );
      return {
        ...current,
        connections: exists
          ? current.connections.filter(
              (connection) => connection.connectionId !== binding.remoteConnectionId,
            )
          : [...current.connections, {
              connectionId: binding.remoteConnectionId!,
              connectionRevision: binding.connectionRevision,
              role: binding.role,
              alias: binding.alias,
            }],
      };
    });
  };

  const submit = () => {
    try {
      const next: SharedAnalysisArticleCreate = draft;
      if (!next.definition.title.trim()) throw new Error("Title is required");
      if (next.connections.length === 0) throw new Error("Select at least one Environment database");
      setError(null);
      onSave(next);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  return (
    <ModalBackdrop onMouseDown={onClose}>
      <ModalSurface
        size="wide"
        fill
        aria-labelledby="analysis-editor-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <ModalTitleBar
          title={article ? `Edit ${article.definition.title}` : "New Analysis Article"}
          titleId="analysis-editor-title"
          closeLabel="Close editor"
          onClose={onClose}
        />
        <PanelTabs tabs={editorTabs} active={tab} onChange={setTab} label="Analysis Article editor" />
        <div className="scrollbar-sleek tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-5">
          {error ? (
            <InlineNotice tone="danger" icon="alert" role="alert">{error}</InlineNotice>
          ) : null}

          {tab === "overview" ? (
            <div className="tw:grid tw:gap-4">
              <div className="tw:grid tw:gap-1">
                <h2 className="tw:m-0 tw:text-base tw:font-semibold">What this analysis answers</h2>
                <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                  The title, question, and summary are versioned with the exact data authority used to answer them.
                </p>
              </div>
              <PropertyRow label="Title" htmlFor="analysis-title">
                <TextInput
                  id="analysis-title"
                  value={draft.definition.title}
                  maxLength={160}
                  onChange={(event) => patchDefinition({ title: event.target.value })}
                />
              </PropertyRow>
              <PropertyRow label="Question" htmlFor="analysis-question">
                <TextAreaInput
                  id="analysis-question"
                  value={draft.definition.question}
                  onChange={(event) => patchDefinition({ question: event.target.value })}
                />
              </PropertyRow>
              <PropertyRow label="Summary" htmlFor="analysis-summary">
                <TextAreaInput
                  id="analysis-summary"
                  value={draft.definition.summary}
                  onChange={(event) => patchDefinition({ summary: event.target.value })}
                />
              </PropertyRow>
              <PropertyRow label="Timezone" htmlFor="analysis-timezone">
                <TextInput
                  id="analysis-timezone"
                  value={draft.definition.timezone}
                  onChange={(event) => patchDefinition({ title: draft.definition.title, timezone: event.target.value })}
                />
              </PropertyRow>
            </div>
          ) : null}

          {tab === "data" ? (
            <div className="tw:grid tw:gap-5">
              <section className="tw:grid tw:gap-3">
                <div className="tw:grid tw:gap-1">
                  <h2 className="tw:m-0 tw:text-base tw:font-semibold">Environment databases</h2>
                  <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                    Each query is bound to one role and one immutable shared connection revision. Credentials remain local to each member.
                  </p>
                </div>
                {bindings.length === 0 ? (
                  <InlineNotice tone="warning" icon="alert">Connect a shared database to this Environment before creating an Article.</InlineNotice>
                ) : (
                  <div className="tw:grid tw:gap-1 tw:rounded-md tw:border tw:border-border-subtle tw:p-2">
                    {bindings.map((binding) => {
                      const available = Boolean(binding.remoteConnectionId) && !binding.stale;
                      return (
                        <label key={binding.id} className="tw:flex tw:min-h-control-lg tw:items-center tw:gap-2 tw:rounded-sm tw:px-2 tw:hover:bg-muted">
                          <input
                            type="checkbox"
                            className="tw:size-4 tw:accent-primary"
                            checked={Boolean(binding.remoteConnectionId && selectedConnectionIds.has(binding.remoteConnectionId))}
                            disabled={!available}
                            onChange={() => toggleBinding(binding)}
                          />
                          <StatusDot tone={binding.stale ? "warning" : available ? "success" : "danger"} />
                          <span className="tw:min-w-0 tw:flex-1 tw:truncate tw:text-sm">{binding.alias || binding.connectionName}</span>
                          <code className="tw:text-xs tw:text-muted-foreground">{binding.role} · r{binding.connectionRevision}</code>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
              <AnalysisDataContractEditor
                definition={draft.definition}
                connections={draft.connections}
                onChange={(definition) => setDraft((current) => ({ ...current, definition }))}
              />
            </div>
          ) : null}

          {tab === "transforms" ? (
            <div className="tw:grid tw:gap-4">
              <div className="tw:grid tw:gap-1">
                <h2 className="tw:m-0 tw:text-base tw:font-semibold">Typed transform DAG</h2>
                <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                  Nodes are evaluated in order. Cross-database data may meet only in an approved join or union mapping.
                </p>
              </div>
              <AnalysisTransformEditor
                definition={draft.definition}
                onChange={(definition) => setDraft((current) => ({ ...current, definition }))}
              />
            </div>
          ) : null}

          {tab === "layout" ? (
            <div className="tw:grid tw:gap-5">
              <div className="tw:grid tw:gap-1">
                <h2 className="tw:m-0 tw:text-base tw:font-semibold">Safe, declarative article</h2>
                <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                  Blocks reference typed node columns. HTML, JavaScript, remote images, and arbitrary plugins cannot enter the renderer.
                </p>
              </div>
              <AnalysisLayoutEditor
                definition={draft.definition}
                onChange={(definition) => setDraft((current) => ({ ...current, definition }))}
              />
            </div>
          ) : null}

          {tab === "refresh" ? (
            <div className="tw:grid tw:gap-4">
              <div className="tw:grid tw:gap-1">
                <h2 className="tw:m-0 tw:text-base tw:font-semibold">Freshness and retention</h2>
                <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                  Scheduled refreshes run only on an online, member-owned Desktop runner with current exact grants.
                </p>
              </div>
              <PropertyRow label="Mode" htmlFor="analysis-refresh-mode">
                <SelectInput
                  id="analysis-refresh-mode"
                  value={draft.definition.refresh.mode}
                  onChange={(event) => {
                    const mode = event.target.value === "scheduled" ? "scheduled" : "manual";
                    patchDefinition({
                      refresh: {
                        ...draft.definition.refresh,
                        mode,
                        cron: mode === "scheduled" ? draft.definition.refresh.cron ?? "0 9 * * *" : null,
                        runnerId: mode === "scheduled" ? draft.definition.refresh.runnerId ?? runners[0]?.id ?? null : null,
                      },
                    });
                  }}
                >
                  <option value="manual">Manual</option>
                  <option value="scheduled">Scheduled</option>
                </SelectInput>
              </PropertyRow>
              {draft.definition.refresh.mode === "scheduled" ? (
                <>
                  <PropertyRow label="Runner" htmlFor="analysis-runner">
                    <SelectInput
                      id="analysis-runner"
                      value={draft.definition.refresh.runnerId ?? ""}
                      onChange={(event) => patchDefinition({ refresh: { ...draft.definition.refresh, runnerId: event.target.value || null } })}
                    >
                      <option value="">Select an online runner</option>
                      {runners.map((runner) => (
                        <option key={runner.id} value={runner.id} disabled={!runner.online || !runner.backgroundAllowed}>
                          {runner.displayName}{runner.online ? " · online" : " · offline"}{runner.backgroundAllowed ? "" : " · background disabled"}
                        </option>
                      ))}
                    </SelectInput>
                  </PropertyRow>
                  <PropertyRow label="Cron" htmlFor="analysis-cron">
                    <TextInput
                      id="analysis-cron"
                      value={draft.definition.refresh.cron ?? ""}
                      placeholder="0 9 * * *"
                      onChange={(event) => patchDefinition({ refresh: { ...draft.definition.refresh, cron: event.target.value } })}
                    />
                  </PropertyRow>
                </>
              ) : null}
              <PropertyRow label="Timezone" htmlFor="analysis-refresh-timezone">
                <TextInput
                  id="analysis-refresh-timezone"
                  value={draft.definition.refresh.timezone}
                  onChange={(event) => patchDefinition({ refresh: { ...draft.definition.refresh, timezone: event.target.value } })}
                />
              </PropertyRow>
              <PropertyRow label="Stale after" htmlFor="analysis-staleness">
                <TextInput
                  id="analysis-staleness"
                  type="number"
                  min={60}
                  value={draft.definition.refresh.maxStalenessSeconds}
                  onChange={(event) => patchDefinition({ refresh: { ...draft.definition.refresh, maxStalenessSeconds: event.target.valueAsNumber } })}
                />
              </PropertyRow>
              <PropertyRow label="Retention" htmlFor="analysis-retention">
                <TextInput
                  id="analysis-retention"
                  type="number"
                  min={1}
                  max={365}
                  value={draft.definition.refresh.resultRetentionDays}
                  onChange={(event) => patchDefinition({ refresh: { ...draft.definition.refresh, resultRetentionDays: event.target.valueAsNumber } })}
                />
              </PropertyRow>
              <CheckboxField
                label="Share privacy-minimized result blocks while this revision is in review"
                checked={draft.definition.refresh.shareReviewedResults}
                onChange={(event) => patchDefinition({ refresh: { ...draft.definition.refresh, shareReviewedResults: event.target.checked } })}
              />
            </div>
          ) : null}

          {tab === "authority" ? (
            <div className="tw:grid tw:gap-4">
              <div className="tw:grid tw:gap-1">
                <h2 className="tw:m-0 tw:text-base tw:font-semibold">Exact authority pins</h2>
                <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                  These pins make every result reproducible and prevent a saved Article from silently inheriting wider access.
                </p>
              </div>
              <dl className="tw:grid tw:grid-cols-[minmax(130px,auto)_minmax(0,1fr)] tw:gap-x-4 tw:gap-y-3 tw:text-sm tw:@max-[560px]:grid-cols-1 tw:@max-[560px]:gap-y-1">
                <dt className="tw:text-muted-foreground">Article ID</dt>
                <dd className="tw:m-0 tw:truncate tw:font-mono">{draft.id}</dd>
                <dt className="tw:text-muted-foreground">Environment</dt>
                <dd className="tw:m-0 tw:font-mono">{environment.name} · r{draft.environmentRevision}</dd>
                <dt className="tw:text-muted-foreground">Knowledge grant</dt>
                <dd className="tw:m-0 tw:truncate tw:font-mono">{draft.sourceKnowledgeGrantId ?? "None"}</dd>
                <dt className="tw:text-muted-foreground">Graph revisions</dt>
                <dd className="tw:m-0 tw:grid tw:gap-1 tw:font-mono">
                  {draft.graphRevisionIds.length ? draft.graphRevisionIds.map((id) => <span className="tw:truncate" key={id}>{id}</span>) : "None"}
                </dd>
                <dt className="tw:text-muted-foreground">Connection revisions</dt>
                <dd className="tw:m-0 tw:grid tw:gap-1">
                  {draft.connections.map((connection) => (
                    <span key={connection.connectionId} className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                      <code className="tw:min-w-0 tw:flex-1 tw:truncate">{connection.alias}</code>
                      <StatusBadge density="compact">{connection.role} · r{connection.connectionRevision}</StatusBadge>
                    </span>
                  ))}
                </dd>
              </dl>
              {draft.environmentRevision !== environment.revision ? (
                <InlineNotice tone="warning" icon="alert">
                  This definition is pinned to Environment r{draft.environmentRevision}; the current Environment is r{environment.revision}. Rebase through an Agent session so graph and mapping grants are re-verified together.
                </InlineNotice>
              ) : null}
            </div>
          ) : null}
        </div>
        <ModalFooter>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? <Icon name="refresh" className="tw:animate-spin tw:motion-reduce:animate-none" /> : null}
            {article ? "Save new revision" : "Create draft"}
          </Button>
        </ModalFooter>
      </ModalSurface>
    </ModalBackdrop>
  );
}
