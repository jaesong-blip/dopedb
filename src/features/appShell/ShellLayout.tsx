import type { ReactNode, RefObject } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

import { Icon } from "../../components/Icon";
import AcpChatPanel from "../agents/AcpChatPanel";
import { AgentSelectionProvider } from "../agents/selectionContext";
import type { BackgroundTask } from "../backgroundTasks/domain";
import type { ConnectionProfile } from "../connections/domain";
import type {
  KnowledgeEnvironmentFocus,
  KnowledgeEnvironmentView,
} from "../knowledge/domain";
import type { QueryServiceStore } from "../queryServices/store";
import { defaultSqlNamespace } from "../queries/namespace";
import type { WorkspaceManualTransaction } from "../queries/useWorkspaceManualTransactions";
import type { WorkbenchDocument } from "../workbench/domain";
import QueryServicesToolWindow from "../queryServices/QueryServicesToolWindow";
import LocalHistoryToolWindow from "../localHistory/LocalHistoryToolWindow";
import WorkspaceAccount from "../workspaces/components/WorkspaceAccount";
import WorkspaceSwitcher from "../workspaces/components/WorkspaceSwitcher";
import type { CatalogTable } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { SchemaConnectionGroup } from "../../lib/schemaDiff";
import { tableKey } from "../../lib/tableRef";
import { DatabaseExplorer } from "../../screens/Connections";
import type { ConnectionLaunchPreset } from "../connections/presets";
import { clampAgentDockWidth } from "../agents/layout";
import { IdeStatusBar, IdeTopBar } from "./IdeChrome";
import type { AppArea } from "./navigation";

const IS_MACOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

type Props = {
  area: AppArea;
  settingsOpen: boolean;
  activeSchemaGroupKey: string | null;
  connections: ConnectionProfile[];
  selected: ConnectionProfile | null;
  selectedId: string | null;
  selectedTable: CatalogTable | null;
  supportsSql: boolean;
  writeEnabled: boolean;
  knowledgeEnvironmentFocus: KnowledgeEnvironmentFocus | null;
  compact: boolean;
  mobileExplorerOpen: boolean;
  databaseExplorerOpen: boolean;
  localHistoryOpen: boolean;
  servicesOpen: boolean;
  servicesHeight: number;
  queryServiceStore: QueryServiceStore;
  backgroundTasks: BackgroundTask[];
  cancellingBackgroundTaskKeys: ReadonlySet<string>;
  manualTransactions: WorkspaceManualTransaction[];
  settlingManualTransactionIds: ReadonlySet<string>;
  workbenchDocuments: WorkbenchDocument[];
  activeWorkbenchDocumentId: string | null;
  explorerRevealRequest: number;
  unseenOperationCount: number;
  sidebarWidth: number;
  mainRef: RefObject<HTMLElement | null>;
  terminalButtonRef: RefObject<HTMLButtonElement | null>;
  searchEverywhereButtonRef: RefObject<HTMLButtonElement | null>;
  mainContent: ReactNode;
  availableUpdate: Update | null;
  showTerminalDock: boolean;
  searchEverywhereOpen: boolean;
  terminalOverlay: boolean;
  terminalWidth: number;
  creatingDemo: boolean;
  onWorkspaceScopeChanged: () => Promise<void>;
  onWorkspaceDataRefreshed: () => Promise<void>;
  onNewConnection: (preset?: ConnectionLaunchPreset) => void;
  onCreateDemoDatabase: () => void;
  onArea: (area: AppArea) => void;
  onOpenProjectEnvironment: (
    environmentId: string | null,
    view: KnowledgeEnvironmentView,
    resourceId?: string | null,
  ) => void;
  onToggleDatabaseExplorer: () => void;
  onToggleLocalHistory: () => void;
  onCloseLocalHistory: () => void;
  onToggleServices: () => void;
  onCloseServices: () => void;
  onCancelBackgroundTask: (task: BackgroundTask) => Promise<void>;
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
  onRevealDatabaseContext: () => void;
  onActivateWorkbenchDocument: (id: string) => void;
  onRestoreWorkbenchDocument: (id: string, content: string) => void;
  onStartServicesResize: (event: {
    preventDefault(): void;
    clientY: number;
  }) => void;
  onResetServicesHeight: () => void;
  onSettings: () => void;
  onSafetySettings: () => void;
  onOpenNotifications: () => void;
  onNewQuery: () => void;
  onOpenAgentArchive: () => void;
  onOpenTerminal: () => void;
  onSearchEverywhere: (returnFocus?: HTMLElement | null) => void;
  onSelectWorkspaceConnection: (id: string) => void;
  onOpenTable: (connection: ConnectionProfile, table: CatalogTable) => void;
  onOpenSchemaDiff: (group: SchemaConnectionGroup) => void;
  onEditConnection: (connection: ConnectionProfile) => void;
  onDeletedConnection: (id: string) => Promise<void>;
  onConnectionUpdated: (connection: ConnectionProfile) => void;
  onDismissMobileExplorer: () => void;
  onStartSidebarDrag: (event: {
    preventDefault(): void;
    clientX: number;
  }) => void;
  onResetSidebar: () => void;
  onOpenUpdateSettings: () => void;
  onTerminalWidthChange: (width: number) => void;
  onCloseTerminal: () => void;
};

export default function ShellLayout(props: Props) {
  return (
    <AgentSelectionProvider>
      <ShellLayoutContent {...props} />
    </AgentSelectionProvider>
  );
}

function ShellLayoutContent(props: Props) {
  const { t } = useI18n();
  const {
    area,
    settingsOpen,
    activeSchemaGroupKey,
    connections,
    selected,
    selectedId,
    selectedTable,
    supportsSql,
    writeEnabled,
    compact,
    mobileExplorerOpen,
    databaseExplorerOpen,
    localHistoryOpen,
    servicesOpen,
    servicesHeight,
    queryServiceStore,
    workbenchDocuments,
    activeWorkbenchDocumentId,
    sidebarWidth,
    mainRef,
    mainContent,
    availableUpdate,
    showTerminalDock,
    terminalOverlay,
    terminalWidth,
    creatingDemo,
  } = props;
  const showUpdateBadge = !!availableUpdate && !settingsOpen;
  const databaseExplorerVisible = databaseExplorerOpen;
  const localHistoryVisible = area !== "knowledge" && localHistoryOpen;
  const leftToolWindowVisible =
    databaseExplorerVisible || localHistoryVisible;
  const servicesVisible = servicesOpen;
  const rightDockWidth = showTerminalDock && !terminalOverlay
    ? clampAgentDockWidth(
        terminalWidth,
        typeof window === "undefined" ? 1_280 : window.innerWidth,
      )
    : 0;
  const activeWorkbenchDocument =
    workbenchDocuments.find(
      (document) => document.id === activeWorkbenchDocumentId,
    ) ?? null;
  const selectedNamespace = selected
    ? activeWorkbenchDocument?.kind === "sql"
      ? activeWorkbenchDocument.selectedSchema ??
        defaultSqlNamespace(selected)
      : activeWorkbenchDocument?.kind === "data"
        ? activeWorkbenchDocument.table.schema ??
          defaultSqlNamespace(selected)
        : defaultSqlNamespace(selected)
    : null;
  const selectedDatabase = selected
    ? activeWorkbenchDocument?.kind === "sql"
      ? activeWorkbenchDocument.selectedDatabase || selected.database
      : activeWorkbenchDocument?.kind === "data"
        ? activeWorkbenchDocument.table.database ?? selected.database
        : selected.database
    : null;
  return (
    <div
      className="app tw:grid tw:h-dvh tw:overflow-hidden tw:bg-muted"
      data-compact={compact}
      data-platform={IS_MACOS ? "macos" : "other"}
      data-terminal-open={showTerminalDock}
      data-mobile-explorer-open={mobileExplorerOpen}
      data-database-explorer-open={databaseExplorerVisible}
      data-local-history-open={localHistoryVisible}
      data-services-open={servicesVisible}
      style={{
        gridTemplateColumns: compact
          ? "minmax(0, 1fr)"
          : leftToolWindowVisible
            ? `${sidebarWidth}px 4px minmax(0, 1fr) ${rightDockWidth}px`
            : `0 0 minmax(0, 1fr) ${rightDockWidth}px`,
        gridTemplateRows: compact
          ? "var(--ds-title-toolbar-height) minmax(0, 1fr) var(--ds-status-bar-height)"
          : `var(--ds-title-toolbar-height) minmax(0, 1fr) ${
              servicesVisible ? servicesHeight : 0
            }px var(--ds-status-bar-height)`,
      }}
    >
      <IdeTopBar
        area={area}
        selected={selected}
        supportsSql={supportsSql}
        databaseExplorerOpen={
          databaseExplorerVisible && (!compact || mobileExplorerOpen)
        }
        localHistoryOpen={
          localHistoryVisible && (!compact || mobileExplorerOpen)
        }
        servicesOpen={servicesVisible}
        showTerminalDock={showTerminalDock}
        searchEverywhereOpen={props.searchEverywhereOpen}
        settingsOpen={settingsOpen}
        account={
          <WorkspaceAccount
            compact
            menuPlacement="topbar"
            onScopeChanged={props.onWorkspaceScopeChanged}
            onWorkspaceDataRefreshed={props.onWorkspaceDataRefreshed}
          />
        }
        onNewQuery={props.onNewQuery}
        onArea={props.onArea}
        onToggleDatabaseExplorer={props.onToggleDatabaseExplorer}
        onToggleLocalHistory={props.onToggleLocalHistory}
        onToggleServices={props.onToggleServices}
        onOpenTerminal={props.onOpenTerminal}
        terminalButtonRef={props.terminalButtonRef}
        searchEverywhereButtonRef={props.searchEverywhereButtonRef}
        onSearchEverywhere={props.onSearchEverywhere}
        onSettings={props.onSettings}
        workspace={
          <WorkspaceSwitcher
            onNew={props.onNewConnection}
            onChanged={props.onWorkspaceScopeChanged}
          />
        }
      />

      <div
        className="tw:col-start-1 tw:row-start-2 tw:min-h-0 tw:min-w-0 tw:overflow-hidden tw:max-[561px]:contents"
        aria-hidden={!leftToolWindowVisible}
        inert={!leftToolWindowVisible ? true : undefined}
      >
        {localHistoryVisible ? (
          <LocalHistoryToolWindow
            connection={selected}
            documents={workbenchDocuments}
            activeDocumentId={activeWorkbenchDocumentId}
            onActivateDocument={props.onActivateWorkbenchDocument}
            onRestoreRevision={props.onRestoreWorkbenchDocument}
            onClose={props.onCloseLocalHistory}
            compact={compact}
            compactOpen={mobileExplorerOpen}
          />
        ) : (
          <DatabaseExplorer
            connections={connections}
            selectedId={selectedId}
            selectedTableKey={selectedTable ? tableKey(selectedTable) : null}
            activeSchemaGroupKey={activeSchemaGroupKey}
            onSelectConn={props.onSelectWorkspaceConnection}
            onOpenTable={props.onOpenTable}
            onOpenSchemaDiff={props.onOpenSchemaDiff}
            onEdit={props.onEditConnection}
            onDeleted={props.onDeletedConnection}
            onConnectionUpdated={props.onConnectionUpdated}
            onNewConnection={props.onNewConnection}
            onClose={props.onToggleDatabaseExplorer}
            onCreateDemoDatabase={props.onCreateDemoDatabase}
            creatingDemo={creatingDemo}
            compact={compact}
            compactOpen={mobileExplorerOpen}
            revealRequest={props.explorerRevealRequest}
            revealDatabase={selectedDatabase}
            revealNamespace={selectedNamespace}
            activeProjectEnvironmentId={
              area === "knowledge"
                ? props.knowledgeEnvironmentFocus?.environmentId ?? null
                : null
            }
            activeProjectEnvironmentView={
              area === "knowledge"
                ? props.knowledgeEnvironmentFocus?.view ?? null
                : null
            }
            activeProjectEnvironmentResourceId={
              area === "knowledge"
                ? props.knowledgeEnvironmentFocus?.resourceId ?? null
                : null
            }
            onOpenProjectEnvironment={props.onOpenProjectEnvironment}
          />
        )}
      </div>

      <button
        type="button"
        data-open={mobileExplorerOpen}
        className="tw:hidden tw:max-[561px]:fixed tw:max-[561px]:inset-x-0 tw:max-[561px]:top-title-toolbar tw:max-[561px]:bottom-status-bar tw:max-[561px]:z-[var(--ds-z-sticky)] tw:max-[561px]:block tw:max-[561px]:cursor-default tw:max-[561px]:border-0 tw:max-[561px]:bg-overlay tw:max-[561px]:p-0 tw:max-[561px]:opacity-0 tw:max-[561px]:pointer-events-none tw:max-[561px]:transition-opacity tw:max-[561px]:duration-150 tw:max-[561px]:data-[open=true]:opacity-100 tw:max-[561px]:data-[open=true]:pointer-events-auto"
        aria-label={t("common.close")}
        aria-hidden={!mobileExplorerOpen}
        tabIndex={mobileExplorerOpen ? 0 : -1}
        onClick={props.onDismissMobileExplorer}
      />
      <div
        className="tw:col-start-2 tw:row-start-2 tw:ml-[var(--ds-active-offset)] tw:cursor-col-resize tw:bg-transparent tw:hover:bg-muted tw:active:bg-muted tw:max-[561px]:hidden"
        hidden={!leftToolWindowVisible}
        title={t("app.dragResize")}
        onMouseDown={props.onStartSidebarDrag}
        onDoubleClick={props.onResetSidebar}
      />
      <main
        ref={mainRef}
        data-compact={compact}
        className="main tw:col-start-3 tw:row-start-2 tw:mt-0 tw:mr-panel-gutter tw:mb-panel-gutter tw:ml-0 tw:flex tw:min-w-0 tw:flex-col tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background tw:outline-none tw:[container-name:main-pane] tw:[container-type:inline-size] tw:data-[compact=true]:col-start-1 tw:data-[compact=true]:m-0 tw:data-[compact=true]:min-h-0 tw:data-[compact=true]:rounded-none tw:data-[compact=true]:border-0"
        tabIndex={-1}
        inert={mobileExplorerOpen ? true : undefined}
      >
        {mainContent}
        {showUpdateBadge && (
          <div className="ds-attention-stack">
            <button
              className="ds-attention-badge ds-tone-trust"
              onClick={props.onOpenUpdateSettings}
              title={t("updates.badgeTitle")}
              aria-label={t("updates.badgeTitle")}
            >
              <Icon name="download" />
              <span>
                {t("updates.badge", { version: availableUpdate?.version ?? "" })}
              </span>
            </button>
          </div>
        )}
      </main>

      {showTerminalDock && selected && (
        <AcpChatPanel
          connection={selected}
          documents={workbenchDocuments}
          activeDocumentId={activeWorkbenchDocumentId}
          selectedTable={selectedTable}
          overlay={terminalOverlay}
          compact={compact}
          width={rightDockWidth}
          onWidthChange={props.onTerminalWidthChange}
          onOpenArchive={props.onOpenAgentArchive}
          onOpenKnowledgeAnalysis={(environmentId) =>
            props.onOpenProjectEnvironment(environmentId, "dashboards")
          }
          onClose={props.onCloseTerminal}
        />
      )}

      {servicesVisible && (
        <QueryServicesToolWindow
          store={queryServiceStore}
          connections={connections}
          documents={workbenchDocuments}
          activeDocumentId={activeWorkbenchDocumentId}
          onActivateDocument={props.onActivateWorkbenchDocument}
          onClose={props.onCloseServices}
          onStartResize={props.onStartServicesResize}
          onResetHeight={props.onResetServicesHeight}
          compact={compact}
        />
      )}

      <IdeStatusBar
        selected={selected}
        selectedTable={selectedTable}
        selectedDatabase={selectedDatabase}
        selectedNamespace={selectedNamespace}
        activeDocument={activeWorkbenchDocument}
        backgroundTasks={props.backgroundTasks}
        cancellingBackgroundTaskKeys={
          props.cancellingBackgroundTaskKeys
        }
        manualTransactions={props.manualTransactions}
        settlingManualTransactionIds={
          props.settlingManualTransactionIds
        }
        writeEnabled={writeEnabled}
        unseenOperationCount={props.unseenOperationCount}
        onOpenQueryTask={(sessionId) => {
          queryServiceStore.activate(sessionId);
          if (!servicesVisible) props.onToggleServices();
        }}
        onOpenAgentTask={props.onOpenAgentTask}
        onOpenManualTransaction={props.onOpenManualTransaction}
        onCommitManualTransaction={props.onCommitManualTransaction}
        onRollbackManualTransaction={props.onRollbackManualTransaction}
        onCancelBackgroundTask={props.onCancelBackgroundTask}
        onRevealDatabaseContext={props.onRevealDatabaseContext}
        onOpenNotifications={props.onOpenNotifications}
        onSafetySettings={props.onSafetySettings}
      />
    </div>
  );
}
