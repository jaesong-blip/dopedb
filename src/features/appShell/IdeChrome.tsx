// DopeDB 2026.1 desktop chrome: project context and real tool-window launchers share
// one quiet title toolbar. macOS owns its native File/Edit/View menus, so the
// WebView must not draw a second application menu inside the window.
import type { ReactNode, RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CatalogTable } from "../../ipc/types";
import type { AgentProvider } from "../agents/domain";
import { agentUsageQuery } from "../agents/queryOptions";
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
  IdeStatusBarSurface,
  IdeToolbarLauncher,
  IdeTitleToolbar,
} from "../../design-system/components/AppChrome";
import {
  StatusBarBreadcrumbs,
  StatusBarIconButton,
  StatusBarItem,
  UsageMeter,
} from "../../design-system/components/Status";
import { useI18n } from "../../lib/i18n";
import { tableLabel } from "../../lib/tableRef";
import type { AppArea } from "./navigation";

const IS_MACOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

// Provider brand names are not translated; only the surrounding sentence is.
const AGENT_USAGE_LABEL: Record<AgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
};

export function IdeTopBar({
  area,
  selected,
  supportsSql,
  databaseExplorerOpen,
  localHistoryOpen,
  servicesOpen,
  showTerminalDock,
  searchEverywhereOpen,
  settingsOpen,
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
  settingsOpen: boolean;
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
    <IdeTitleToolbar
      macosInset={IS_MACOS}
      context={workspace}
      launchersLabel={t("ide.mainToolbar")}
      launchers={
        <>
        <IdeToolbarLauncher
          active={area === "workspace" && databaseExplorerOpen}
          onClick={() => {
            if (area === "workspace") onToggleDatabaseExplorer();
            else onArea("workspace");
          }}
          title={t("ide.action.databaseExplorer")}
          aria-label={t("ide.action.databaseExplorer")}
        >
          <Icon name="database" />
        </IdeToolbarLauncher>
        <IdeToolbarLauncher
          active={servicesOpen}
          onClick={onToggleServices}
          title={t("services.title")}
          aria-label={t("services.title")}
        >
          <Icon name="list" />
        </IdeToolbarLauncher>
        <IdeToolbarLauncher
          buttonRef={terminalButtonRef}
          active={showTerminalDock}
          disabled={!selected}
          onClick={onOpenTerminal}
          title={t("terminal.agentTitle")}
          aria-label={t("terminal.agentTitle")}
        >
          <Icon name="user" />
        </IdeToolbarLauncher>
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
        </>
      }
      actions={
        <>
        <div className="tw:size-8 tw:shrink-0">{account}</div>
        <IdeToolbarLauncher
          active={searchEverywhereOpen}
          onClick={onSearchEverywhere}
          title={t("ide.action.searchEverywhere")}
          aria-label={t("ide.action.searchEverywhere")}
        >
          <Icon name="search" />
        </IdeToolbarLauncher>
        <IdeToolbarLauncher
          active={settingsOpen}
          onClick={onSettings}
          title={t("common.settings")}
          aria-label={t("common.settings")}
        >
          <Icon name="gear" />
        </IdeToolbarLauncher>
        </>
      }
    />
  );
}

/** Remaining Agent CLI quota; providers that cannot be read render nothing. */
function AgentUsageStatus() {
  const { t } = useI18n();
  const { data } = useQuery(agentUsageQuery());

  return (
    <>
      {(data ?? []).map((usage) => {
        const detail = [
          t("ide.agentUsageSession", { percent: usage.sessionPercentLeft }),
        ];
        if (usage.weeklyPercentLeft !== null) {
          detail.push(
            t("ide.agentUsageWeekly", { percent: usage.weeklyPercentLeft }),
          );
        }
        for (const window of usage.modelWindows) {
          detail.push(
            t("ide.agentUsageModel", {
              model: window.model,
              percent: window.percentLeft,
            }),
          );
        }
        if (usage.resetsAt) {
          detail.push(
            t("ide.agentUsageResets", { time: resetLabel(usage.resetsAt) }),
          );
        }
        return (
          <StatusBarItem key={usage.provider} title={detail.join(" · ")}>
            {AGENT_USAGE_LABEL[usage.provider]}
            <UsageMeter percentLeft={usage.sessionPercentLeft} />
            <span className="tw:tabular-nums">{usage.sessionPercentLeft}%</span>
          </StatusBarItem>
        );
      })}
    </>
  );
}

function resetLabel(value: string) {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? value
    : at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
    <IdeStatusBarSurface
      label={t("ide.statusBar")}
      breadcrumbs={
        <StatusBarBreadcrumbs
          label={t("ide.databaseNavigation")}
          items={breadcrumbs}
        />
      }
    >
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
      <AgentUsageStatus />
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
    </IdeStatusBarSurface>
  );
}
