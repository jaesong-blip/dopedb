import type { Update } from "@tauri-apps/plugin-updater";
import type { RefObject } from "react";

import EngineMark from "../../components/EngineMark";
import { Icon } from "../../components/Icon";
import WorkbenchDocumentStrip from "../../components/WorkbenchDocumentStrip";
import type { ConnectionProfile } from "../connections/domain";
import type { SqlDocument } from "../sqlDocuments/domain";
import type { WorkbenchDocument } from "../workbench/domain";
import type { CatalogTable, SafetySettings } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { SchemaConnectionGroup } from "../../lib/schemaDiff";
import { tableLabel } from "../../lib/tableRef";
import Activity from "../../screens/Activity";
import { ConnectionForm } from "../../screens/Connections";
import Dashboards from "../../screens/Dashboards";
import Documents from "../../screens/Documents";
import Onboarding from "../../screens/Onboarding";
import SchemaExplorer from "../../screens/Schema";
import SchemaDiff from "../../screens/SchemaDiff";
import Settings, { type SettingsSection } from "../../screens/Settings";
import Sql from "../../screens/Sql";
import TableData from "../../screens/Tables";
import ConnectionPicker from "./ConnectionPicker";
import type { AppArea } from "./WorkbenchRail";

export type EditingConnection = ConnectionProfile | "new" | null;

type Props = {
  settingsOpen: boolean;
  settingsSection?: SettingsSection;
  selected: ConnectionProfile | null;
  activeSchemaGroup: SchemaConnectionGroup | null;
  editing: EditingConnection;
  loadError: string | null;
  connections: ConnectionProfile[];
  safety: SafetySettings | null;
  safetyError: string | null;
  area: AppArea;
  selectedDocuments: WorkbenchDocument[];
  activeDocument: WorkbenchDocument | null;
  activeDocumentId: string | null;
  selectedTable: CatalogTable | null;
  supportsSql: boolean;
  dashboardFocusId: string | null;
  initialAuditOpen: boolean;
  availableUpdate: Update | null;
  showTerminalDock: boolean;
  terminalButtonRef: RefObject<HTMLButtonElement | null>;
  onCloseSettings: () => void;
  onUpdateChecked: (update: Update | null) => void;
  onRefreshSafety: () => void;
  onCloseSchemaDiff: () => void;
  onConnectionSaved: (profile: ConnectionProfile) => Promise<void>;
  onCancelEditing: () => void;
  onRetryConnections: () => void;
  onNewConnection: () => void;
  onOpenAgentTools: () => void;
  onSelectConnection: (id: string) => void;
  onActivateDocument: (id: string) => void;
  onCloseDocument: (id: string) => void;
  onNewQuery: () => void;
  onOpenActivity: () => void;
  onDashboardFocusConsumed: () => void;
  onOpenTerminal: () => void;
  onSetQueryDraft: (value: string) => void;
  onSetQueryTitle: (value: string) => void;
  onPersistedQuery: (document: SqlDocument) => void;
  onOpenTable: (table: CatalogTable) => void;
  onLoadSql: (sql: string) => Promise<void>;
  onInitialAuditOpenConsumed: () => void;
  onRetrySafety: () => void;
};

export default function WorkbenchContent(props: Props) {
  const { t } = useI18n();
  const {
    settingsOpen,
    settingsSection,
    selected,
    activeSchemaGroup,
    editing,
    loadError,
    connections,
    safety,
    safetyError,
    area,
    selectedDocuments,
    activeDocument,
    activeDocumentId,
    selectedTable,
    supportsSql,
    dashboardFocusId,
    initialAuditOpen,
    availableUpdate,
    showTerminalDock,
    terminalButtonRef,
  } = props;

  if (settingsOpen) {
    return (
      <Settings
        connection={selected}
        initialSection={settingsSection}
        refreshSafety={props.onRefreshSafety}
        availableUpdate={availableUpdate}
        onUpdateChecked={props.onUpdateChecked}
        onClose={props.onCloseSettings}
      />
    );
  }

  if (activeSchemaGroup) {
    return (
      <SchemaDiff
        key={activeSchemaGroup.key}
        group={activeSchemaGroup}
        onClose={props.onCloseSchemaDiff}
      />
    );
  }

  if (editing !== null) {
    return (
      <div className="editor-pane">
        <ConnectionForm
          initial={editing === "new" ? null : editing}
          onSaved={props.onConnectionSaved}
          onCancel={props.onCancelEditing}
        />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="placeholder">
        <div className="error">
          {t("app.couldNotLoadConnections", { error: loadError })}
        </div>
        <button className="btn" onClick={props.onRetryConnections}>
          {t("app.retry")}
        </button>
      </div>
    );
  }

  if (connections.length === 0) {
    return (
      <Onboarding
        onNewConnection={props.onNewConnection}
        onOpenAgentTools={props.onOpenAgentTools}
      />
    );
  }

  const safetyFallback = safetyError ? (
    <div className="error">
      {t("app.loadSafetyFailed", { error: safetyError })}{" "}
      <button className="btn small" onClick={props.onRetrySafety}>
        {t("app.retry")}
      </button>
    </div>
  ) : (
    <div className="muted">{t("app.loading")}</div>
  );

  return (
    <>
      {selected && (
        <header className="main-head ds-workbench-head" data-tauri-drag-region="deep">
          <div className="ds-workbench-title">
            <div className="ds-title-line app-title-line">
              <EngineMark engine={selected.engine} />
              <strong>{selected.name || t("app.unnamed")}</strong>
              {selected.env && (
                <span className={`env-chip env-${selected.env}`}>{selected.env}</span>
              )}
              <span className="ds-meta-dot" />
              <span className="app-title-meta">{selected.database}</span>
              {area === "workspace" && selectedTable && (
                <>
                  <span className="ds-meta-dot" />
                  <span className="app-title-meta">
                    {tableLabel(selected.engine, selectedTable)}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="main-head-actions ds-control-row">
            <button
              ref={terminalButtonRef}
              type="button"
              className={`btn small icon-only main-terminal-toggle${showTerminalDock ? " active" : ""}`}
              onClick={props.onOpenTerminal}
              title={t(showTerminalDock ? "terminal.focusPanel" : "terminal.title")}
              aria-label={t(showTerminalDock ? "terminal.focusPanel" : "terminal.title")}
              aria-pressed={showTerminalDock}
            >
              <Icon name="terminal" />
            </button>
          </div>
        </header>
      )}

      {selected && area === "workspace" && (
        <WorkbenchDocumentStrip
          documents={selectedDocuments}
          activeId={activeDocumentId}
          engine={selected.engine}
          supportsSql={supportsSql}
          onActivate={props.onActivateDocument}
          onClose={props.onCloseDocument}
          onNewQuery={props.onNewQuery}
          onOpenActivity={props.onOpenActivity}
        />
      )}

      <section className={`tab-body workbench-canvas area-${area}`}>
        {!selected ? (
          <ConnectionPicker
            connections={connections}
            onSelect={props.onSelectConnection}
            onNew={props.onNewConnection}
          />
        ) : area === "dashboard" ? (
          <Dashboards
            connection={selected}
            focusId={dashboardFocusId}
            onFocusConsumed={props.onDashboardFocusConsumed}
            onOpenAgent={props.onOpenTerminal}
          />
        ) : !activeDocument ? (
          <div className="workbench-empty">
            <Icon name={supportsSql ? "play" : "list"} />
            <span className="muted">
              {supportsSql ? t("tabs.sql") : t("tabs.documents")}
            </span>
            <button className="btn primary" onClick={props.onNewQuery}>
              <Icon name="plus" />
              {supportsSql ? t("tabs.sql") : t("tabs.documents")}
            </button>
          </div>
        ) : activeDocument.kind === "data" ? (
          safety ? (
            <TableData
              key={activeDocument.id}
              connection={selected}
              table={activeDocument.table}
              safety={safety}
            />
          ) : (
            safetyFallback
          )
        ) : activeDocument.kind === "schema" ? (
          safety ? (
            <SchemaExplorer
              key={activeDocument.id}
              connection={selected}
              selectedTable={null}
              safety={safety}
              onOpenTable={props.onOpenTable}
            />
          ) : (
            safetyFallback
          )
        ) : activeDocument.kind === "sql" ? (
          safety ? (
            <Sql
              key={activeDocument.id}
              connection={selected}
              safety={safety}
              draft={activeDocument.draft}
              setDraft={props.onSetQueryDraft}
              title={activeDocument.title}
              setTitle={props.onSetQueryTitle}
              persistedId={activeDocument.persistedId}
              revision={activeDocument.revision}
              recovered={activeDocument.recovered}
              onPersisted={props.onPersistedQuery}
              onOpenAgent={props.onOpenTerminal}
            />
          ) : (
            safetyFallback
          )
        ) : activeDocument.kind === "documents" ? (
          <Documents
            key={activeDocument.id}
            connection={selected}
            draft={activeDocument.draft}
          />
        ) : (
          <Activity
            key={activeDocument.id}
            connection={selected}
            onLoadSql={props.onLoadSql}
            initialAuditOpen={initialAuditOpen}
            onInitialAuditOpenConsumed={props.onInitialAuditOpenConsumed}
          />
        )}
      </section>
    </>
  );
}
