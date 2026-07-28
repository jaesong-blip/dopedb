// Desktop workbench shell: coordinates the selected connection, document surface,
// workspace navigation, and the persistent connection-pinned Terminal Dock.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CatalogOverview, CatalogTable } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import SearchEverywhere from "../../features/actionSearch/SearchEverywhere";
import type { SearchEverywhereItem } from "../../features/actionSearch/domain";
import {
  createDemoSqlite,
  upsertConnection,
} from "../../features/connections/tauriAdapter";
import {
  demoSqliteConnection,
  type ConnectionLaunchPreset,
} from "../../features/connections/presets";
import type { Dashboard } from "../../features/dashboards/domain";
import { useQueryServices } from "../../features/queryServices/useQueryServices";
import type { SqlDocument } from "../../features/sqlDocuments/domain";
import { tauriSqlDocumentGateway } from "../../features/sqlDocuments/tauriAdapter";
import {
  queryDocument,
  stableDocument,
  tableDocument,
  type WorkbenchDocument,
} from "../../features/workbench/domain";
import { useWorkbenchDocuments } from "../../features/workbench/useWorkbenchDocuments";
import { ToastProvider, useToast } from "../../components/Toast";
import { hasCapability, isDocumentEngine } from "../../lib/capabilities";
import { useI18n } from "../../lib/i18n";
import {
  OperationActivityProvider,
  useOperationActivity,
} from "../../lib/operationActivity";
import {
  catalogOverviewQuery,
  catalogQuery,
  driversQuery,
  qk,
  skillStatusQuery,
  useCatalogScope,
} from "../../lib/queries";
import { filterCatalogOverview } from "../catalogExplorer/scopeFilter";
import { buildConnectionSections } from "../../lib/schemaDiff";
import type { SettingsSection } from "../../screens/Settings";
import ShellLayout from "./ShellLayout";
import WorkbenchContent, {
  type EditingConnection,
} from "./WorkbenchContent";
import type { AppArea } from "./WorkbenchRail";
import { useAvailableUpdate } from "./useAvailableUpdate";
import { useConnectionProfiles } from "./useConnectionProfiles";
import { useOperationNudge } from "./useOperationNudge";
import { useResponsiveShell } from "./useResponsiveShell";
import { useSafetySettings } from "./useSafetySettings";
import { useSidebarWidth } from "./useSidebarWidth";
import { useTerminalDock } from "./useTerminalDock";
import { useToolWindowLayout } from "./useToolWindowLayout";
import {
  preloadSqlEditor,
  useActivitySeen,
  useDashboardCreation,
  usePersistentAppArea,
  usePersistentSelectedConnection,
  useRestoredWorkbenchState,
  useSqlEditorPreload,
} from "./navigationHooks";

// DopeDB-style information architecture:
// - the title toolbar opens real workbench areas and tool windows;
// - database tools are documents inside the selected connection's workbench;
// - interactive Shell/Agent sessions live in a connection-pinned tool window.
// `null` = not editing; "new" = blank form; a profile = edit that profile.
export default function App() {
  return (
    <ToastProvider>
      <OperationActivityProvider>
        <Shell />
      </OperationActivityProvider>
    </ToastProvider>
  );
}


function Shell() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const catalogScope = useCatalogScope();
  const { unseen, latest, markSeen } = useOperationActivity();
  const toast = useToast();
  // Keep one bounded Skill inventory observer alive for the app lifecycle. This performs
  // the required startup scan and rechecks after focus without creating install roots.
  const skillStatusQ = useQuery(skillStatusQuery());
  const {
    connections: conns,
    setConnections: setConns,
    loadError,
    refresh,
    clear: clearConnections,
  } = useConnectionProfiles();
  const {
    databaseExplorerOpen,
    localHistoryOpen,
    servicesOpen,
    servicesHeight,
    showDatabaseExplorer,
    toggleDatabaseExplorer,
    showLocalHistory,
    closeLocalHistory,
    toggleLocalHistory,
    showServices,
    closeServices,
    toggleServices,
    startServicesResize,
    resetServicesHeight,
  } = useToolWindowLayout();
  const {
    width: sidebarW,
    startDrag: startSidebarDrag,
    reset: resetSidebarWidth,
  } = useSidebarWidth(
    localHistoryOpen ? "localHistory" : "databaseExplorer",
  );
  const queryServices = useQueryServices();
  const [selectedId, setSelectedId] = usePersistentSelectedConnection();
  const {
    safety,
    error: safetyError,
    refresh: refreshSafety,
    clear: clearSafety,
  } = useSafetySettings(selectedId);
  const [editing, setEditing] = useState<EditingConnection>(null);
  const [connectionPreset, setConnectionPreset] =
    useState<ConnectionLaunchPreset | null>(null);
  const [creatingDemo, setCreatingDemo] = useState(false);
  const [searchEverywhereOpen, setSearchEverywhereOpen] =
    useState(false);
  const lastShiftAtRef = useRef(0);
  const { legacyAuditOpen, restoredDocumentKind } = useRestoredWorkbenchState();
  const [area, setArea] = usePersistentAppArea();
  const {
    open: terminalDockOpen,
    width: terminalDockWidth,
    buttonRef: terminalButtonRef,
    show: openTerminalDock,
    close: closeTerminalDock,
    resize: updateTerminalDockWidth,
  } = useTerminalDock();
  const {
    terminalOverlay,
    compact: compactShell,
    mobileExplorerOpen,
    setMobileExplorerOpen,
    mainRef,
    dismissMobileExplorer,
    focusMainAfterMobileSelection,
  } = useResponsiveShell();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    SettingsSection | undefined
  >(undefined);
  const [schemaDiffGroupKey, setSchemaDiffGroupKey] = useState<string | null>(null);
  const { availableUpdate, sync: syncAvailableUpdate } = useAvailableUpdate();
  const openDashboard = useCallback((dashboard: Dashboard) => {
    setSelectedId(dashboard.connectionId);
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setArea("dashboard");
  }, []);
  const {
    focusId: dashboardFocusId,
    setFocusId: setDashboardFocusId,
    consumeFocus: consumeDashboardFocus,
  } = useDashboardCreation(openDashboard);

  const selected = conns.find((c) => c.id === selectedId) ?? null;
  const searchCatalogQueries = useQueries({
    queries: conns.map((connection) => ({
      ...catalogOverviewQuery(connection.id, catalogScope),
      enabled: searchEverywhereOpen && catalogScope.ready,
      select: (overview: CatalogOverview) =>
        filterCatalogOverview(connection, overview),
    })),
  });
  const showTerminalDock =
    terminalDockOpen && !!selected && !settingsOpen && editing === null;
  // Schema diff is a SQL-only comparison feature — a group whose connections are MongoDB
  // is never a valid diff candidate, even if one somehow carries a schemaGroup value.
  const schemaGroups = useMemo(
    () =>
      buildConnectionSections(conns).flatMap((section) =>
        section.kind === "group" && !isDocumentEngine(section.group.connections[0]?.engine)
          ? [section.group]
          : [],
      ),
    [conns],
  );
  const activeSchemaGroup =
    schemaGroups.find((group) => group.key === schemaDiffGroupKey) ?? null;

  // SQL and Documents are mutually exclusive per connection, gated by the resolved
  // driver capability. Engine fallback avoids a SQL/Documents flash while drivers load.
  const driversQ = useQuery(driversQuery());
  const supportsSql =
    !selected ||
    (driversQ.data
      ? hasCapability(driversQ.data, selected, "sql")
      : !isDocumentEngine(selected.engine));
  const workbench = useWorkbenchDocuments({
    selectedConnectionId: selected?.id ?? null,
    supportsSql,
    restoredDocumentKind,
    sqlDocuments: tauriSqlDocumentGateway,
    onRestoreError: (error) => {
      console.error("could not restore SQL documents:", error);
    },
  });
  const {
    selectedDocuments,
    activeDocument,
    activeDocumentId,
  } = workbench;
  const selectedTable = activeDocument?.kind === "data" ? activeDocument.table : null;

  useSqlEditorPreload(selected?.id ?? null, supportsSql);

  useEffect(() => {
    const openOnDoubleShift = (event: KeyboardEvent) => {
      if (event.key !== "Shift" || event.repeat) return;
      const now = performance.now();
      if (now - lastShiftAtRef.current < 500) {
        event.preventDefault();
        lastShiftAtRef.current = 0;
        setSearchEverywhereOpen(true);
      } else {
        lastShiftAtRef.current = now;
      }
    };
    window.addEventListener("keydown", openOnDoubleShift);
    return () =>
      window.removeEventListener("keydown", openOnDoubleShift);
  }, []);

  useEffect(() => {
    if (schemaDiffGroupKey && !activeSchemaGroup) setSchemaDiffGroupKey(null);
  }, [activeSchemaGroup, schemaDiffGroupKey]);

  async function reloadWorkspaceScope() {
    setSelectedId(null);
    workbench.reset();
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setDashboardFocusId(null);
    clearSafety();
    clearConnections();
    await refresh();
  }

  const notifyOperation = useCallback(
    () => toast(t("app.toastAgentQuery")),
    [t, toast],
  );
  useOperationNudge(latest?.id ?? null, showTerminalDock, notifyOperation);

  useActivitySeen(activeDocument?.kind ?? null, unseen, markSeen);

  async function loadSql(sql: string) {
    if (!selected) return;
    let document: WorkbenchDocument;
    try {
      document = await workbench.openQuery({
        connectionId: selected.id,
        supportsSql,
        title: "History query",
        content: sql,
      });
    } catch (error) {
      toast(errMessage(error), "error");
      return;
    }
    workbench.activate(document);
    setArea("workspace");
  }

  function openAgentArchiveSettings() {
    setSettingsSection("archive");
    setSettingsOpen(true);
    setSchemaDiffGroupKey(null);
    setEditing(null);
  }

  function openUpdateSettings() {
    setSettingsSection("updates");
    setSettingsOpen(true);
    setSchemaDiffGroupKey(null);
    setEditing(null);
  }

  function openOrFocusTerminalDock() {
    if (!selected) return;
    if (showTerminalDock) {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-terminal-focus-target="active-session"], [data-terminal-focus-target="launcher"]',
          )
          ?.focus();
      });
      return;
    }
    setSettingsOpen(false);
    setEditing(null);
    setSchemaDiffGroupKey(null);
    setMobileExplorerOpen(false);
    openTerminalDock();
  }

  function selectConnection(id: string, nextArea: AppArea = area) {
    const connection = conns.find((candidate) => candidate.id === id);
    const initial = connection && isDocumentEngine(connection.engine)
      ? queryDocument(id, "documents")
      : stableDocument(id, "schema");
    workbench.prime(initial);
    setSelectedId(id);
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setDashboardFocusId(null);
    setMobileExplorerOpen(false);
    setArea(nextArea);
    focusMainAfterMobileSelection();
  }

  function activateDocument(
    document: WorkbenchDocument,
    closeMobileExplorer = true,
  ) {
    workbench.activate(document);
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    if (closeMobileExplorer) {
      setMobileExplorerOpen(false);
      if (mobileExplorerOpen) focusMainAfterMobileSelection();
    }
    setArea("workspace");
  }

  function openTableDocument(connection: ConnectionProfile, table: CatalogTable) {
    const document = tableDocument(connection.id, table);
    if (selectedId !== connection.id) {
      workbench.prime(document);
      setSelectedId(connection.id);
    }
    activateDocument(document);
  }

  function openStableDocument(
    kind: "schema" | "activity",
    closeMobileExplorer = true,
  ) {
    if (!selected) return;
    activateDocument(stableDocument(selected.id, kind), closeMobileExplorer);
  }

  async function openQueryDocument() {
    if (!selected) return;
    preloadSqlEditor();
    try {
      const document = await workbench.openQuery({
        connectionId: selected.id,
        supportsSql,
      });
      activateDocument(document);
    } catch (error) {
      toast(errMessage(error), "error");
    }
  }

  function closeDocument(id: string) {
    if (!selected) return;
    workbench.close(id, selected.id, supportsSql);
  }

  function setActiveQueryDraft(value: string) {
    if (!activeDocument || (activeDocument.kind !== "sql" && activeDocument.kind !== "documents")) {
      return;
    }
    workbench.updateDraft(activeDocument.id, value);
  }

  function setActiveQueryTitle(value: string) {
    if (!activeDocument || activeDocument.kind !== "sql") return;
    workbench.updateTitle(activeDocument.id, value);
  }

  function applySavedQuery(saved: SqlDocument) {
    if (!activeDocument || activeDocument.kind !== "sql") return;
    workbench.applyPersisted(activeDocument.id, saved);
  }

  function startNewConnection(preset?: ConnectionLaunchPreset) {
    setConnectionPreset(preset ?? null);
    setEditing("new");
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setMobileExplorerOpen(false);
    focusMainAfterMobileSelection();
  }

  async function createDemoDatabase() {
    if (creatingDemo) return;
    setCreatingDemo(true);
    try {
      const path = await createDemoSqlite();
      const existing = conns.find(
        (connection) =>
          connection.engine === "sqlite" &&
          connection.database === path,
      );
      const saved =
        existing ??
        (await upsertConnection(demoSqliteConnection(path)));
      if (!existing) await refresh();
      setSelectedId(saved.id);
      setConnectionPreset(null);
      setEditing(null);
      setSettingsOpen(false);
      setSchemaDiffGroupKey(null);
      setArea("workspace");
      toast(t("connections.demoCreated"));
    } catch (error) {
      toast(errMessage(error), "error");
    } finally {
      setCreatingDemo(false);
    }
  }

  const searchEverywhereItems = useMemo<
    readonly SearchEverywhereItem[]
  >(() => {
    const actions: SearchEverywhereItem[] = [
      {
        id: "action:new-data-source",
        kind: "action",
        label: t("connections.new"),
        keywords: ["database", "connection", "source", "연결"],
        run: () => startNewConnection(),
      },
      {
        id: "action:new-query",
        kind: "action",
        label: t("ide.action.newQuery"),
        keywords: ["sql", "console", "query", "쿼리"],
        shortcut: "⌘N",
        disabled: !selected || !supportsSql,
        run: openQueryDocument,
      },
      {
        id: "action:database-explorer",
        kind: "action",
        label: t("ide.action.databaseExplorer"),
        keywords: ["tool window", "schema", "tables", "탐색기"],
        run: toggleDatabaseExplorer,
      },
      {
        id: "action:local-history",
        kind: "action",
        label: t("localHistory.title"),
        keywords: ["tool window", "revision", "restore", "history", "기록"],
        disabled: !selected || !supportsSql,
        run: showLocalHistory,
      },
      {
        id: "action:services",
        kind: "action",
        label: t("services.title"),
        keywords: ["tool window", "output", "result", "session"],
        run: toggleServices,
      },
      {
        id: "action:dashboards",
        kind: "action",
        label: t("tabs.dashboard"),
        keywords: ["chart", "visualization", "대시보드"],
        run: () => {
          setSettingsOpen(false);
          setEditing(null);
          setSchemaDiffGroupKey(null);
          setArea("dashboard");
          if (!compactShell) showDatabaseExplorer();
        },
      },
      {
        id: "action:ai-chat",
        kind: "action",
        label: t("terminal.agentTitle"),
        keywords: ["codex", "claude", "agent", "terminal"],
        disabled: !selected,
        run: openOrFocusTerminalDock,
      },
      {
        id: "action:settings",
        kind: "action",
        label: t("common.settings"),
        keywords: ["preferences", "설정"],
        shortcut: "⌘,",
        run: () => {
          setSettingsSection(undefined);
          setSettingsOpen(true);
          setSchemaDiffGroupKey(null);
          setMobileExplorerOpen(false);
        },
      },
    ];

    const connections: SearchEverywhereItem[] = conns.map(
      (connection) => ({
        id: `connection:${connection.id}`,
        kind: "connection",
        label: connection.name || t("app.unnamed"),
        detail: [
          connection.engine,
          connection.host,
          connection.database,
        ]
          .filter(Boolean)
          .join(" · "),
        keywords: [
          connection.provider,
          connection.env ?? "",
          connection.username,
        ],
        run: () => selectConnection(connection.id, "workspace"),
      }),
    );

    const documents: SearchEverywhereItem[] =
      selectedDocuments.map((document) => {
        const label =
          document.kind === "sql"
            ? document.title
            : document.kind === "data"
              ? [
                  document.table.schema,
                  document.table.name,
                ]
                  .filter(Boolean)
                  .join(".")
              : document.kind === "schema"
                ? t("tabs.schema")
                : document.kind === "activity"
                  ? t("tabs.activity")
                  : t("tabs.documents");
        return {
          id: `document:${document.id}`,
          kind: "document",
          label,
          detail:
            selected?.name || selected?.database || t("app.unnamed"),
          keywords: [document.kind],
          run: () => activateDocument(document),
        };
      });

    const databaseObjects: SearchEverywhereItem[] =
      searchCatalogQueries.flatMap((query, queryIndex) => {
        const connection = conns[queryIndex];
        if (!connection || !query.data) return [];
        return query.data.relations.map((relation) => ({
          id: `object:${connection.id}:${relation.schema ?? ""}:${relation.name}:${relation.kind}`,
          kind: "databaseObject" as const,
          label: [relation.schema, relation.name]
            .filter(Boolean)
            .join("."),
          detail: [
            connection.name || connection.database,
            relation.kind,
          ]
            .filter(Boolean)
            .join(" · "),
          keywords: [
            connection.engine,
            connection.database,
            relation.comment ?? "",
          ],
          run: async () => {
            try {
              const catalog = await queryClient.fetchQuery(
                catalogQuery(connection.id, catalogScope),
              );
              const table = catalog.tables.find(
                (candidate) =>
                  candidate.name === relation.name &&
                  candidate.schema === relation.schema &&
                  candidate.kind === relation.kind,
              );
              if (table) {
                openTableDocument(connection, table);
              } else {
                selectConnection(connection.id, "workspace");
              }
            } catch (error) {
              toast(errMessage(error), "error");
            }
          },
        }));
      });

    const settings: SearchEverywhereItem[] = (
      [
        ["agent-tools", t("settings.agentTools"), false],
        ["cli", t("settings.cli"), false],
        ["archive", t("settings.retiredArchive"), false],
        ["safety", t("settings.safety"), !selected],
        ["language", t("settings.languageTitle"), false],
        ["updates", t("settings.updates"), false],
      ] satisfies ReadonlyArray<
        readonly [SettingsSection, string, boolean]
      >
    ).map(([section, label, disabled]) => ({
      id: `setting:${section}`,
      kind: "setting",
      label,
      detail: t("common.settings"),
      disabled,
      keywords: [section],
      run: () => {
        setSettingsSection(section);
        setSettingsOpen(true);
        setSchemaDiffGroupKey(null);
        setEditing(null);
        setMobileExplorerOpen(false);
      },
    }));

    return [
      ...actions,
      ...connections,
      ...documents,
      ...databaseObjects,
      ...settings,
    ];
  }, [
    catalogScope,
    compactShell,
    conns,
    queryClient,
    searchCatalogQueries,
    selected,
    selectedDocuments,
    showDatabaseExplorer,
    showLocalHistory,
    supportsSql,
    t,
    toast,
    toggleDatabaseExplorer,
    toggleServices,
  ]);
  const searchObjectsLoading =
    searchEverywhereOpen &&
    searchCatalogQueries.some(
      (query) => query.isPending || query.isFetching,
    );

  async function handleDeletedConnection(id: string) {
    await refresh();
    if (selectedId === id) {
      setSelectedId(null);
      workbench.reset();
    }
    if (schemaDiffGroupKey) setSchemaDiffGroupKey(null);
    setEditing((current) => {
      if (current && current !== "new" && current.id === id) {
        return null;
      }
      return current;
    });
  }

  const mainContent = (
    <WorkbenchContent
      settingsOpen={settingsOpen}
      settingsSection={settingsSection}
      selected={selected}
      activeSchemaGroup={activeSchemaGroup}
      editing={editing}
      connectionPreset={connectionPreset}
      loadError={loadError}
      connections={conns}
      safety={safety}
      safetyError={safetyError}
      area={area}
      selectedDocuments={selectedDocuments}
      activeDocument={activeDocument}
      activeDocumentId={activeDocumentId}
      supportsSql={supportsSql}
      dashboardFocusId={dashboardFocusId}
      initialAuditOpen={legacyAuditOpen.current}
      availableUpdate={availableUpdate}
      creatingDemo={creatingDemo}
      onCreateDemoDatabase={() => void createDemoDatabase()}
      onCloseSettings={() => setSettingsOpen(false)}
      onUpdateChecked={syncAvailableUpdate}
      onRefreshSafety={refreshSafety}
      onCloseSchemaDiff={() => setSchemaDiffGroupKey(null)}
      onConnectionSaved={async (profile, closeEditor) => {
        await refresh();
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: qk.catalog(profile.id),
          }),
          queryClient.invalidateQueries({
            queryKey: qk.catalogOverview(profile.id),
          }),
          queryClient.invalidateQueries({
            queryKey: qk.catalogSnapshot(profile.id),
          }),
        ]);
        setSelectedId(profile.id);
        if (closeEditor) {
          setConnectionPreset(null);
          setEditing(null);
        }
      }}
      onCancelEditing={() => {
        setConnectionPreset(null);
        setEditing(null);
      }}
      onRetryConnections={() => void refresh()}
      onNewConnection={startNewConnection}
      onEditConnection={(connection) => {
        setConnectionPreset(null);
        setEditing(connection);
        setSettingsOpen(false);
        setSchemaDiffGroupKey(null);
      }}
      onDeletedConnection={handleDeletedConnection}
      onSelectConnection={(id) => selectConnection(id, area)}
      onActivateDocument={workbench.activateId}
      onRenameDocument={workbench.updateTitle}
      onCloseDocument={closeDocument}
      onNewQuery={() => void openQueryDocument()}
      onOpenActivity={() => openStableDocument("activity")}
      onDashboardFocusConsumed={consumeDashboardFocus}
      onOpenTerminal={openOrFocusTerminalDock}
      onSetQueryDraft={setActiveQueryDraft}
      onSetQueryTitle={setActiveQueryTitle}
      onPersistedQuery={applySavedQuery}
      onQueryServiceSessionChange={queryServices.updateSession}
      onShowQueryServices={(sessionId) => {
        queryServices.activateNewestSession(sessionId);
        showServices();
      }}
      onOpenTable={(table) => selected && openTableDocument(selected, table)}
      onLoadSql={loadSql}
      onInitialAuditOpenConsumed={() => {
        legacyAuditOpen.current = false;
      }}
      onRetrySafety={refreshSafety}
    />
  );

  return (
    <>
      <ShellLayout
      area={area}
      settingsOpen={settingsOpen}
      editing={editing}
      activeSchemaGroup={activeSchemaGroup}
      activeSchemaGroupKey={schemaDiffGroupKey}
      connections={conns}
      selected={selected}
      selectedId={selectedId}
      selectedTable={selectedTable}
      supportsSql={supportsSql}
      dashboardFocusId={dashboardFocusId}
      compact={compactShell}
      mobileExplorerOpen={mobileExplorerOpen}
      databaseExplorerOpen={databaseExplorerOpen}
      localHistoryOpen={localHistoryOpen}
      servicesOpen={servicesOpen}
      servicesHeight={servicesHeight}
      queryServiceSessions={queryServices.sessions}
      activeQueryServiceSessionId={queryServices.activeSessionId}
      workbenchDocuments={selectedDocuments}
      activeWorkbenchDocumentId={activeDocumentId}
      sidebarWidth={sidebarW}
      mainRef={mainRef}
      terminalButtonRef={terminalButtonRef}
      mainContent={mainContent}
      availableUpdate={availableUpdate}
      showTerminalDock={showTerminalDock}
      searchEverywhereOpen={searchEverywhereOpen}
      terminalOverlay={terminalOverlay}
      terminalWidth={terminalDockWidth}
      skillStatus={skillStatusQ.data ?? null}
      creatingDemo={creatingDemo}
      onWorkspaceScopeChanged={reloadWorkspaceScope}
      onNewConnection={startNewConnection}
      onCreateDemoDatabase={() => void createDemoDatabase()}
      onArea={(next) => {
        const sameArea = next === area && !settingsOpen;
        setSettingsOpen(false);
        setEditing(null);
        setSchemaDiffGroupKey(null);
        setArea(next);
        if (!compactShell) showDatabaseExplorer();
        if (next === "workspace" && selected) {
          openStableDocument("schema", false);
        }
        if (compactShell) {
          if (sameArea && mobileExplorerOpen) dismissMobileExplorer();
          else setMobileExplorerOpen(true);
        }
      }}
      onToggleDatabaseExplorer={toggleDatabaseExplorer}
      onToggleLocalHistory={toggleLocalHistory}
      onCloseLocalHistory={closeLocalHistory}
      onToggleServices={toggleServices}
      onCloseServices={closeServices}
      onActivateQueryServiceSession={queryServices.activateSession}
      onActivateWorkbenchDocument={workbench.activateId}
      onRestoreWorkbenchDocument={workbench.updateDraft}
      onStartServicesResize={startServicesResize}
      onResetServicesHeight={resetServicesHeight}
      onSettings={() => {
        setSettingsSection(undefined);
        setSettingsOpen(true);
        setSchemaDiffGroupKey(null);
        setMobileExplorerOpen(false);
      }}
      onNewQuery={() => void openQueryDocument()}
      onOpenAgentArchive={openAgentArchiveSettings}
      onOpenTerminal={openOrFocusTerminalDock}
      onSearchEverywhere={() => setSearchEverywhereOpen(true)}
      onSelectDashboardConnection={(id) => selectConnection(id, "dashboard")}
      onDashboardFocus={setDashboardFocusId}
      onSelectWorkspaceConnection={(id) => selectConnection(id, "workspace")}
      onOpenTable={openTableDocument}
      onOpenSchemaDiff={(group) => {
        setArea("workspace");
        setEditing(null);
        setSettingsOpen(false);
        setSchemaDiffGroupKey(group.key);
      }}
      onEditConnection={(connection) => {
        setConnectionPreset(null);
        setEditing(connection);
        setSettingsOpen(false);
        setSchemaDiffGroupKey(null);
      }}
      onDeletedConnection={handleDeletedConnection}
      onConnectionUpdated={(updated) => {
        setConns((current) =>
          current.map((connection) =>
            connection.id === updated.id ? updated : connection,
          ),
        );
        setEditing((current) => {
          if (current && current !== "new" && current.id === updated.id) {
            return updated;
          }
          return current;
        });
      }}
      onDismissMobileExplorer={() => dismissMobileExplorer(true)}
      onStartSidebarDrag={startSidebarDrag}
      onResetSidebar={resetSidebarWidth}
      onOpenUpdateSettings={openUpdateSettings}
      onTerminalWidthChange={updateTerminalDockWidth}
      onCloseTerminal={closeTerminalDock}
      />
      {searchEverywhereOpen ? (
        <SearchEverywhere
          items={searchEverywhereItems}
          loadingObjects={searchObjectsLoading}
          onClose={() => setSearchEverywhereOpen(false)}
        />
      ) : null}
    </>
  );
}
