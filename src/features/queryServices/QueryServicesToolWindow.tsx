import { useEffect, useMemo, useState } from "react";

import { Icon } from "../../components/Icon";
import { StatusDot } from "../../design-system/components/Status";
import { ToolWindowHeader } from "../../design-system/components/ToolWindow";
import { TreeSectionButton } from "../../design-system/components/TreeControls";
import type { ConnectionProfile } from "../connections/domain";
import type { WorkbenchDocument } from "../workbench/domain";
import { useI18n } from "../../lib/i18n";
import type {
  QueryServiceSession,
  QueryServiceStatus,
} from "./domain";
import QueryServiceResult from "./QueryServiceResult";

type ServicesTab = "output" | "result";

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
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<ServicesTab>("result");
  const [databaseOpen, setDatabaseOpen] = useState(true);
  const [collapsedConnections, setCollapsedConnections] = useState<Set<string>>(
    () => new Set(),
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
      ...documents.map((document) => document.connectionId),
      ...sessions.map((session) => session.connectionId),
    ]);
    return [...visibleIds].flatMap((id) => {
      const connection = byId.get(id);
      return connection ? [connection] : [];
    });
  }, [connections, documents, sessions]);

  function toggleConnection(id: string) {
    setCollapsedConnections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section
      className="services-tool-window tw:relative tw:col-[1/-1] tw:row-start-3 tw:mx-1 tw:mb-1 tw:flex tw:min-h-0 tw:min-w-0 tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background"
      aria-label={t("services.title")}
    >
      <div
        className="tw:absolute tw:-top-1 tw:right-0 tw:left-0 tw:z-[var(--ds-z-raised)] tw:h-2 tw:cursor-row-resize tw:hover:bg-ring/30 tw:active:bg-ring/30"
        title={t("app.dragResize")}
        onMouseDown={onStartResize}
        onDoubleClick={onResetHeight}
      />
      <aside className="tw:flex tw:w-[220px] tw:shrink-0 tw:flex-col tw:border-r tw:border-border-subtle tw:bg-card">
        <ToolWindowHeader title={t("services.title")} />
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
                    const connectionDocuments = documents.filter(
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
        <div className="tw:flex tw:h-control-md tw:shrink-0 tw:items-end tw:border-b tw:border-border-subtle tw:bg-card tw:px-1">
          <div
            className="tw:flex tw:min-w-0 tw:flex-1 tw:items-end"
            role="tablist"
            aria-label={t("services.tabs")}
          >
            {(["output", "result"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                data-active={tab === id}
                className="tw:relative tw:h-control-md tw:cursor-pointer tw:border-0 tw:bg-transparent tw:px-3 tw:font-sans tw:text-sm tw:text-muted-foreground tw:data-[active=true]:text-foreground tw:data-[active=true]:after:absolute tw:data-[active=true]:after:right-2 tw:data-[active=true]:after:bottom-0 tw:data-[active=true]:after:left-2 tw:data-[active=true]:after:h-0.5 tw:data-[active=true]:after:bg-primary tw:hover:text-foreground"
                onClick={() => setTab(id)}
              >
                {t(
                  id === "output"
                    ? "services.outputTab"
                    : "services.resultTab",
                )}
              </button>
            ))}
          </div>
          {active && (
            <span className="tw:mb-1 tw:inline-flex tw:h-control-sm tw:max-w-[min(42vw,420px)] tw:items-center tw:gap-1 tw:overflow-hidden tw:px-2 tw:text-xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
              <StatusDot tone={statusTone(active.status)} />
              {statusLabel(active.status, t)}
            </span>
          )}
          <button
            type="button"
            className="btn small icon-only icon-xs tw:mb-1"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:overflow-auto">
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
  document: WorkbenchDocument;
  active: boolean;
  sessions: QueryServiceSession[];
  activeSessionId: string | null;
  onActivateDocument: (id: string) => void;
  onActivateSession: (id: string) => void;
}) {
  const { t } = useI18n();
  const latest = sessions[0] ?? null;
  const icon =
    document.kind === "data"
      ? "table"
      : document.kind === "sql" || document.kind === "documents"
        ? "terminal"
        : document.kind === "activity"
          ? "history"
          : "database";
  const title =
    document.kind === "data"
      ? document.table.name
      : document.kind === "sql"
        ? document.title
        : t(
            document.kind === "activity"
              ? "tabs.activity"
              : document.kind === "documents"
                ? "tabs.documents"
                : "tabs.schema",
          );
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
  return (
    <button
      type="button"
      role="treeitem"
      data-active={active}
      className="ds-object-row tw:w-full tw:min-w-0 tw:cursor-pointer tw:gap-1 tw:rounded-xs tw:border-0 tw:bg-transparent tw:font-sans tw:text-left tw:text-ui tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:hover:bg-muted"
      onClick={() => onActivate(session.id)}
      aria-selected={active}
      title={`${session.consoleTitle} · ${session.startedLabel}`}
    >
      <StatusDot tone={statusTone(session.status)} />
      <span className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
        {session.startedLabel}
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
