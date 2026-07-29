// DopeDB 2026.1 desktop chrome: project context and real tool-window launchers share
// one quiet title toolbar. macOS owns its native File/Edit/View menus, so the
// WebView must not draw a second application menu inside the window.
import type { ReactNode, RefObject } from "react";
import type { CatalogTable } from "../../ipc/types";
import type { ConnectionProfile } from "../connections/domain";
import type { QueryServiceSession } from "../queryServices/domain";
import type { WorkbenchDocument } from "../workbench/domain";
import {
  SQL_EDITOR_INDENT_SIZE,
  type SqlEditorStatus,
} from "../queries/editorStatus";
import { Icon } from "../../components/Icon";
import ToolbarMenu, {
  ToolbarMenuItem,
} from "../../components/ToolbarMenu";
import {
  StatusBarBreadcrumbs,
  StatusBarIconButton,
  StatusBarItem,
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
          onClick={onToggleServices}
          title={t("services.title")}
          aria-label={t("services.title")}
          aria-pressed={servicesOpen}
        >
          <Icon name="list" />
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
        <ToolbarMenu
          align="start"
          icon="moreHorizontal"
          label={t("ide.action.more")}
        >
          <ToolbarMenuItem
            icon="dashboard"
            onClick={() => onArea("dashboard")}
          >
            {t("tabs.dashboard")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon={localHistoryOpen ? "check" : "history"}
            disabled={!selected || !supportsSql}
            onClick={onToggleLocalHistory}
            aria-pressed={localHistoryOpen}
          >
            {t("localHistory.title")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="play"
            disabled={queryDisabled}
            onClick={onNewQuery}
          >
            {t("ide.action.newQuery")}
          </ToolbarMenuItem>
        </ToolbarMenu>
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
  activeDocument,
  querySession,
  backgroundProcessCount,
  editorStatus,
  writeEnabled,
  unseenOperationCount,
  onQueryStatus,
  onOpenNotifications,
  onSafetySettings,
}: {
  selected: ConnectionProfile | null;
  selectedTable: CatalogTable | null;
  selectedNamespace: string | null;
  activeDocument: WorkbenchDocument | null;
  querySession: QueryServiceSession | null;
  backgroundProcessCount: number;
  editorStatus: SqlEditorStatus | null;
  writeEnabled: boolean;
  unseenOperationCount: number;
  onQueryStatus: () => void;
  onOpenNotifications: () => void;
  onSafetySettings: () => void;
}) {
  const { t } = useI18n();
  const queryLabel = querySession
    ? t(`services.status.${querySession.status}`)
    : null;
  const backgroundLabel = querySession && queryLabel
    ? `${t("ide.backgroundProcesses", {
        count: backgroundProcessCount,
      })} · ${querySession.consoleTitle} · ${queryLabel}`
    : t("ide.backgroundProcesses", {
        count: backgroundProcessCount,
      });
  const breadcrumbs: Array<{ id: string; label: string }> = [
    { id: "database", label: t("ide.databaseRoot") },
  ];
  if (selected) {
    breadcrumbs.push({
      id: `connection:${selected.id}`,
      label: selected.name || t("app.unnamed"),
    });
    if (selectedNamespace) {
      breadcrumbs.push({
        id: `namespace:${selectedNamespace}`,
        label: selectedNamespace,
      });
    }
    if (selectedTable) {
      const relationGroup =
        selected.engine === "mongodb"
          ? t("ide.collections")
          : selectedTable.kind.toLocaleLowerCase().includes("view")
            ? t("ide.views")
            : t("ide.tables");
      breadcrumbs.push(
        { id: `group:${relationGroup}`, label: relationGroup },
        {
          id: `relation:${selectedTable.name}`,
          label: tableLabel(selected.engine, selectedTable),
        },
      );
    } else if (activeDocument?.kind === "sql") {
      breadcrumbs.push({
        id: `document:${activeDocument.id}`,
        label: activeDocument.title,
      });
    } else if (
      activeDocument?.kind === "schema" ||
      activeDocument?.kind === "activity" ||
      activeDocument?.kind === "documents"
    ) {
      breadcrumbs.push({
        id: `document:${activeDocument.id}`,
        label: t(`tabs.${activeDocument.kind}`),
      });
    }
  }

  return (
    <footer
      className="ide-statusbar tw:col-[1/-1] tw:row-start-4 tw:z-[var(--ds-z-sticky)] tw:flex tw:min-w-0 tw:items-center tw:overflow-hidden tw:border-t tw:border-border-subtle tw:bg-card tw:text-xs tw:leading-none tw:text-muted-foreground"
      aria-label={t("ide.statusBar")}
    >
      <StatusBarBreadcrumbs
        label={t("ide.databaseNavigation")}
        items={breadcrumbs}
      />
      <div className="tw:flex-1" />
      {backgroundProcessCount > 0 ? (
        <StatusBarIconButton
          icon="refresh"
          label={backgroundLabel}
          onClick={onQueryStatus}
          spinning
        >
          <span className="tw:tabular-nums">
            {backgroundProcessCount}
          </span>
        </StatusBarIconButton>
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
      {selected ? (
        <StatusBarIconButton
          icon={writeEnabled ? "unlock" : "lock"}
          label={writeEnabled ? t("ide.writeEnabled") : t("ide.readOnly")}
          onClick={onSafetySettings}
        />
      ) : null}
      <StatusBarIconButton
        icon="bell"
        label={
          unseenOperationCount > 0
            ? t("ide.notificationsUnread", {
                count: unseenOperationCount,
              })
            : t("ide.notifications")
        }
        onClick={onOpenNotifications}
        attention={unseenOperationCount > 0}
        disabled={!selected}
      />
    </footer>
  );
}
