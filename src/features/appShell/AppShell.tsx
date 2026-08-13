// Desktop workbench shell: coordinates the selected connection, document surface,
// workspace navigation, and the persistent connection-pinned Agent panel.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CatalogTable } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import type { BackgroundTask } from "../../features/backgroundTasks/domain";
import type { AgentComposerRequest } from "../../features/agents/domain";
import { useBackgroundTasks } from "../../features/backgroundTasks/useBackgroundTasks";
import type { ConnectionProfile } from "../../features/connections/domain";
import SearchEverywhere, {
  type SearchEverywhereCloseReason,
} from "../../features/actionSearch/SearchEverywhere";
import type { SearchEverywhereItem } from "../../features/actionSearch/domain";
import { useCachedCatalogOverviews } from "../../features/actionSearch/catalogCache";
import {
  createDemoSqlite,
  upsertConnection,
} from "../../features/connections/tauriAdapter";
import {
  demoSqliteConnection,
  type ConnectionLaunchPreset,
} from "../../features/connections/presets";
import type {
  KnowledgeEnvironmentFocus,
  KnowledgeEnvironmentView,
} from "../../features/knowledge/domain";
import { connectionCanEnterWritePath } from "../../features/safetySettings/policy";
import { recordStartupMark } from "../../features/runtime/tauriAdapter";
import { useQueryServices } from "../../features/queryServices/useQueryServices";
import SkillStartupGate from "../../features/skills/SkillStartupGate";
import type { SqlDocument } from "../../features/sqlDocuments/domain";
import { tauriSqlDocumentGateway } from "../../features/sqlDocuments/tauriAdapter";
import type { SqlResolveMode } from "../../features/queries/resolveMode";
import {
  useWorkspaceManualTransactions,
  type WorkspaceManualTransaction,
} from "../../features/queries/useWorkspaceManualTransactions";
import {
  queryDocument,
  stableDocument,
  tableDocument,
  type WorkbenchDocument,
} from "../../features/workbench/domain";
import { useWorkbenchDocuments } from "../../features/workbench/useWorkbenchDocuments";
import { publishWorkbenchDraft } from "../../features/workbench/draftStore";
import { ToastProvider, useToast } from "../../components/Toast";
import { hasCapability, isDocumentEngine } from "../../lib/capabilities";
import { useI18n } from "../../lib/i18n";
import { resetConnectionResourceQueries } from "../../lib/queryClient";
import { usePostPaintReady } from "../../lib/usePostPaintReady";
import {
  OperationActivityProvider,
  useOperationActivity,
} from "../../lib/operationActivity";
import {
  databaseCatalogQuery,
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
import { useAvailableUpdate } from "./useAvailableUpdate";
import {
  changedConnectionRuntimeIds,
  useConnectionProfiles,
} from "./useConnectionProfiles";
import { useOperationNudge } from "./useOperationNudge";
import { useResponsiveShell } from "./useResponsiveShell";
import { useSafetySettings } from "./useSafetySettings";
import { useSidebarWidth } from "./useSidebarWidth";
import { useAgentDock } from "./useAgentDock";
import { useToolWindowLayout } from "./useToolWindowLayout";
import {
  preloadSqlEditor,
  useActivitySeen,
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
  const reportQueryServicesPersistenceError = useCallback(
    (error: unknown) => toast(errMessage(error), "error"),
    [toast],
  );
  const postPaintReady = usePostPaintReady();
  // Keep one bounded Skill inventory observer alive after the first visible frame.
  // Focus rechecks remain owned by TanStack Query without scanning while hidden.
  useQuery(skillStatusQuery(postPaintReady));
  const {
    connections: conns,
    setConnections: setConns,
    loaded: connectionsLoaded,
    loadError,
    refresh,
  } = useConnectionProfiles(catalogScope.key);
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
  const queryServices = useQueryServices(
    catalogScope,
    reportQueryServicesPersistenceError,
  );
  const backgroundTasks = useBackgroundTasks({
    connections: conns,
    queryServiceStore: queryServices.store,
    workspaceScopeKey: catalogScope.key,
  });
  const manualTransactions = useWorkspaceManualTransactions(conns);
  const [selectedId, setSelectedId] = usePersistentSelectedConnection();
  const selectionRestoreMarked = useRef(false);
  const {
    safety,
    error: safetyError,
    refresh: refreshSafety,
    accept: acceptSafety,
    clear: clearSafety,
  } = useSafetySettings(selectedId);
  const [editing, setEditing] = useState<EditingConnection>(null);
  const [connectionPreset, setConnectionPreset] =
    useState<ConnectionLaunchPreset | null>(null);
  const [creatingDemo, setCreatingDemo] = useState(false);
  const [searchEverywhereOpen, setSearchEverywhereOpen] =
    useState(false);
  const searchEverywhereButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchEverywhereReturnFocusRef = useRef<HTMLElement | null>(null);
  const restoreSearchEverywhereFocusRef = useRef(false);
  const lastShiftAtRef = useRef(0);
  const { legacyAuditOpen, restoredDocumentKind } = useRestoredWorkbenchState();
  const [knowledgeEnvironmentFocus, setKnowledgeEnvironmentFocus] =
    useState<KnowledgeEnvironmentFocus | null>(null);
  const [agentComposerRequest, setAgentComposerRequest] =
    useState<AgentComposerRequest | null>(null);
  const {
    open: agentDockOpen,
    width: agentDockWidth,
    buttonRef: agentButtonRef,
    show: openAgentDock,
    close: closeAgentDock,
    resize: updateAgentDockWidth,
  } = useAgentDock();
  const {
    agentOverlay,
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

  const openSearchEverywhere = useCallback(
    (returnFocus?: HTMLElement | null) => {
      const activeElement = document.activeElement;
      searchEverywhereReturnFocusRef.current =
        returnFocus ??
        (activeElement instanceof HTMLElement &&
        activeElement !== document.body &&
        activeElement !== document.documentElement
          ? activeElement
          : searchEverywhereButtonRef.current);
      setSearchEverywhereOpen(true);
    },
    [],
  );
  const closeSearchEverywhere = useCallback(
    (reason: SearchEverywhereCloseReason) => {
      restoreSearchEverywhereFocusRef.current = reason === "dismiss";
      setSearchEverywhereOpen(false);
    },
    [],
  );
  const [explorerRevealRequest, setExplorerRevealRequest] = useState(0);
  const [schemaDiffGroupKey, setSchemaDiffGroupKey] = useState<string | null>(null);
  const { availableUpdate, sync: syncAvailableUpdate } = useAvailableUpdate();
  const selected = conns.find((c) => c.id === selectedId) ?? null;
  useEffect(() => {
    if (!connectionsLoaded || selectionRestoreMarked.current) return;
    selectionRestoreMarked.current = true;
    void recordStartupMark(
      "selected_connection_restored",
      loadError === null,
    ).catch(() => undefined);
  }, [connectionsLoaded, loadError]);
  const searchCatalogTargets = useCachedCatalogOverviews(
    queryClient,
    conns,
    catalogScope.key,
    searchEverywhereOpen && catalogScope.ready,
  );
  const showAgentDock =
    agentDockOpen && !!selected && editing === null;
  useEffect(() => {
    if (compactShell && showAgentDock && servicesOpen) closeServices();
  }, [closeServices, compactShell, servicesOpen, showAgentDock]);
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
    selectedConnectionDatabase: selected?.database ?? null,
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
    if (
      searchEverywhereOpen ||
      !restoreSearchEverywhereFocusRef.current
    ) {
      return;
    }
    restoreSearchEverywhereFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const focusTarget =
        searchEverywhereReturnFocusRef.current?.isConnected
          ? searchEverywhereReturnFocusRef.current
          : searchEverywhereButtonRef.current;
      searchEverywhereReturnFocusRef.current = null;
      focusTarget?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchEverywhereOpen]);

  useEffect(() => {
    const openOnDoubleShift = (event: KeyboardEvent) => {
      if (event.key !== "Shift" || event.repeat) return;
      const now = performance.now();
      if (now - lastShiftAtRef.current < 500) {
        event.preventDefault();
        lastShiftAtRef.current = 0;
        openSearchEverywhere();
      } else {
        lastShiftAtRef.current = now;
      }
    };
    window.addEventListener("keydown", openOnDoubleShift);
    return () =>
      window.removeEventListener("keydown", openOnDoubleShift);
  }, [openSearchEverywhere]);

  useEffect(() => {
    if (schemaDiffGroupKey && !activeSchemaGroup) setSchemaDiffGroupKey(null);
  }, [activeSchemaGroup, schemaDiffGroupKey]);

  async function reloadWorkspaceScope() {
    setSelectedId(null);
    workbench.reset();
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setKnowledgeEnvironmentFocus(null);
    clearSafety();
    // The workspace/account owner already removed the previous query generation.
    // Let the observer for the new catalogScope key perform its own read; calling
    // this render's refresh closure here would cache the new backend workspace
    // under the previous account key during the transition.
  }

  async function refreshWorkspaceData() {
    const previous = conns;
    const next = await refresh();
    if (!next) return;
    const changedIds = changedConnectionRuntimeIds(previous, next);
    await resetConnectionResourceQueries(queryClient, changedIds);
  }

  const notifyOperation = useCallback(
    () => toast(t("app.toastAgentQuery")),
    [t, toast],
  );
  useOperationNudge(latest?.id ?? null, showAgentDock, notifyOperation);

  useActivitySeen(activeDocument?.kind ?? null, unseen, markSeen);

  async function loadSql(sql: string) {
    if (!selected) return;
    let document: WorkbenchDocument;
    try {
      document = await workbench.openQuery({
        connectionId: selected.id,
        database: selected.database,
        supportsSql,
        title: "History query",
        content: sql,
      });
    } catch (error) {
      toast(errMessage(error), "error");
      return;
    }
    workbench.activate(document);
    setKnowledgeEnvironmentFocus(null);
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

  function openOrFocusAgentDock() {
    if (!selected) return;
    setAgentComposerRequest(null);
    if (compactShell) {
      closeServices();
      setMobileExplorerOpen(false);
    }
    if (showAgentDock) {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-agent-focus-target="active-session"], [data-agent-focus-target="launcher"]',
          )
          ?.focus();
      });
      return;
    }
    setSettingsOpen(false);
    setEditing(null);
    setSchemaDiffGroupKey(null);
    setMobileExplorerOpen(false);
    openAgentDock();
  }

  function openAgentTask(
    connectionId: string,
    environmentId?: string,
    prompt?: string,
  ) {
    const target = conns.find((connection) => connection.id === connectionId);
    if (!target) return;
    setAgentComposerRequest(
      environmentId && prompt
        ? {
            id: crypto.randomUUID(),
            connectionId: target.id,
            projectEnvironmentId: environmentId,
            prompt,
          }
        : null,
    );
    if (selected?.id !== connectionId) {
      selectConnection(connectionId);
    }
    if (compactShell) closeServices();
    setSettingsOpen(false);
    setEditing(null);
    setSchemaDiffGroupKey(null);
    setMobileExplorerOpen(false);
    if (!showAgentDock) openAgentDock();
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-agent-focus-target="active-session"], [data-agent-focus-target="launcher"]',
        )
        ?.focus();
    });
  }

  async function cancelBackgroundTask(task: BackgroundTask) {
    try {
      await backgroundTasks.cancelTask(task);
    } catch (error) {
      toast(errMessage(error), "error");
    }
  }

  function selectConnection(id: string) {
    const connection = conns.find((candidate) => candidate.id === id);
    const initial = connection && isDocumentEngine(connection.engine)
      ? queryDocument(id, "documents")
      : stableDocument(id, "welcome");
    workbench.prime(initial);
    setSelectedId(id);
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setMobileExplorerOpen(false);
    setKnowledgeEnvironmentFocus(null);
    focusMainAfterMobileSelection();
  }

  function openManualTransaction(
    transaction: WorkspaceManualTransaction,
  ) {
    if (selectedId !== transaction.connectionId) {
      selectConnection(transaction.connectionId);
      return;
    }
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setKnowledgeEnvironmentFocus(null);
    focusMainAfterMobileSelection();
  }

  async function settleManualTransaction(
    transaction: WorkspaceManualTransaction,
    action: "commit" | "rollback",
  ) {
    try {
      if (action === "commit") {
        await manualTransactions.commit(transaction);
      } else {
        await manualTransactions.rollback(transaction);
      }
    } catch (error) {
      toast(errMessage(error), "error");
    }
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
    setKnowledgeEnvironmentFocus(null);
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
        database: selected.database,
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

  function setQueryDraft(documentId: string, value: string) {
    publishWorkbenchDraft(documentId, value);
  }

  function setActiveQueryTitle(value: string) {
    if (!activeDocument || activeDocument.kind !== "sql") return;
    workbench.updateTitle(activeDocument.id, value);
  }

  function setActiveQuerySchema(value: string | null) {
    if (!activeDocument || activeDocument.kind !== "sql") return;
    workbench.updateSelectedSchema(activeDocument.id, value);
  }

  function setActiveQueryDatabase(value: string) {
    if (!activeDocument || activeDocument.kind !== "sql") return;
    workbench.updateSelectedDatabase(activeDocument.id, value);
  }

  function setActiveQueryResolveMode(value: SqlResolveMode) {
    if (!activeDocument || activeDocument.kind !== "sql") return;
    workbench.updateResolveMode(activeDocument.id, value);
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
      setKnowledgeEnvironmentFocus(null);
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
        id: "action:ai-chat",
        kind: "action",
        label: t("agent.acpTitle"),
        keywords: ["codex", "agent", "acp"],
        disabled: !selected,
        run: openOrFocusAgentDock,
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
          connection.providerTarget?.branchName
            ?? connection.providerTarget?.branchId,
          connection.host,
          connection.database,
        ]
          .filter(Boolean)
          .join(" · "),
        keywords: [
          connection.provider,
          connection.providerTarget?.branchId ?? "",
          connection.providerTarget?.branchName ?? "",
          connection.env ?? "",
          connection.username,
        ],
        run: () => selectConnection(connection.id),
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
                : document.kind === "welcome"
                  ? t("onboarding.title")
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

    const connectionById = new Map(
      conns.map((connection) => [connection.id, connection]),
    );
    const databaseObjects: SearchEverywhereItem[] =
      searchCatalogTargets.flatMap((target) => {
        const connection = connectionById.get(target.connectionId);
        if (!connection) return [];
        const overview = filterCatalogOverview(
          { ...connection, database: target.database },
          target.overview,
        );
        return overview.relations.map((relation) => ({
          id: `object:${connection.id}:${target.database}:${relation.schema ?? ""}:${relation.name}:${relation.kind}`,
          kind: "databaseObject" as const,
          label: [relation.schema, relation.name]
            .filter(Boolean)
            .join("."),
          detail: [
            connection.name || connection.database,
            target.database !== connection.database
              ? target.database
              : null,
            relation.kind,
          ]
            .filter(Boolean)
            .join(" · "),
          keywords: [
            connection.engine,
            target.database,
            relation.comment ?? "",
          ],
          run: async () => {
            try {
              const catalog = await queryClient.fetchQuery(
                databaseCatalogQuery(
                  connection.id,
                  target.database,
                  catalogScope,
                ),
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
                selectConnection(connection.id);
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
    searchCatalogTargets,
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
      selectedDocuments={selectedDocuments}
      activeDocument={activeDocument}
      activeDocumentId={activeDocumentId}
      supportsSql={supportsSql}
      knowledgeEnvironmentFocus={knowledgeEnvironmentFocus}
      initialAuditOpen={legacyAuditOpen.current}
      availableUpdate={availableUpdate}
      creatingDemo={creatingDemo}
      onCreateDemoDatabase={() => void createDemoDatabase()}
      onCloseSettings={() => setSettingsOpen(false)}
      onUpdateChecked={syncAvailableUpdate}
      onRefreshSafety={refreshSafety}
      onSafetySaved={acceptSafety}
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
      onSelectConnection={selectConnection}
      onActivateDocument={workbench.activateId}
      onRenameDocument={workbench.updateTitle}
      onCloseDocument={closeDocument}
      onNewQuery={() => void openQueryDocument()}
      onSearchEverywhere={openSearchEverywhere}
      onOpenActivity={() => openStableDocument("activity")}
      onOpenAgentTask={openAgentTask}
      onSetQueryTitle={setActiveQueryTitle}
      onSetQueryDatabase={setActiveQueryDatabase}
      onSetQuerySchema={setActiveQuerySchema}
      onSetQueryResolveMode={setActiveQueryResolveMode}
      onPersistedQuery={applySavedQuery}
      onQueryServiceSessionChange={queryServices.updateSession}
      onShowQueryServices={(sessionId) => {
        queryServices.activateNewestSession(sessionId);
        if (compactShell) {
          closeAgentDock();
          setMobileExplorerOpen(false);
        }
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
      settingsOpen={settingsOpen}
      activeSchemaGroupKey={schemaDiffGroupKey}
      connections={conns}
      selected={selected}
      selectedId={selectedId}
      selectedTable={selectedTable}
      supportsSql={supportsSql}
      writeEnabled={
        Boolean(
          selected &&
            safety?.allowWrites &&
            connectionCanEnterWritePath(selected),
        )
      }
      knowledgeEnvironmentFocus={knowledgeEnvironmentFocus}
      compact={compactShell}
      mobileExplorerOpen={mobileExplorerOpen}
      databaseExplorerOpen={databaseExplorerOpen}
      localHistoryOpen={localHistoryOpen}
      servicesOpen={servicesOpen}
      servicesHeight={servicesHeight}
      queryServiceStore={queryServices.store}
      backgroundTasks={backgroundTasks.tasks}
      cancellingBackgroundTaskKeys={backgroundTasks.cancellingKeys}
      manualTransactions={manualTransactions.transactions}
      settlingManualTransactionIds={manualTransactions.settlingIds}
      workbenchDocuments={selectedDocuments}
      activeWorkbenchDocumentId={activeDocumentId}
      explorerRevealRequest={explorerRevealRequest}
      unseenOperationCount={unseen}
      sidebarWidth={sidebarW}
      mainRef={mainRef}
      agentButtonRef={agentButtonRef}
      searchEverywhereButtonRef={searchEverywhereButtonRef}
      mainContent={mainContent}
      availableUpdate={availableUpdate}
      agentDockOpen={showAgentDock}
      agentComposerRequest={agentComposerRequest}
      searchEverywhereOpen={searchEverywhereOpen}
      agentOverlay={agentOverlay}
      agentWidth={agentDockWidth}
      creatingDemo={creatingDemo}
      onWorkspaceScopeChanged={reloadWorkspaceScope}
      onWorkspaceDataRefreshed={refreshWorkspaceData}
      onNewConnection={startNewConnection}
      onCreateDemoDatabase={() => void createDemoDatabase()}
      onOpenProjectEnvironment={(
        environmentId: string | null,
        view: KnowledgeEnvironmentView,
        resourceId: string | null = null,
      ) => {
        setSettingsOpen(false);
        setEditing(null);
        setSchemaDiffGroupKey(null);
        setKnowledgeEnvironmentFocus({
          environmentId,
          view,
          resourceId,
          requestId: Date.now(),
        });
        if (!compactShell) showDatabaseExplorer();
        setMobileExplorerOpen(false);
      }}
      onToggleDatabaseExplorer={() => {
        if (!compactShell) {
          toggleDatabaseExplorer();
          return;
        }
        closeServices();
        closeAgentDock();
        if (databaseExplorerOpen && mobileExplorerOpen) {
          dismissMobileExplorer();
          return;
        }
        showDatabaseExplorer();
        setMobileExplorerOpen(true);
      }}
      onToggleLocalHistory={() => {
        if (!compactShell) {
          toggleLocalHistory();
          return;
        }
        closeServices();
        closeAgentDock();
        if (localHistoryOpen && mobileExplorerOpen) {
          dismissMobileExplorer();
          return;
        }
        showLocalHistory();
        setMobileExplorerOpen(true);
      }}
      onCloseLocalHistory={closeLocalHistory}
      onToggleServices={() => {
        if (compactShell && !servicesOpen) {
          closeAgentDock();
          setMobileExplorerOpen(false);
        }
        toggleServices();
      }}
      onCloseServices={closeServices}
      onCancelBackgroundTask={cancelBackgroundTask}
      onOpenAgentTask={openAgentTask}
      onOpenManualTransaction={openManualTransaction}
      onCommitManualTransaction={(transaction) =>
        settleManualTransaction(transaction, "commit")
      }
      onRollbackManualTransaction={(transaction) =>
        settleManualTransaction(transaction, "rollback")
      }
      onRevealDatabaseContext={() => {
        setSettingsOpen(false);
        setSchemaDiffGroupKey(null);
        setKnowledgeEnvironmentFocus(null);
        showDatabaseExplorer();
        if (compactShell) {
          closeServices();
          closeAgentDock();
          setMobileExplorerOpen(true);
        }
        setExplorerRevealRequest((request) => request + 1);
      }}
      onActivateWorkbenchDocument={workbench.activateId}
      onRestoreWorkbenchDocument={setQueryDraft}
      onStartServicesResize={startServicesResize}
      onResetServicesHeight={resetServicesHeight}
      onSettings={() => {
        setSettingsSection(undefined);
        setSettingsOpen(true);
        setSchemaDiffGroupKey(null);
        setMobileExplorerOpen(false);
        if (compactShell) {
          closeServices();
          closeAgentDock();
        }
      }}
      onSafetySettings={() => {
        setSettingsSection("safety");
        setSettingsOpen(true);
        setSchemaDiffGroupKey(null);
        setMobileExplorerOpen(false);
        if (compactShell) {
          closeServices();
          closeAgentDock();
        }
      }}
      onOpenNotifications={() => {
        markSeen();
        openStableDocument("activity");
      }}
      onNewQuery={() => void openQueryDocument()}
      onOpenAgentArchive={openAgentArchiveSettings}
      onOpenAgent={openOrFocusAgentDock}
      onSearchEverywhere={openSearchEverywhere}
      onSelectWorkspaceConnection={selectConnection}
      onOpenTable={openTableDocument}
      onOpenSchemaDiff={(group) => {
        setKnowledgeEnvironmentFocus(null);
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
      onAgentWidthChange={updateAgentDockWidth}
      onCloseAgent={closeAgentDock}
      />
      <SkillStartupGate />
      {searchEverywhereOpen ? (
        <SearchEverywhere
          items={searchEverywhereItems}
          onClose={closeSearchEverywhere}
        />
      ) : null}
    </>
  );
}
