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
import type { EditingConnection } from "./WorkbenchContent";
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
  onWorkspaceScopeChanged: () => Promise<void>;
  onNewConnection: () => void;
  onArea: (area: AppArea) => void;
  onSettings: () => void;
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
  } = props;
  const showUpdateBadge = !!availableUpdate && !settingsOpen;

  return (
    <div
      className={`app${IS_MACOS ? " platform-macos" : ""}${
        showTerminalDock ? " terminal-open" : ""
      }${mobileExplorerOpen ? " mobile-explorer-open" : ""}`}
      style={{
        gridTemplateColumns: `48px ${sidebarWidth}px 5px minmax(0, 1fr) ${
          showTerminalDock && !terminalOverlay ? `${terminalWidth}px` : "0px"
        }`,
      }}
    >
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
        />
      )}

      <button
        type="button"
        className="mobile-sidebar-scrim"
        aria-label={t("common.close")}
        aria-hidden={!mobileExplorerOpen}
        tabIndex={mobileExplorerOpen ? 0 : -1}
        onClick={props.onDismissMobileExplorer}
      />
      <div
        className="sidebar-resizer"
        title={t("app.dragResize")}
        onMouseDown={props.onStartSidebarDrag}
        onDoubleClick={props.onResetSidebar}
      />
      <main
        ref={mainRef}
        className="main"
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
    </div>
  );
}
