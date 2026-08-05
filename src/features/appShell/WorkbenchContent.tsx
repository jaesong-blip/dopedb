import type { Update } from "@tauri-apps/plugin-updater";
import type { ReactNode } from "react";

import { Icon } from "../../components/Icon";
import WorkbenchDocumentStrip from "../../components/WorkbenchDocumentStrip";
import { WorkbenchEmptyState } from "../../design-system/components/Workbench";
import type { ConnectionProfile } from "../connections/domain";
import type { ConnectionLaunchPreset } from "../connections/presets";
import type { QueryServiceSession } from "../queryServices/domain";
import type { SqlResolveMode } from "../queries/resolveMode";
import type { SqlDocument } from "../sqlDocuments/domain";
import type { WorkbenchDocument } from "../workbench/domain";
import type { CatalogTable, SafetySettings } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { SchemaConnectionGroup } from "../../lib/schemaDiff";
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
import type { AppArea } from "./navigation";

export type EditingConnection = ConnectionProfile | "new" | null;

// The editor may render while policy storage is unavailable, but all execution
// remains disabled until the authoritative connection policy arrives.
const BLOCKED_SAFETY_SETTINGS: SafetySettings = {
  requireApproval: true,
  allowWrites: false,
  wrapWritesInTx: true,
  explainPreview: true,
  autoRunReads: false,
  maxRows: 1_000,
  execPreviewRowLimit: 0,
};

type Props = {
  settingsOpen: boolean;
  settingsSection?: SettingsSection;
  selected: ConnectionProfile | null;
  activeSchemaGroup: SchemaConnectionGroup | null;
  editing: EditingConnection;
  connectionPreset: ConnectionLaunchPreset | null;
  loadError: string | null;
  connections: ConnectionProfile[];
  safety: SafetySettings | null;
  safetyError: string | null;
  area: AppArea;
  selectedDocuments: WorkbenchDocument[];
  activeDocument: WorkbenchDocument | null;
  activeDocumentId: string | null;
  supportsSql: boolean;
  dashboardFocusId: string | null;
  initialAuditOpen: boolean;
  availableUpdate: Update | null;
  creatingDemo: boolean;
  onCloseSettings: () => void;
  onUpdateChecked: (update: Update | null) => void;
  onRefreshSafety: () => void;
  onCloseSchemaDiff: () => void;
  onConnectionSaved: (
    profile: ConnectionProfile,
    closeEditor: boolean,
  ) => Promise<void>;
  onCreateDemoDatabase: () => void;
  onCancelEditing: () => void;
  onRetryConnections: () => void;
  onNewConnection: (preset?: ConnectionLaunchPreset) => void;
  onEditConnection: (connection: ConnectionProfile) => void;
  onDeletedConnection: (id: string) => Promise<void>;
  onSelectConnection: (id: string) => void;
  onActivateDocument: (id: string) => void;
  onRenameDocument: (id: string, title: string) => void;
  onCloseDocument: (id: string) => void;
  onNewQuery: () => void;
  onOpenActivity: () => void;
  onDashboardFocusConsumed: () => void;
  onOpenTerminal: () => void;
  onSetQueryTitle: (value: string) => void;
  onSetQueryDatabase: (value: string) => void;
  onSetQuerySchema: (value: string | null) => void;
  onSetQueryResolveMode: (value: SqlResolveMode) => void;
  onPersistedQuery: (document: SqlDocument) => void;
  onQueryServiceSessionChange: (session: QueryServiceSession) => void;
  onShowQueryServices: (sessionId: string) => void;
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
    connectionPreset,
    loadError,
    connections,
    safety,
    safetyError,
    area,
    selectedDocuments,
    activeDocument,
    activeDocumentId,
    supportsSql,
    dashboardFocusId,
    initialAuditOpen,
    availableUpdate,
  } = props;
  const settingsDialog = settingsOpen ? (
    <Settings
      connection={selected}
      initialSection={settingsSection}
      refreshSafety={props.onRefreshSafety}
      availableUpdate={availableUpdate}
      onUpdateChecked={props.onUpdateChecked}
      onClose={props.onCloseSettings}
    />
  ) : null;
  const withSettings = (content: ReactNode) => (
    <>
      {content}
      {settingsDialog}
    </>
  );

  if (activeSchemaGroup) {
    return withSettings(
      <SchemaDiff
        key={activeSchemaGroup.key}
        group={activeSchemaGroup}
        onClose={props.onCloseSchemaDiff}
      />,
    );
  }

  if (editing !== null) {
    return withSettings(
      <div className="tw:h-full tw:min-h-0">
        <ConnectionForm
          key={
            editing === "new"
              ? `connection-new-${connectionPreset?.engine ?? "default"}-${connectionPreset?.provider ?? "auto"}-${connectionPreset?.source ?? "standard"}`
              : `connection-${editing.id}`
          }
          initial={editing === "new" ? null : editing}
          preset={editing === "new" ? connectionPreset : null}
          connections={connections}
          creatingDemo={props.creatingDemo}
          onCreateDemoDatabase={props.onCreateDemoDatabase}
          onNewConnection={props.onNewConnection}
          onEditConnection={props.onEditConnection}
          onDeletedConnection={props.onDeletedConnection}
          onSaved={props.onConnectionSaved}
          onCancel={props.onCancelEditing}
        />
      </div>,
    );
  }

  if (loadError) {
    return withSettings(
      <div className="tw:flex tw:h-full tw:min-w-0 tw:flex-col tw:items-center tw:justify-center tw:gap-2 tw:bg-muted tw:p-[var(--ds-pane-pad)] tw:text-center tw:leading-relaxed tw:[&>*]:max-w-[min(520px,100%)]">
        <div className="tw:break-words tw:text-ui tw:text-danger" role="alert">
          {t("app.couldNotLoadConnections", { error: loadError })}
        </div>
        <button className="btn" onClick={props.onRetryConnections}>
          {t("app.retry")}
        </button>
      </div>,
    );
  }

  if (connections.length === 0) {
    return withSettings(<Onboarding />);
  }

  const safetyFallback = safetyError ? (
    <div className="tw:text-ui tw:text-danger" role="alert">
      {t("app.loadSafetyFailed", { error: safetyError })}{" "}
      <button className="btn small" onClick={props.onRetrySafety}>
        {t("app.retry")}
      </button>
    </div>
  ) : (
    <div className="tw:text-muted-foreground">{t("app.loading")}</div>
  );

  return (
    <>
      {selected && area === "workspace" && (
        <WorkbenchDocumentStrip
          documents={selectedDocuments}
          activeId={activeDocumentId}
          engine={selected.engine}
          connectionName={selected.name || t("app.unnamed")}
          onActivate={props.onActivateDocument}
          onRename={props.onRenameDocument}
          onClose={props.onCloseDocument}
        />
      )}

      <section
        data-area={area}
        data-workbench-pane
        data-edge-to-edge={
          area === "workspace" &&
          activeDocument !== null &&
          activeDocument.kind !== "welcome"
        }
        className="scrollbar-sleek tw:min-h-0 tw:flex-1 tw:overflow-auto tw:bg-background tw:p-[var(--ds-pane-pad)] tw:shadow-[inset_0_var(--ds-border-width)_0_var(--ds-border-subtle)] tw:data-[edge-to-edge=true]:overflow-hidden tw:data-[edge-to-edge=true]:p-0 tw:max-[760px]:p-3 tw:max-[760px]:data-[edge-to-edge=true]:p-0"
      >
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
          <WorkbenchEmptyState icon={supportsSql ? "play" : "list"}>
            <span>
              {supportsSql ? t("tabs.sql") : t("tabs.documents")}
            </span>
            <button className="btn primary" onClick={props.onNewQuery}>
              <Icon name="plus" />
              {supportsSql ? t("tabs.sql") : t("tabs.documents")}
            </button>
          </WorkbenchEmptyState>
        ) : activeDocument.kind === "welcome" ? (
          <Onboarding
            embedded
            connectionName={selected.name || selected.database}
          />
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
          <SchemaExplorer
            key={activeDocument.id}
            connection={selected}
            selectedTable={null}
            onOpenTable={props.onOpenTable}
          />
        ) : activeDocument.kind === "sql" ? (
          <Sql
            key={activeDocument.id}
            connection={selected}
            documentId={activeDocument.id}
            safety={safety ?? BLOCKED_SAFETY_SETTINGS}
            safetyReady={safety !== null}
            safetyLoadError={safetyError}
            draft={activeDocument.draft}
            title={activeDocument.title}
            setTitle={props.onSetQueryTitle}
            selectedDatabase={activeDocument.selectedDatabase}
            setSelectedDatabase={props.onSetQueryDatabase}
            selectedSchema={activeDocument.selectedSchema}
            setSelectedSchema={props.onSetQuerySchema}
            resolveMode={activeDocument.resolveMode}
            setResolveMode={props.onSetQueryResolveMode}
            persistedId={activeDocument.persistedId}
            revision={activeDocument.revision}
            recovered={activeDocument.recovered}
            onPersisted={props.onPersistedQuery}
            onQueryServiceSessionChange={props.onQueryServiceSessionChange}
            onShowQueryServices={props.onShowQueryServices}
            onOpenHistory={props.onOpenActivity}
            onRetrySafety={props.onRetrySafety}
          />
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
      {settingsDialog}
    </>
  );
}
