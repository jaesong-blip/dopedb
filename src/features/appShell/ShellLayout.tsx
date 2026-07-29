import type { ReactNode, RefObject } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

import { Icon } from "../../components/Icon";
import TerminalDock from "../../components/TerminalDock/TerminalDock";
import type { ConnectionProfile } from "../connections/domain";
import type { QueryServiceSession } from "../queryServices/domain";
import { defaultSqlNamespace } from "../queries/namespace";
import type { SqlEditorStatus } from "../queries/editorStatus";
import type { WorkbenchDocument } from "../workbench/domain";
import QueryServicesToolWindow from "../queryServices/QueryServicesToolWindow";
import LocalHistoryToolWindow from "../localHistory/LocalHistoryToolWindow";
import WorkspaceAccount from "../workspaces/components/WorkspaceAccount";
import WorkspaceSwitcher from "../workspaces/components/WorkspaceSwitcher";
import type { CatalogTable, SkillStatus } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { SchemaConnectionGroup } from "../../lib/schemaDiff";
import { tableKey } from "../../lib/tableRef";
import { DatabaseExplorer } from "../../screens/Connections";
import { DashboardSidebar } from "../../screens/Dashboards";
import type { ConnectionLaunchPreset } from "../connections/presets";
import type { EditingConnection } from "./WorkbenchContent";
import { IdeStatusBar, IdeTopBar } from "./IdeChrome";
import WorkbenchRail, { type AppArea } from "./WorkbenchRail";

const IS_MACOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

type Props = {
  area: AppArea;
  settingsOpen: boolean;
  editing: EditingConnection;
  activeSchemaGroup: SchemaConnectionGroup | null;
  activeSchemaGroupKey: string | null;
  connections: ConnectionProfile[];
  selected: ConnectionProfile | null;
  selectedId: string | null;
  selectedTable: CatalogTable | null;
  supportsSql: boolean;
  writeEnabled: boolean;
  dashboardFocusId: string | null;
  compact: boolean;
  mobileExplorerOpen: boolean;
  databaseExplorerOpen: boolean;
  localHistoryOpen: boolean;
  servicesOpen: boolean;
  servicesHeight: number;
  queryServiceSessions: QueryServiceSession[];
  activeQueryServiceSessionId: string | null;
  workbenchDocuments: WorkbenchDocument[];
  activeWorkbenchDocumentId: string | null;
  sqlEditorStatus: SqlEditorStatus | null;
  unseenOperationCount: number;
  sidebarWidth: number;
  mainRef: RefObject<HTMLElement | null>;
  terminalButtonRef: RefObject<HTMLButtonElement | null>;
  mainContent: ReactNode;
  availableUpdate: Update | null;
  showTerminalDock: boolean;
  searchEverywhereOpen: boolean;
  terminalOverlay: boolean;
  terminalWidth: number;
  skillStatus: SkillStatus | null;
  creatingDemo: boolean;
  onWorkspaceScopeChanged: () => Promise<void>;
  onNewConnection: (preset?: ConnectionLaunchPreset) => void;
  onCreateDemoDatabase: () => void;
  onArea: (area: AppArea) => void;
  onToggleDatabaseExplorer: () => void;
  onToggleLocalHistory: () => void;
  onCloseLocalHistory: () => void;
  onToggleServices: () => void;
  onCloseServices: () => void;
  onActivateQueryServiceSession: (id: string) => void;
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
  onSearchEverywhere: () => void;
  onSelectDashboardConnection: (id: string) => void;
  onDashboardFocus: (id: string | null) => void;
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
  const { t } = useI18n();
  const {
    area,
    settingsOpen,
    editing,
    activeSchemaGroup,
    activeSchemaGroupKey,
    connections,
    selected,
    selectedId,
    selectedTable,
    supportsSql,
    writeEnabled,
    dashboardFocusId,
    compact,
    mobileExplorerOpen,
    databaseExplorerOpen,
    localHistoryOpen,
    servicesOpen,
    servicesHeight,
    queryServiceSessions,
    activeQueryServiceSessionId,
    workbenchDocuments,
    activeWorkbenchDocumentId,
    sidebarWidth,
    mainRef,
    mainContent,
    availableUpdate,
    showTerminalDock,
    terminalOverlay,
    terminalWidth,
    skillStatus,
    creatingDemo,
  } = props;
  const showUpdateBadge = !!availableUpdate && !settingsOpen;
  const databaseExplorerVisible =
    databaseExplorerOpen && !settingsOpen;
  const localHistoryVisible = localHistoryOpen && !settingsOpen;
  const leftToolWindowVisible =
    databaseExplorerVisible || localHistoryVisible;
  const servicesVisible = servicesOpen && !settingsOpen;
  const rightDockWidth = showTerminalDock && !terminalOverlay
    ? terminalWidth
    : 0;
  const statusQuerySession =
    queryServiceSessions.find(
      (session) =>
        session.id === activeQueryServiceSessionId &&
        (session.status === "running" ||
          session.status === "waiting"),
    ) ??
    queryServiceSessions.find(
      (session) =>
        session.status === "running" ||
        session.status === "waiting",
    ) ??
    null;
  const backgroundProcessCount = queryServiceSessions.filter(
    (session) =>
      session.status === "running" ||
      session.status === "waiting",
  ).length;
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
  const activeSqlEditorStatus =
    activeWorkbenchDocument?.kind === "sql" &&
    props.sqlEditorStatus?.documentId === activeWorkbenchDocument.id
      ? props.sqlEditorStatus
      : null;

  return (
    <div
      className="app tw:grid tw:h-dvh tw:overflow-hidden tw:bg-muted"
      data-platform={IS_MACOS ? "macos" : "other"}
      data-terminal-open={showTerminalDock}
      data-mobile-explorer-open={mobileExplorerOpen}
      data-database-explorer-open={databaseExplorerVisible}
      data-local-history-open={localHistoryVisible}
      data-services-open={servicesVisible}
      style={{
        gridTemplateColumns: leftToolWindowVisible
          ? `${sidebarWidth}px 3px minmax(0, 1fr) ${rightDockWidth}px`
          : `0 0 minmax(0, 1fr) ${rightDockWidth}px`,
        gridTemplateRows: `40px minmax(0, 1fr) ${
          servicesVisible ? servicesHeight : 0
        }px 24px`,
      }}
    >
      <IdeTopBar
        area={area}
        selected={selected}
        supportsSql={supportsSql}
        databaseExplorerOpen={databaseExplorerVisible}
        localHistoryOpen={localHistoryVisible}
        servicesOpen={servicesVisible}
        showTerminalDock={showTerminalDock}
        searchEverywhereOpen={props.searchEverywhereOpen}
        account={
          <WorkspaceAccount
            compact
            menuPlacement="topbar"
            onScopeChanged={props.onWorkspaceScopeChanged}
          />
        }
        onNewQuery={props.onNewQuery}
        onArea={props.onArea}
        onToggleDatabaseExplorer={props.onToggleDatabaseExplorer}
        onToggleLocalHistory={props.onToggleLocalHistory}
        onToggleServices={props.onToggleServices}
        onOpenTerminal={props.onOpenTerminal}
        terminalButtonRef={props.terminalButtonRef}
        onSearchEverywhere={props.onSearchEverywhere}
        onSettings={props.onSettings}
        workspace={
          <WorkspaceSwitcher
            onNew={props.onNewConnection}
            onChanged={props.onWorkspaceScopeChanged}
          />
        }
      />

      <WorkbenchRail
        area={settingsOpen ? null : area}
        dashboardAvailable={!selected || supportsSql}
        settingsOpen={settingsOpen}
        sidebarExpanded={!compact || mobileExplorerOpen}
        account={
          <WorkspaceAccount
            compact
            onScopeChanged={props.onWorkspaceScopeChanged}
          />
        }
        onArea={props.onArea}
        onSettings={props.onSettings}
      />

      <div
        className="tool-window-sidebar tw:col-start-1 tw:row-start-2 tw:min-h-0 tw:min-w-0 tw:overflow-hidden tw:max-[560px]:contents"
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
          />
        ) : area === "dashboard" &&
        !settingsOpen &&
        editing === null &&
        !activeSchemaGroup ? (
          <DashboardSidebar
            connections={connections}
            selectedId={selectedId}
            focusId={dashboardFocusId}
            onSelectConnection={props.onSelectDashboardConnection}
            onFocus={props.onDashboardFocus}
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
            onNewQuery={props.onNewQuery}
            onClose={props.onToggleDatabaseExplorer}
            onCreateDemoDatabase={props.onCreateDemoDatabase}
            creatingDemo={creatingDemo}
          />
        )}
      </div>

      <button
        type="button"
        data-open={mobileExplorerOpen}
        className="mobile-sidebar-scrim tw:hidden tw:max-[560px]:fixed tw:max-[560px]:inset-x-0 tw:max-[560px]:top-0 tw:max-[560px]:bottom-12 tw:max-[560px]:z-[var(--ds-z-sticky)] tw:max-[560px]:block tw:max-[560px]:cursor-default tw:max-[560px]:border-0 tw:max-[560px]:bg-overlay tw:max-[560px]:p-0 tw:max-[560px]:opacity-0 tw:max-[560px]:pointer-events-none tw:max-[560px]:transition-opacity tw:max-[560px]:duration-150 tw:max-[560px]:data-[open=true]:opacity-100 tw:max-[560px]:data-[open=true]:pointer-events-auto"
        aria-label={t("common.close")}
        aria-hidden={!mobileExplorerOpen}
        tabIndex={mobileExplorerOpen ? 0 : -1}
        onClick={props.onDismissMobileExplorer}
      />
      <div
        className="sidebar-resizer tw:col-start-2 tw:row-start-2 tw:ml-[var(--ds-active-offset)] tw:cursor-col-resize tw:bg-transparent tw:hover:bg-muted tw:active:bg-muted tw:max-[560px]:hidden"
        hidden={!leftToolWindowVisible}
        title={t("app.dragResize")}
        onMouseDown={props.onStartSidebarDrag}
        onDoubleClick={props.onResetSidebar}
      />
      <main
        ref={mainRef}
        className="main tw:col-start-3 tw:row-start-2 tw:m-1 tw:flex tw:min-w-0 tw:flex-col tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background tw:outline-none tw:[container-name:main-pane] tw:[container-type:inline-size] tw:max-[560px]:m-0 tw:max-[560px]:min-h-0 tw:max-[560px]:rounded-none tw:max-[560px]:border-0 tw:max-[560px]:pt-[var(--ds-window-controls-safe-height)]"
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
        <TerminalDock
          connection={selected}
          documents={workbenchDocuments}
          activeDocumentId={activeWorkbenchDocumentId}
          skillStatus={skillStatus}
          overlay={terminalOverlay}
          width={terminalWidth}
          presentation="agent"
          onWidthChange={props.onTerminalWidthChange}
          onOpenArchive={props.onOpenAgentArchive}
          onClose={props.onCloseTerminal}
        />
      )}

      {servicesVisible && (
        <QueryServicesToolWindow
          sessions={queryServiceSessions}
          activeSessionId={activeQueryServiceSessionId}
          connections={connections}
          documents={workbenchDocuments}
          activeDocumentId={activeWorkbenchDocumentId}
          onActivate={props.onActivateQueryServiceSession}
          onActivateDocument={props.onActivateWorkbenchDocument}
          onClose={props.onCloseServices}
          onStartResize={props.onStartServicesResize}
          onResetHeight={props.onResetServicesHeight}
        />
      )}

      <IdeStatusBar
        selected={selected}
        selectedTable={selectedTable}
        selectedNamespace={selectedNamespace}
        activeDocument={activeWorkbenchDocument}
        querySession={statusQuerySession}
        backgroundProcessCount={backgroundProcessCount}
        editorStatus={activeSqlEditorStatus}
        writeEnabled={writeEnabled}
        unseenOperationCount={props.unseenOperationCount}
        onQueryStatus={() => {
          if (statusQuerySession) {
            props.onActivateQueryServiceSession(statusQuerySession.id);
          }
          if (!servicesVisible) props.onToggleServices();
        }}
        onOpenNotifications={props.onOpenNotifications}
        onSafetySettings={props.onSafetySettings}
      />
    </div>
  );
}
