// DopeDB 2026.1 desktop chrome: project context and real tool-window launchers share
// one quiet title toolbar. macOS owns its native File/Edit/View menus, so the
// WebView must not draw a second application menu inside the window.
import type { ReactNode, RefObject } from "react";
import type { CatalogTable } from "../../ipc/types";
import BackgroundTasksMenu from "../backgroundTasks/BackgroundTasksMenu";
import type { BackgroundTask } from "../backgroundTasks/domain";
import type { ConnectionProfile } from "../connections/domain";
import { providerTargetDisplayName } from "../connections/ProviderTargetLabel";
import type { WorkbenchDocument } from "../workbench/domain";
import ManualTransactionsMenu from "../queries/ManualTransactionsMenu";
import type { WorkspaceManualTransaction } from "../queries/useWorkspaceManualTransactions";
import { SQL_EDITOR_INDENT_SIZE } from "../queries/editorStatus";
import { useSqlEditorCursor } from "../queries/editorStatusStore";
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
} from "../../design-system/components/Status";
import { useI18n } from "../../lib/i18n";
import { tableLabel } from "../../lib/tableRef";
import type { AppArea } from "./navigation";

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
            icon="branch"
            onClick={() => onArea("knowledge")}
          >
            Knowledge
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

export function IdeStatusBar({
  selected,
  selectedTable,
  selectedDatabase,
  selectedNamespace,
  activeDocument,
  backgroundTasks,
  cancellingBackgroundTaskKeys,
  manualTransactions,
  settlingManualTransactionIds,
  writeEnabled,
  unseenOperationCount,
  onOpenQueryTask,
  onOpenAgentTask,
  onOpenManualTransaction,
  onCommitManualTransaction,
  onRollbackManualTransaction,
  onCancelBackgroundTask,
  onRevealDatabaseContext,
  onOpenNotifications,
  onSafetySettings,
}: {
  selected: ConnectionProfile | null;
  selectedTable: CatalogTable | null;
  selectedDatabase: string | null;
  selectedNamespace: string | null;
  activeDocument: WorkbenchDocument | null;
  backgroundTasks: BackgroundTask[];
  cancellingBackgroundTaskKeys: ReadonlySet<string>;
  manualTransactions: WorkspaceManualTransaction[];
  settlingManualTransactionIds: ReadonlySet<string>;
  writeEnabled: boolean;
  unseenOperationCount: number;
  onOpenQueryTask: (sessionId: string) => void;
  onOpenAgentTask: (connectionId: string) => void;
  onOpenManualTransaction: (
    transaction: WorkspaceManualTransaction,
  ) => void;
  onCommitManualTransaction: (
    transaction: WorkspaceManualTransaction,
  ) => Promise<void>;
  onRollbackManualTransaction: (
    transaction: WorkspaceManualTransaction,
  ) => Promise<void>;
  onCancelBackgroundTask: (task: BackgroundTask) => Promise<void>;
  onRevealDatabaseContext: () => void;
  onOpenNotifications: () => void;
  onSafetySettings: () => void;
}) {
  const { t } = useI18n();
  const breadcrumbs: Array<{
    id: string;
    label: string;
    onSelect?: () => void;
  }> = [
    {
      id: "database",
      label: t("ide.databaseRoot"),
      onSelect: onRevealDatabaseContext,
    },
  ];
  if (selected) {
    breadcrumbs.push({
      id: `connection:${selected.id}`,
      label: selected.name || t("app.unnamed"),
      onSelect: onRevealDatabaseContext,
    });
    if (selected.providerTarget) {
      const target = selected.providerTarget;
      const state = target.pendingState ?? target.currentState;
      breadcrumbs.push({
        id: `provider-target:${target.branchId}`,
        label: state
          ? `${providerTargetDisplayName(target)} · ${state}`
          : providerTargetDisplayName(target),
        onSelect: onRevealDatabaseContext,
      });
    }
    if (selectedDatabase) {
      breadcrumbs.push({
        id: `database:${selectedDatabase}`,
        label: selectedDatabase,
        onSelect: onRevealDatabaseContext,
      });
    }
    if (selectedNamespace) {
      breadcrumbs.push({
        id: `namespace:${selectedNamespace}`,
        label: selectedNamespace,
        onSelect: onRevealDatabaseContext,
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
        {
          id: `group:${relationGroup}`,
          label: relationGroup,
          onSelect: onRevealDatabaseContext,
        },
        {
          id: `relation:${selectedTable.name}`,
          label: tableLabel(selected.engine, selectedTable),
          onSelect: onRevealDatabaseContext,
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
      {manualTransactions.length > 0 ? (
        <ManualTransactionsMenu
          transactions={manualTransactions}
          settlingIds={settlingManualTransactionIds}
          onOpen={onOpenManualTransaction}
          onCommit={onCommitManualTransaction}
          onRollback={onRollbackManualTransaction}
        />
      ) : null}
      {backgroundTasks.length > 0 ? (
        <BackgroundTasksMenu
          tasks={backgroundTasks}
          cancellingKeys={cancellingBackgroundTaskKeys}
          onCancel={onCancelBackgroundTask}
          onOpenAgent={onOpenAgentTask}
          onOpenQuery={onOpenQueryTask}
        />
      ) : null}
      <SqlEditorStatusItems
        documentId={
          activeDocument?.kind === "sql" ? activeDocument.id : null
        }
      />
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

function SqlEditorStatusItems({ documentId }: { documentId: string | null }) {
  const { t } = useI18n();
  const editorStatus = useSqlEditorCursor(documentId);
  return (
    <>
      {editorStatus ? (
        <>
          <StatusBarItem>
            {editorStatus.line}:{editorStatus.column}
          </StatusBarItem>
          <StatusBarItem>LF</StatusBarItem>
        </>
      ) : null}
      <StatusBarItem>UTF-8</StatusBarItem>
      {editorStatus ? (
        <StatusBarItem>
          {t("ide.indentSpaces", {
            count: SQL_EDITOR_INDENT_SIZE,
          })}
        </StatusBarItem>
      ) : null}
    </>
  );
}
