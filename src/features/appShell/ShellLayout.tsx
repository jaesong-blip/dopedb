import type { ReactNode, RefObject } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

import { Icon } from "../../components/Icon";
import TerminalDock from "../../components/TerminalDock/TerminalDock";
import type { ConnectionProfile } from "../connections/domain";
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
import WelcomeAssistantPane from "./WelcomeAssistantPane";
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
  dashboardFocusId: string | null;
  compact: boolean;
  mobileExplorerOpen: boolean;
  sidebarWidth: number;
  mainRef: RefObject<HTMLElement | null>;
  mainContent: ReactNode;
  availableUpdate: Update | null;
  showTerminalDock: boolean;
  terminalOverlay: boolean;
  terminalWidth: number;
  skillStatus: SkillStatus | null;
  creatingDemo: boolean;
  onWorkspaceScopeChanged: () => Promise<void>;
  onNewConnection: (preset?: ConnectionLaunchPreset) => void;
  onCreateDemoDatabase: () => void;
  onArea: (area: AppArea) => void;
  onSettings: () => void;
  onNewQuery: () => void;
  onOpenActivity: () => void;
  onOpenAgentTools: () => void;
  onOpenTerminal: () => void;
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
    dashboardFocusId,
    compact,
    mobileExplorerOpen,
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
  const showWelcomeAssistant =
    connections.length === 0 && editing === null && !settingsOpen;
  const rightDockWidth = showTerminalDock && !terminalOverlay
    ? terminalWidth
    : showWelcomeAssistant
      ? 328
      : 0;

  return (
    <div
      className="app"
      data-platform={IS_MACOS ? "macos" : "other"}
      data-terminal-open={showTerminalDock}
      data-welcome-assistant-open={showWelcomeAssistant}
      data-mobile-explorer-open={mobileExplorerOpen}
      style={{
        gridTemplateColumns: `40px ${sidebarWidth}px 3px minmax(0, 1fr) ${rightDockWidth}px`,
      }}
    >
      <IdeTopBar
        area={area}
        selected={selected}
        supportsSql={supportsSql}
        showTerminalDock={showTerminalDock}
        onNewConnection={() => props.onNewConnection()}
        onNewQuery={props.onNewQuery}
        onOpenActivity={props.onOpenActivity}
        onArea={props.onArea}
        onOpenTerminal={props.onOpenTerminal}
        onSettings={props.onSettings}
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

      {area === "dashboard" &&
      !settingsOpen &&
      editing === null &&
      !activeSchemaGroup ? (
        <DashboardSidebar
          workspaceHeader={
            <WorkspaceSwitcher
              onNew={props.onNewConnection}
              onChanged={props.onWorkspaceScopeChanged}
            />
          }
          connections={connections}
          selectedId={selectedId}
          focusId={dashboardFocusId}
          onSelectConnection={props.onSelectDashboardConnection}
          onFocus={props.onDashboardFocus}
        />
      ) : (
        <DatabaseExplorer
          workspaceHeader={
            <WorkspaceSwitcher
              onNew={props.onNewConnection}
              onChanged={props.onWorkspaceScopeChanged}
            />
          }
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
          onCreateDemoDatabase={props.onCreateDemoDatabase}
          creatingDemo={creatingDemo}
        />
      )}

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
        className="sidebar-resizer tw:ml-[var(--ds-active-offset)] tw:cursor-col-resize tw:bg-transparent tw:hover:bg-muted tw:active:bg-muted tw:max-[560px]:hidden"
        title={t("app.dragResize")}
        onMouseDown={props.onStartSidebarDrag}
        onDoubleClick={props.onResetSidebar}
      />
      <main
        ref={mainRef}
        className="main tw:flex tw:min-w-0 tw:flex-col tw:overflow-hidden tw:bg-transparent tw:outline-none tw:[container-name:main-pane] tw:[container-type:inline-size] tw:max-[560px]:min-h-0 tw:max-[560px]:pt-[var(--ds-window-controls-safe-height)]"
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
          skillStatus={skillStatus}
          overlay={terminalOverlay}
          width={terminalWidth}
          onWidthChange={props.onTerminalWidthChange}
          onClose={props.onCloseTerminal}
        />
      )}

      {showWelcomeAssistant && (
        <WelcomeAssistantPane onOpenAgentTools={props.onOpenAgentTools} />
      )}

      <IdeStatusBar
        selected={selected}
        selectedTable={selectedTable}
        settingsOpen={settingsOpen}
        connectionCount={connections.length}
        onSettings={props.onSettings}
      />
    </div>
  );
}
