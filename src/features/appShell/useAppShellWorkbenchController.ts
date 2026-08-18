import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { CatalogTable } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import { useToast } from "../../components/Toast";
import { hasCapability, isDocumentEngine } from "../../lib/capabilities";
import { useI18n } from "../../lib/i18n";
import { resetConnectionResourceQueries } from "../../lib/queryClient";
import {
  driversQuery,
  qk,
  type CatalogScope,
} from "../../lib/queries";
import { buildConnectionSections } from "../../lib/schemaDiff";
import type { ConnectionProfile } from "../connections/domain";
import {
  createDemoSqlite,
  upsertConnection,
} from "../connections/tauriAdapter";
import {
  demoSqliteConnection,
  findDemoSqliteConnection,
  type ConnectionLaunchPreset,
} from "../connections/presets";
import type { KnowledgeEnvironmentView } from "../knowledge/domain";
import { connectionCanEnterWritePath } from "../safetySettings/policy";
import type { SettingsSection } from "../settings/domain";
import type { SqlDocument } from "../sqlDocuments/domain";
import { tauriSqlDocumentGateway } from "../sqlDocuments/tauriAdapter";
import type { SqlResolveMode } from "../queries/resolveMode";
import {
  queryDocument,
  stableDocument,
  tableDocument,
  type WorkbenchDocument,
} from "../workbench/domain";
import { publishWorkbenchDraft } from "../workbench/draftStore";
import { useWorkbenchDocuments } from "../workbench/useWorkbenchDocuments";
import { recordStartupMark } from "../runtime/tauriAdapter";
import {
  appShellNavigationReducer,
  initialAppShellMode,
} from "./navigationState";
import {
  preloadSqlEditor,
  useActivitySeen,
  usePersistentSelectedConnection,
  useRestoredWorkbenchState,
  useSqlEditorPreload,
} from "./navigationHooks";
import {
  changedConnectionRuntimeIds,
  useConnectionProfiles,
} from "./useConnectionProfiles";
import { useSafetySettings } from "./useSafetySettings";

export type EditingConnection = ConnectionProfile | "new" | null;

type WorkbenchControllerInput = {
  scope: CatalogScope;
  mobileExplorer: {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    focusMainAfterSelection: () => void;
  };
  activity: {
    unseen: number;
    markSeen: () => void;
  };
};

/** Owns the mutually dependent connection, route, policy, and document lifecycle. */
export function useAppShellWorkbenchController({
  scope,
  mobileExplorer,
  activity,
}: WorkbenchControllerInput) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const {
    connections,
    setConnections,
    loaded: connectionsLoaded,
    loadError,
    refresh,
  } = useConnectionProfiles(scope.key);
  const [selectedId, setSelectedId] = usePersistentSelectedConnection();
  const [navigation, navigate] = useReducer(
    appShellNavigationReducer,
    initialAppShellMode,
  );
  const selectionRestoreMarked = useRef(false);
  const {
    safety,
    error: safetyError,
    refresh: refreshSafety,
    accept: acceptSafety,
    clear: clearSafety,
  } = useSafetySettings(selectedId);
  const [creatingDemo, setCreatingDemo] = useState(false);
  const { legacyAuditOpen, restoredDocumentKind } = useRestoredWorkbenchState();
  const selected =
    connections.find((connection) => connection.id === selectedId) ?? null;
  const mainRoute = navigation.route;
  const settingsOpen = navigation.kind === "settings";
  const settingsSection =
    navigation.kind === "settings" ? navigation.section : undefined;
  const schemaDiffGroupKey =
    mainRoute.kind === "schemaDiff" ? mainRoute.groupKey : null;
  const knowledgeEnvironmentFocus =
    mainRoute.kind === "knowledge" ? mainRoute.focus : null;
  const connectionPreset =
    mainRoute.kind === "connectionEditor" &&
    mainRoute.target.kind === "new"
      ? mainRoute.target.preset
      : null;
  let editing: EditingConnection = null;
  if (mainRoute.kind === "connectionEditor") {
    const target = mainRoute.target;
    editing =
      target.kind === "new"
        ? "new"
        : connections.find((connection) => connection.id === target.connectionId) ??
          null;
  }

  useEffect(() => {
    if (!connectionsLoaded || selectionRestoreMarked.current) return;
    selectionRestoreMarked.current = true;
    void recordStartupMark(
      "selected_connection_restored",
      loadError === null,
    ).catch(() => undefined);
  }, [connectionsLoaded, loadError]);

  const schemaGroups = useMemo(
    () =>
      buildConnectionSections(connections).flatMap((section) =>
        section.kind === "group" &&
        !isDocumentEngine(section.group.connections[0]?.engine)
          ? [section.group]
          : [],
      ),
    [connections],
  );
  const activeSchemaGroup =
    schemaGroups.find((group) => group.key === schemaDiffGroupKey) ?? null;
  const drivers = useQuery(driversQuery());
  const supportsSql =
    !selected ||
    (drivers.data
      ? hasCapability(drivers.data, selected, "sql")
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
  const { selectedDocuments, activeDocument, activeDocumentId } = workbench;
  const selectedTable =
    activeDocument?.kind === "data" ? activeDocument.table : null;

  useSqlEditorPreload(selected?.id ?? null, supportsSql);
  useActivitySeen(activeDocument?.kind ?? null, activity.unseen, activity.markSeen);

  useEffect(() => {
    if (schemaDiffGroupKey && !activeSchemaGroup) {
      navigate({
        type: "schemaGroupUnavailable",
        groupKey: schemaDiffGroupKey,
      });
    }
  }, [activeSchemaGroup, schemaDiffGroupKey]);

  async function reloadWorkspaceScope() {
    setSelectedId(null);
    workbench.reset();
    navigate({ type: "workspaceScopeChanged" });
    clearSafety();
  }

  async function refreshWorkspaceData() {
    const previous = connections;
    const next = await refresh();
    if (!next) return;
    const changedIds = changedConnectionRuntimeIds(previous, next);
    await resetConnectionResourceQueries(queryClient, changedIds);
  }

  function showWorkbench() {
    navigate({ type: "showWorkbench" });
  }

  function openSettings(section?: SettingsSection) {
    navigate({ type: "openSettings", section });
  }

  function openKnowledge(
    environmentId: string | null,
    view: KnowledgeEnvironmentView,
    resourceId: string | null = null,
  ) {
    navigate({
      type: "openKnowledge",
      focus: {
        environmentId,
        view,
        resourceId,
        requestId: Date.now(),
      },
    });
  }

  function startNewConnection(preset?: ConnectionLaunchPreset) {
    navigate({
      type: "openConnectionEditor",
      target: { kind: "new", preset: preset ?? null },
    });
    mobileExplorer.setOpen(false);
    mobileExplorer.focusMainAfterSelection();
  }

  function editConnection(connection: ConnectionProfile) {
    navigate({
      type: "openConnectionEditor",
      target: { kind: "existing", connectionId: connection.id },
    });
  }

  function selectConnection(id: string) {
    const connection = connections.find((candidate) => candidate.id === id);
    const initial =
      connection && isDocumentEngine(connection.engine)
        ? queryDocument(id, "documents")
        : stableDocument(id, "welcome");
    workbench.prime(initial);
    setSelectedId(id);
    showWorkbench();
    mobileExplorer.setOpen(false);
    mobileExplorer.focusMainAfterSelection();
  }

  function activateDocument(
    document: WorkbenchDocument,
    closeMobileExplorer = true,
  ) {
    workbench.activate(document);
    showWorkbench();
    if (closeMobileExplorer) {
      mobileExplorer.setOpen(false);
      if (mobileExplorer.open) mobileExplorer.focusMainAfterSelection();
    }
  }

  function openTable(connection: ConnectionProfile, table: CatalogTable) {
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
    activateDocument(
      stableDocument(selected.id, kind),
      closeMobileExplorer,
    );
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
    showWorkbench();
  }

  function closeDocument(id: string) {
    if (!selected) return;
    workbench.close(id, selected.id, supportsSql);
  }

  function setActiveQueryTitle(value: string) {
    if (activeDocument?.kind === "sql") {
      workbench.updateTitle(activeDocument.id, value);
    }
  }

  function setActiveQuerySchema(value: string | null) {
    if (activeDocument?.kind === "sql") {
      workbench.updateSelectedSchema(activeDocument.id, value);
    }
  }

  function setActiveQueryDatabase(value: string) {
    if (activeDocument?.kind === "sql") {
      workbench.updateSelectedDatabase(activeDocument.id, value);
    }
  }

  function setActiveQueryResolveMode(value: SqlResolveMode) {
    if (activeDocument?.kind === "sql") {
      workbench.updateResolveMode(activeDocument.id, value);
    }
  }

  function applySavedQuery(saved: SqlDocument) {
    if (activeDocument?.kind === "sql") {
      workbench.applyPersisted(activeDocument.id, saved);
    }
  }

  async function createDemoDatabase() {
    if (creatingDemo) return;
    setCreatingDemo(true);
    try {
      const path = await createDemoSqlite();
      const existing = findDemoSqliteConnection(connections, path);
      const saved =
        existing ?? (await upsertConnection(demoSqliteConnection(path)));
      if (!existing) await refresh();
      setSelectedId(saved.id);
      showWorkbench();
      toast(t("connections.demoCreated"));
    } catch (error) {
      toast(errMessage(error), "error");
    } finally {
      setCreatingDemo(false);
    }
  }

  async function connectionSaved(
    profile: ConnectionProfile,
    closeEditor: boolean,
  ) {
    await refresh();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.catalog(profile.id) }),
      queryClient.invalidateQueries({
        queryKey: qk.catalogOverview(profile.id),
      }),
      queryClient.invalidateQueries({
        queryKey: qk.catalogSnapshot(profile.id),
      }),
    ]);
    setSelectedId(profile.id);
    if (closeEditor) showWorkbench();
  }

  async function deletedConnection(id: string) {
    await refresh();
    if (selectedId === id) {
      setSelectedId(null);
      workbench.reset();
    }
    navigate({ type: "connectionDeleted", connectionId: id });
  }

  function updateConnection(updated: ConnectionProfile) {
    setConnections((current) =>
      current.map((connection) =>
        connection.id === updated.id ? updated : connection,
      ),
    );
  }

  function activate(document: WorkbenchDocument) {
    activateDocument(document);
  }

  return {
    route: {
      settingsOpen,
      settingsSection,
      schemaDiffGroupKey,
      activeSchemaGroup,
      knowledgeEnvironmentFocus,
      editing,
      connectionPreset,
    },
    connections: {
      items: connections,
      selected,
      selectedId,
      loadError,
      supportsSql,
      creatingDemo,
    },
    safety: {
      value: safety,
      error: safetyError,
      writeEnabled: Boolean(
        selected &&
          safety?.allowWrites &&
          connectionCanEnterWritePath(selected),
      ),
    },
    documents: {
      items: selectedDocuments,
      active: activeDocument,
      activeId: activeDocumentId,
      selectedTable,
      initialAuditOpen: legacyAuditOpen.current,
    },
    commands: {
      route: {
        showWorkbench,
        closeSettings: () => navigate({ type: "closeSettings" }),
        openSettings,
        focusToolWindow: () => navigate({ type: "focusToolWindow" }),
        openKnowledge,
        openSchemaDiff: (groupKey: string) =>
          navigate({ type: "openSchemaDiff", groupKey }),
      },
      connections: {
        reloadWorkspaceScope,
        refreshWorkspaceData,
        retry: () => void refresh(),
        new: startNewConnection,
        edit: editConnection,
        select: selectConnection,
        save: connectionSaved,
        delete: deletedConnection,
        update: updateConnection,
        createDemo: () => void createDemoDatabase(),
      },
      safety: {
        refresh: refreshSafety,
        accept: acceptSafety,
      },
      documents: {
        activate,
        activateId: workbench.activateId,
        rename: workbench.updateTitle,
        close: closeDocument,
        newQuery: () => void openQueryDocument(),
        openQuery: openQueryDocument,
        openTable,
        openStable: openStableDocument,
        restoreDraft: publishWorkbenchDraft,
        setTitle: setActiveQueryTitle,
        setDatabase: setActiveQueryDatabase,
        setSchema: setActiveQuerySchema,
        setResolveMode: setActiveQueryResolveMode,
        persisted: applySavedQuery,
        loadSql,
        consumeInitialAudit: () => {
          legacyAuditOpen.current = false;
        },
      },
    },
  };
}
