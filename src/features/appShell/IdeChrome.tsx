// DopeDB 2026.1 desktop chrome: project context and real tool-window launchers share
// one quiet title toolbar. macOS owns its native File/Edit/View menus, so the
// WebView must not draw a second application menu inside the window.
import type { ReactNode, RefObject } from "react";
import type { CatalogTable } from "../../ipc/types";
import type { ConnectionProfile } from "../connections/domain";
import type { QueryServiceSession } from "../queryServices/domain";
import {
  SQL_EDITOR_INDENT_SIZE,
  type SqlEditorStatus,
} from "../queries/editorStatus";
import { Icon } from "../../components/Icon";
import {
  StatusBarItem,
  StatusDot,
  type StatusTone,
} from "../../design-system/components/Status";
import { useI18n } from "../../lib/i18n";
import { tableLabel } from "../../lib/tableRef";
import type { AppArea } from "./WorkbenchRail";

const IS_MACOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

export function IdeTopBar({
  area,
  selected,
  supportsSql,
  databaseExplorerOpen,
  localHistoryOpen,
  servicesOpen,
  showTerminalDock,
  searchEverywhereOpen,
  workspace,
  account,
  onNewQuery,
  onArea,
  onToggleDatabaseExplorer,
  onToggleLocalHistory,
  onToggleServices,
  onOpenTerminal,
  terminalButtonRef,
  onSearchEverywhere,
  onSettings,
}: {
  area: AppArea;
  selected: ConnectionProfile | null;
  supportsSql: boolean;
  databaseExplorerOpen: boolean;
  localHistoryOpen: boolean;
  servicesOpen: boolean;
  showTerminalDock: boolean;
  searchEverywhereOpen: boolean;
  workspace: ReactNode;
  account: ReactNode;
  onNewQuery: () => void;
  onArea: (area: AppArea) => void;
  onToggleDatabaseExplorer: () => void;
  onToggleLocalHistory: () => void;
  onToggleServices: () => void;
  onOpenTerminal: () => void;
  terminalButtonRef: RefObject<HTMLButtonElement | null>;
  onSearchEverywhere: () => void;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  const queryDisabled = !selected || !supportsSql;

  return (
    <header
      className="ide-topbar tw:relative tw:col-[1/-1] tw:row-start-1 tw:z-[var(--ds-z-sticky)] tw:flex tw:h-full tw:min-w-0 tw:select-none tw:items-center tw:gap-1 tw:border-b tw:border-border-subtle tw:bg-card tw:px-2 tw:text-muted-foreground"
      data-tauri-drag-region="deep"
    >
      <div
        className={
          IS_MACOS
            ? "tw:block tw:w-[68px] tw:shrink-0"
            : "tw:hidden tw:shrink-0"
        }
        aria-hidden="true"
      />
      {workspace}

      <div
        className="tw:absolute tw:left-1/2 tw:flex tw:-translate-x-1/2 tw:items-center tw:gap-1 tw:[&_.btn]:[--ds-icon-button-size:28px]"
        role="toolbar"
        aria-label={t("ide.mainToolbar")}
      >
        <button
          type="button"
          className="btn small icon-only"
          onClick={() => {
            if (area === "workspace") onToggleDatabaseExplorer();
            else onArea("workspace");
          }}
          title={t("ide.action.databaseExplorer")}
          aria-label={t("ide.action.databaseExplorer")}
          aria-pressed={area === "workspace" && databaseExplorerOpen}
        >
          <Icon name="database" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          disabled={!selected || !supportsSql}
          onClick={onToggleLocalHistory}
          title={t("localHistory.title")}
          aria-label={t("localHistory.title")}
          aria-pressed={localHistoryOpen}
        >
          <Icon name="history" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          onClick={onToggleServices}
          title={t("services.title")}
          aria-label={t("services.title")}
          aria-pressed={servicesOpen}
        >
          <Icon name="list" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          onClick={() => onArea("dashboard")}
          title={t("tabs.dashboard")}
          aria-label={t("tabs.dashboard")}
          aria-pressed={area === "dashboard" && databaseExplorerOpen}
        >
          <Icon name="dashboard" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          disabled={queryDisabled}
          onClick={onNewQuery}
          title={t("ide.action.newQuery")}
          aria-label={t("ide.action.newQuery")}
        >
          <Icon name="play" />
        </button>
        <button
          ref={terminalButtonRef}
          type="button"
          className="btn small icon-only"
          disabled={!selected}
          onClick={onOpenTerminal}
          title={t("terminal.agentTitle")}
          aria-label={t("terminal.agentTitle")}
          aria-pressed={showTerminalDock}
        >
          <Icon name="user" />
        </button>
      </div>

      <div className="tw:ml-auto tw:flex tw:shrink-0 tw:items-center tw:gap-1 tw:[&_.btn]:[--ds-icon-button-size:28px]">
        <div className="tw:size-7 tw:shrink-0">{account}</div>
        <button
          type="button"
          className="btn small icon-only"
          onClick={onSearchEverywhere}
          title={t("ide.action.searchEverywhere")}
          aria-label={t("ide.action.searchEverywhere")}
          aria-pressed={searchEverywhereOpen}
        >
          <Icon name="search" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          onClick={onSettings}
          title={t("common.settings")}
          aria-label={t("common.settings")}
        >
          <Icon name="gear" />
        </button>
      </div>
    </header>
  );
}

export function IdeStatusBar({
  selected,
  selectedTable,
  selectedNamespace,
  settingsOpen,
  connectionCount,
  querySession,
  editorStatus,
  unseenOperationCount,
  onQueryStatus,
  onOpenNotifications,
  onSettings,
}: {
  selected: ConnectionProfile | null;
  selectedTable: CatalogTable | null;
  selectedNamespace: string | null;
  settingsOpen: boolean;
  connectionCount: number;
  querySession: QueryServiceSession | null;
  editorStatus: SqlEditorStatus | null;
  unseenOperationCount: number;
  onQueryStatus: () => void;
  onOpenNotifications: () => void;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  const queryLabel = querySession
    ? t(`services.status.${querySession.status}`)
    : null;
  const querySummary = querySession
    ? queryServiceSummary(querySession, t)
    : null;

  return (
    <footer
      className="ide-statusbar tw:col-[1/-1] tw:row-start-4 tw:z-[var(--ds-z-sticky)] tw:flex tw:min-w-0 tw:items-center tw:overflow-hidden tw:border-t tw:border-border-subtle tw:bg-card tw:text-xs tw:leading-none tw:text-muted-foreground"
      aria-label={t("ide.statusBar")}
    >
      <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:px-2">
        <span className="tw:font-semibold tw:text-foreground">DopeDB</span>
        <span>/</span>
        <span>{selected?.name || t("ide.noDataSource")}</span>
        {selectedTable ? (
          <>
            <span>/</span>
            <span>{tableLabel(selected?.engine ?? "postgres", selectedTable)}</span>
          </>
        ) : null}
      </div>
      <div className="tw:flex-1" />
      <StatusBarItem>
        <StatusDot tone={selected ? "success" : "neutral"} />
        {selected ? t("ide.connected") : t("ide.disconnected")}
      </StatusBarItem>
      {selected ? (
        <>
          <StatusBarItem>
            {selected.engine}
          </StatusBarItem>
          <StatusBarItem
            title={`${selected.database} · ${selectedNamespace ?? selected.database}`}
          >
            <span className="tw:max-w-[240px] tw:truncate">
              {selectedNamespace ?? selected.database}
            </span>
          </StatusBarItem>
          <StatusBarItem>
            {selected.readonlyDefault
              ? t("ide.readOnly")
              : t("ide.writeEnabled")}
          </StatusBarItem>
        </>
      ) : (
        <StatusBarItem>
          {t("ide.dataSourceCount", { count: connectionCount })}
        </StatusBarItem>
      )}
      {querySession && queryLabel ? (
        <StatusBarItem
          onClick={onQueryStatus}
          title={`${querySession.consoleTitle} · ${queryLabel}${
            querySummary ? ` · ${querySummary}` : ""
          }`}
        >
          <StatusDot tone={queryStatusTone(querySession.status)} />
          <span>{queryLabel}</span>
          {querySummary ? (
            <span className="tw:max-w-[200px] tw:truncate">
              · {querySummary}
            </span>
          ) : null}
        </StatusBarItem>
      ) : null}
      {editorStatus ? (
        <>
          <StatusBarItem>
            {editorStatus.line}:{editorStatus.column}
          </StatusBarItem>
          <StatusBarItem>LF</StatusBarItem>
        </>
      ) : null}
      <StatusBarItem>
        UTF-8
      </StatusBarItem>
      {editorStatus ? (
        <StatusBarItem>
          {t("ide.indentSpaces", {
            count: SQL_EDITOR_INDENT_SIZE,
          })}
        </StatusBarItem>
      ) : null}
      <button
        type="button"
        className="tw:relative tw:inline-flex tw:h-[23px] tw:w-7 tw:shrink-0 tw:cursor-pointer tw:items-center tw:justify-center tw:border-0 tw:border-l tw:border-border-subtle tw:bg-transparent tw:p-0 tw:font-sans tw:text-inherit tw:disabled:cursor-default tw:disabled:opacity-40 tw:not-disabled:hover:bg-muted tw:not-disabled:hover:text-foreground"
        disabled={!selected}
        onClick={onOpenNotifications}
        aria-label={
          unseenOperationCount > 0
            ? t("ide.notificationsUnread", {
                count: unseenOperationCount,
              })
            : t("ide.notifications")
        }
        title={
          unseenOperationCount > 0
            ? t("ide.notificationsUnread", {
                count: unseenOperationCount,
              })
            : t("ide.notifications")
        }
      >
        <Icon name="bell" />
        {unseenOperationCount > 0 ? (
          <span
            className="tw:absolute tw:top-1 tw:right-1 tw:size-1.5 tw:rounded-full tw:bg-primary"
            aria-hidden="true"
          />
        ) : null}
      </button>
      <button
        type="button"
        data-active={settingsOpen}
        className="tw:inline-flex tw:h-[23px] tw:w-7 tw:shrink-0 tw:cursor-pointer tw:items-center tw:justify-center tw:border-0 tw:border-l tw:border-border-subtle tw:bg-transparent tw:p-0 tw:font-sans tw:text-inherit tw:data-[active=true]:bg-muted tw:data-[active=true]:text-foreground tw:hover:bg-muted tw:hover:text-foreground"
        onClick={onSettings}
        aria-label={t("common.settings")}
        title={t("common.settings")}
      >
        <Icon name="gear" />
      </button>
    </footer>
  );
}

function queryStatusTone(
  status: QueryServiceSession["status"],
): StatusTone {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "running" || status === "waiting") {
    return "warning";
  }
  return "neutral";
}

function queryServiceSummary(
  session: QueryServiceSession,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  const result = session.result;
  if (result.kind === "materialized") {
    if (result.outcome.result) {
      return t("ide.queryRowsDuration", {
        count: result.outcome.result.rowCount,
        duration: Math.round(result.outcome.result.durationMs),
      });
    }
    if (result.outcome.affected != null) {
      return t("ide.queryAffected", {
        count: result.outcome.affected,
      });
    }
  }
  if (result.kind === "stream") {
    if (result.stream.durationMs != null) {
      return t("ide.queryRowsDuration", {
        count: result.stream.rowCount,
        duration: Math.round(result.stream.durationMs),
      });
    }
    return t("ide.queryRows", { count: result.stream.rowCount });
  }
  if (result.kind === "script") {
    return t("ide.queryStatements", {
      count: result.outcome.statements.length,
    });
  }
  if (result.kind === "error") return result.error.message;
  return null;
}
