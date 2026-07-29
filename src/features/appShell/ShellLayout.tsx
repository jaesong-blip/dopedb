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
  const databaseExplorerVisible = databaseExplorerOpen;
  const localHistoryVisible = localHistoryOpen;
  const leftToolWindowVisible =
    databaseExplorerVisible || localHistoryVisible;
  const servicesVisible = servicesOpen;
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
      className="app tw:grid tw:h-dvh tw:overflow-hidden tw:bg-muted tw:data-[compact=true]:h-[calc(100dvh-48px)]"
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
            ? `${sidebarWidth}px 3px minmax(0, 1fr) ${rightDockWidth}px`
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
        area={area}
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
        className="tool-window-sidebar tw:col-start-1 tw:row-start-2 tw:min-h-0 tw:min-w-0 tw:overflow-hidden tw:max-[561px]:contents"
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
        ) : area === "dashboard" &&
        editing === null &&
        !activeSchemaGroup ? (
          <DashboardSidebar
            connections={connections}
            selectedId={selectedId}
            focusId={dashboardFocusId}
            onSelectConnection={props.onSelectDashboardConnection}
            onFocus={props.onDashboardFocus}
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
            onNewQuery={props.onNewQuery}
            onClose={props.onToggleDatabaseExplorer}
            onCreateDemoDatabase={props.onCreateDemoDatabase}
            creatingDemo={creatingDemo}
            compact={compact}
            compactOpen={mobileExplorerOpen}
          />
        )}
      </div>

      <button
        type="button"
        data-open={mobileExplorerOpen}
        className="mobile-sidebar-scrim tw:hidden tw:max-[561px]:fixed tw:max-[561px]:inset-x-0 tw:max-[561px]:top-title-toolbar tw:max-[561px]:bottom-20 tw:max-[561px]:z-[var(--ds-z-sticky)] tw:max-[561px]:block tw:max-[561px]:cursor-default tw:max-[561px]:border-0 tw:max-[561px]:bg-overlay tw:max-[561px]:p-0 tw:max-[561px]:opacity-0 tw:max-[561px]:pointer-events-none tw:max-[561px]:transition-opacity tw:max-[561px]:duration-150 tw:max-[561px]:data-[open=true]:opacity-100 tw:max-[561px]:data-[open=true]:pointer-events-auto"
        aria-label={t("common.close")}
        aria-hidden={!mobileExplorerOpen}
        tabIndex={mobileExplorerOpen ? 0 : -1}
        onClick={props.onDismissMobileExplorer}
      />
      <div
        className="sidebar-resizer tw:col-start-2 tw:row-start-2 tw:ml-[var(--ds-active-offset)] tw:cursor-col-resize tw:bg-transparent tw:hover:bg-muted tw:active:bg-muted tw:max-[561px]:hidden"
        hidden={!leftToolWindowVisible}
        title={t("app.dragResize")}
        onMouseDown={props.onStartSidebarDrag}
        onDoubleClick={props.onResetSidebar}
      />
      <main
        ref={mainRef}
        data-compact={compact}
        className="main tw:col-start-3 tw:row-start-2 tw:m-panel-gutter tw:flex tw:min-w-0 tw:flex-col tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background tw:outline-none tw:[container-name:main-pane] tw:[container-type:inline-size] tw:data-[compact=true]:col-start-1 tw:data-[compact=true]:m-0 tw:data-[compact=true]:min-h-0 tw:data-[compact=true]:rounded-none tw:data-[compact=true]:border-0"
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
          compact={compact}
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
          compact={compact}
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
