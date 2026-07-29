import { useEffect, useMemo, useState } from "react";

import { Icon } from "../../components/Icon";
import { StatusDot } from "../../design-system/components/Status";
import {
  ToolWindowHeader,
  ToolWindowHideButton,
} from "../../design-system/components/ToolWindow";
import {
  IdeToolTab,
  IdeToolTabStrip,
} from "../../design-system/components/IdeTabs";
import { TreeSectionButton } from "../../design-system/components/TreeControls";
import { WorkbenchToolbar } from "../../design-system/components/Workbench";
import type { ConnectionProfile } from "../connections/domain";
import type { WorkbenchDocument } from "../workbench/domain";
import { useI18n } from "../../lib/i18n";
import type {
  QueryServiceSession,
  QueryServiceStatus,
} from "./domain";
import QueryServiceResult from "./QueryServiceResult";

type ServicesTab = "output" | "result";
type ServiceDocument = Extract<
  WorkbenchDocument,
  { kind: "data" | "sql" | "documents" }
>;

export default function QueryServicesToolWindow({
  sessions,
  activeSessionId,
  connections,
  documents,
  activeDocumentId,
  onActivate,
  onActivateDocument,
  onClose,
  onStartResize,
  onResetHeight,
  compact = false,
}: {
  sessions: QueryServiceSession[];
  activeSessionId: string | null;
  connections: ConnectionProfile[];
  documents: WorkbenchDocument[];
  activeDocumentId: string | null;
  onActivate: (id: string) => void;
  onActivateDocument: (id: string) => void;
  onClose: () => void;
  onStartResize: (event: {
    preventDefault(): void;
    clientY: number;
  }) => void;
  onResetHeight: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<ServicesTab>("result");
  const [databaseOpen, setDatabaseOpen] = useState(true);
  const [collapsedConnections, setCollapsedConnections] = useState<Set<string>>(
    () => new Set(),
  );
  const serviceDocuments = useMemo(
    () => documents.filter(isServiceDocument),
    [documents],
  );
  const active =
    sessions.find((session) => session.id === activeSessionId) ??
    sessions[0] ??
    null;

  useEffect(() => {
    if (!activeSessionId && sessions[0]) onActivate(sessions[0].id);
  }, [activeSessionId, onActivate, sessions]);

  const serviceConnections = useMemo(() => {
    const byId = new Map<string, ConnectionProfile>(
      connections.map((connection) => [connection.id, connection]),
    );
    const visibleIds = new Set([
      ...serviceDocuments.map((document) => document.connectionId),
      ...sessions.map((session) => session.connectionId),
    ]);
    return [...visibleIds].flatMap((id) => {
      const connection = byId.get(id);
      return connection ? [connection] : [];
    });
  }, [connections, serviceDocuments, sessions]);
  const activeConnection =
    connections.find((connection) => connection.id === active?.connectionId) ??
    null;
  const resultTabLabel = active
    ? sessionResultLabel(active, activeConnection) ?? t("services.resultTab")
    : t("services.resultTab");

  function toggleConnection(id: string) {
    setCollapsedConnections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function expandAll() {
    setDatabaseOpen(true);
    setCollapsedConnections(new Set());
  }

  function collapseAll() {
    setDatabaseOpen(false);
    setCollapsedConnections(new Set(serviceConnections.map(({ id }) => id)));
  }

  return (
    <section
      className="services-tool-window tw:relative tw:col-[1/-1] tw:row-start-3 tw:mx-1 tw:mb-1 tw:flex tw:min-h-0 tw:min-w-0 tw:flex-col tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background tw:data-[compact=true]:fixed tw:data-[compact=true]:top-title-toolbar tw:data-[compact=true]:right-0 tw:data-[compact=true]:bottom-20 tw:data-[compact=true]:left-0 tw:data-[compact=true]:z-[var(--ds-z-modal)] tw:data-[compact=true]:m-0 tw:data-[compact=true]:rounded-none tw:data-[compact=true]:border-x-0"
      data-compact={compact}
      aria-label={t("services.title")}
    >
      <div
        className="tw:absolute tw:-top-1 tw:right-0 tw:left-0 tw:z-[var(--ds-z-raised)] tw:h-2 tw:cursor-row-resize tw:hover:bg-ring/30 tw:active:bg-ring/30"
        title={t("app.dragResize")}
        onMouseDown={onStartResize}
        onDoubleClick={onResetHeight}
      />
      <ToolWindowHeader
        title={t("services.title")}
        actions={
          <ToolWindowHideButton
            label={t("common.close")}
            onClick={onClose}
          />
        }
      />

      <div className="tw:flex tw:min-h-0 tw:min-w-0 tw:flex-1">
        <aside className="tw:flex tw:w-[32%] tw:min-w-[220px] tw:max-w-[460px] tw:shrink-0 tw:flex-col tw:border-r tw:border-border-subtle tw:bg-background">
          <WorkbenchToolbar label={t("services.sessions")} compact>
            <button
              type="button"
              className="btn small icon-only"
              disabled={
                databaseOpen &&
                collapsedConnections.size === 0 &&
                serviceConnections.length > 0
              }
              onClick={expandAll}
              title={t("connections.expandAll")}
              aria-label={t("connections.expandAll")}
            >
              <Icon name="chevronsRight" />
            </button>
            <button
              type="button"
              className="btn small icon-only"
              disabled={!databaseOpen}
              onClick={collapseAll}
              title={t("connections.collapseAll")}
              aria-label={t("connections.collapseAll")}
            >
              <Icon name="chevronsLeft" />
            </button>
          </WorkbenchToolbar>
          <div
            className="tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-1"
            role="tree"
            aria-label={t("services.sessions")}
          >
            {serviceConnections.length === 0 ? (
              <p className="tw:m-0 tw:p-3 tw:text-sm tw:text-muted-foreground">
                {t("services.empty")}
              </p>
            ) : (
              <>
                <TreeSectionButton
                  expanded={databaseOpen}
                  icon="folder"
                  onToggle={() => setDatabaseOpen((open) => !open)}
                >
                  {t("connections.database")}
                </TreeSectionButton>
                {databaseOpen && (
                  <div
                    className="tw:flex tw:flex-col tw:gap-px tw:pl-3"
                    role="group"
                  >
                    {serviceConnections.map((connection) => {
                      const connectionOpen =
                        !collapsedConnections.has(connection.id);
                      const connectionDocuments = serviceDocuments.filter(
                        (document) =>
                          document.connectionId === connection.id,
                      );
                      const documentIds = new Set(
                        connectionDocuments.map((document) => document.id),
                      );
                      const detachedSessions = sessions.filter(
                        (session) =>
                          session.connectionId === connection.id &&
                          !documentIds.has(session.documentId),
                      );
                      return (
                        <div
                          className="tw:flex tw:flex-col tw:gap-px"
                          key={connection.id}
                          role="treeitem"
                          aria-expanded={connectionOpen}
                        >
                          <TreeSectionButton
                            expanded={connectionOpen}
                            icon="database"
                            onToggle={() => toggleConnection(connection.id)}
                          >
                            {connection.name}
                          </TreeSectionButton>
                          {connectionOpen && (
                            <div
                              className="tw:flex tw:flex-col tw:gap-px tw:pl-3"
                              role="group"
                            >
                              {connectionDocuments.map((document) => (
                                <ServiceDocumentNode
                                  key={document.id}
                                  document={document}
                                  active={document.id === activeDocumentId}
                                  sessions={sessions.filter(
                                    (session) =>
                                      session.documentId === document.id,
                                  )}
                                  activeSessionId={active?.id ?? null}
                                  onActivateDocument={onActivateDocument}
                                  onActivateSession={onActivate}
                                />
                              ))}
                              {detachedSessions.map((session) => (
                                <ServiceSessionRow
                                  key={session.id}
                                  session={session}
                                  active={session.id === active?.id}
                                  onActivate={onActivate}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        <div className="tw:flex tw:min-w-0 tw:flex-1 tw:flex-col">
          <IdeToolTabStrip
            label={t("services.tabs")}
            status={
              active ? (
                <span className="tw:inline-flex tw:h-control-sm tw:max-w-[min(30vw,320px)] tw:items-center tw:gap-1 tw:overflow-hidden tw:px-2 tw:text-xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                  <StatusDot tone={statusTone(active.status)} />
                  {statusLabel(active.status, t)}
                </span>
              ) : null
            }
          >
            {(["output", "result"] as const).map((id) => (
              <IdeToolTab
                key={id}
                active={tab === id}
                onClick={() => setTab(id)}
              >
                <Icon name={id === "output" ? "terminal" : "table"} />
                <span className="tw:overflow-hidden tw:text-ellipsis">
                  {id === "output"
                    ? t("services.outputTab")
                    : resultTabLabel}
                </span>
              </IdeToolTab>
            ))}
          </IdeToolTabStrip>

          <div className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:overflow-hidden">
            {!active ? (
              <div className="tw:m-auto tw:grid tw:justify-items-center tw:gap-2 tw:p-6 tw:text-center tw:text-sm tw:text-muted-foreground">
                <Icon name="list" className="tw:text-xl" />
                {t("services.empty")}
              </div>
            ) : tab === "output" ? (
              <ServiceOutput session={active} />
            ) : (
              <QueryServiceResult key={active.id} result={active.result} />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ServiceDocumentNode({
  document,
  active,
  sessions,
  activeSessionId,
  onActivateDocument,
  onActivateSession,
}: {
  document: ServiceDocument;
  active: boolean;
  sessions: QueryServiceSession[];
  activeSessionId: string | null;
  onActivateDocument: (id: string) => void;
  onActivateSession: (id: string) => void;
}) {
  const { t } = useI18n();
  const latest = sessions[0] ?? null;
  const icon = document.kind === "data" ? "table" : "terminal";
  const title =
    document.kind === "data"
      ? document.table.name
      : document.kind === "sql"
        ? document.title
        : t("tabs.documents");
  const duration = latest ? sessionDuration(latest) : null;
  return (
    <div className="tw:flex tw:flex-col tw:gap-px">
      <button
        type="button"
        role="treeitem"
        data-active={active}
        aria-selected={active}
        className="ds-object-row tw:w-full tw:min-w-0 tw:cursor-pointer tw:gap-1 tw:rounded-xs tw:border-0 tw:bg-transparent tw:font-sans tw:text-left tw:text-ui tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:hover:bg-muted"
        onClick={() => onActivateDocument(document.id)}
      >
        <Icon
          name={icon}
          className="tw:shrink-0 tw:text-[length:var(--ds-icon-sm)] tw:text-muted-foreground"
        />
        <span className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
          {title}
        </span>
        {duration !== null ? (
          <span className="tw:shrink-0 tw:text-xs tw:text-muted-foreground">
            {duration} ms
          </span>
        ) : null}
        {latest ? <StatusDot tone={statusTone(latest.status)} /> : null}
      </button>
      {sessions.length > 0 && (
        <div
          className="tw:flex tw:flex-col tw:gap-px tw:pl-3"
          role="group"
        >
          {sessions.map((session) => (
            <ServiceSessionRow
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              onActivate={onActivateSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceSessionRow({
  session,
  active,
  onActivate,
}: {
  session: QueryServiceSession;
  active: boolean;
  onActivate: (id: string) => void;
}) {
  const duration = sessionDuration(session);
  const label = sessionResultLabel(session, null) ?? session.consoleTitle;
  return (
    <button
      type="button"
      role="treeitem"
      data-active={active}
      className="ds-object-row tw:w-full tw:min-w-0 tw:cursor-pointer tw:gap-1 tw:rounded-xs tw:border-0 tw:bg-transparent tw:font-sans tw:text-left tw:text-ui tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:hover:bg-muted"
      onClick={() => onActivate(session.id)}
      aria-selected={active}
      title={`${label} · ${session.startedLabel}`}
    >
      <StatusDot tone={statusTone(session.status)} />
      <span className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
        {label}
      </span>
      <span className="tw:shrink-0 tw:text-xs tw:text-muted-foreground">
        {duration !== null ? `${duration} ms` : session.startedLabel}
      </span>
    </button>
  );
}

function ServiceOutput({ session }: { session: QueryServiceSession }) {
  const { t } = useI18n();
  const lines = useMemo(
    () => [
      `[${session.startedLabel}] ${t("services.started", {
        connection: session.connectionName,
      })}`,
      "",
      session.sql,
      "",
      statusLabel(session.status, t),
    ],
    [session, t],
  );

  return (
    <pre className="tw:m-0 tw:min-h-full tw:overflow-auto tw:p-3 tw:font-mono tw:text-xs tw:leading-body tw:whitespace-pre-wrap tw:text-foreground">
      {lines.join("\n")}
    </pre>
  );
}

function statusTone(status: QueryServiceStatus) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "running" || status === "waiting") return "warning" as const;
  return "neutral" as const;
}

function statusLabel(
  status: QueryServiceStatus,
  t: ReturnType<typeof useI18n>["t"],
) {
  return t(`services.status.${status}`);
}

function isServiceDocument(
  document: WorkbenchDocument,
): document is ServiceDocument {
  return (
    document.kind === "data" ||
    document.kind === "sql" ||
    document.kind === "documents"
  );
}

function sessionDuration(session: QueryServiceSession) {
  if (session.result.kind === "materialized") {
    return session.result.outcome.result?.durationMs ?? null;
  }
  if (session.result.kind === "stream") {
    return session.result.stream.durationMs;
  }
  if (session.result.kind === "script") {
    const durations = session.result.outcome.statements.flatMap((statement) =>
      statement.result ? [statement.result.durationMs] : [],
    );
    return durations.length > 0
      ? durations.reduce((total, duration) => total + duration, 0)
      : null;
  }
  return null;
}

function sessionResultLabel(
  session: QueryServiceSession,
  connection: ConnectionProfile | null,
) {
  const tabular =
    (session.result.kind === "materialized" &&
      session.result.outcome.result !== null) ||
    session.result.kind === "stream";
  if (!tabular) return null;

  const source =
    /\bfrom\s+([A-Za-z_][\w$]*)(?:\s*\.\s*([A-Za-z_][\w$]*))?/i.exec(
      session.sql,
    );
  if (!source) return session.consoleTitle;
  if (source[2]) return `${source[1]}.${source[2]}`;
  return session.namespace
    ? `${session.namespace}.${source[1]}`
    : connection?.engine === "sqlite"
      ? `main.${source[1]}`
      : source[1];
}
