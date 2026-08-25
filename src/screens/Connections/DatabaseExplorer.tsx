// Database Explorer sidebar: connection tree, DDL modal, schema-group
// drag-and-drop. Split out of the old Connections/index.tsx (see ConnectionForm.tsx
// for the connection create/edit form that used to live alongside it).
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CatalogTable } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import {
  connectionAccessIssue,
  type ConnectionProfile,
} from "../../features/connections/domain";
import type { ConnectionLaunchPreset } from "../../features/connections/presets";
import {
  deleteConnection,
  upsertConnection,
} from "../../features/connections/tauriAdapter";
import { SCHEMA_SCOPE_PARAMETER } from "../../features/catalogExplorer/scopeFilter";
import { ProviderCredentialDialog } from "../../features/providers/ProviderCredentialDialog";
import { connectionQueryKeys } from "../../features/connections/queries";
import type { ProviderKind } from "../../features/providers/domain";
import type {
  EnvironmentConnection,
  KnowledgeEnvironment,
  KnowledgeEnvironmentView,
  KnowledgeProject,
  KnowledgeSource,
} from "../../features/knowledge/domain";
import { bindKnowledgeEnvironmentConnectionWithRefresh } from "../../features/knowledge/bindEnvironmentConnection";
import {
  listKnowledgeEnvironmentConnections,
  onKnowledgeSourceChanged,
} from "../../features/knowledge/tauriAdapter";
import { knowledgeInventoryQuery } from "../../features/knowledge/inventory";
import { captureProductEvent } from "../../features/productAnalytics/client";
import {
  productAnalyticsAccessMode,
  productAnalyticsConnectionEngine,
  productAnalyticsWorkspaceContext,
} from "../../features/productAnalytics/outcomes";
import type {
  AnalysisArticleRecord,
  AnalysisArticleState,
} from "../../features/analysisArticles/domain";
import { listAnalysisArticles } from "../../features/analysisArticles/tauriAdapter";
import { analysisQueryKeys } from "../../features/analysisArticles/queryKeys";
import { EnvironmentSetupDialog } from "../../features/knowledge/components/EnvironmentSetupDialog";
import { ProjectSetupDialog } from "../../features/knowledge/components/ProjectSetupDialog";
import { knowledgeRevisionLabel } from "../../features/knowledge/presentation";
import { knowledgeQueryKeys } from "../../features/knowledge/queryKeys";
import { useCatalogExplorerState } from "../../features/catalogExplorer/state";
import { useSchemaGroupDrag } from "../../features/catalogExplorer/useSchemaGroupDrag";
import {
  qk,
  sharedWorkspaceScopeAvailable,
  useCatalogScope,
} from "../../lib/queries";
import { useWorkspaceResourceQueryRecovery } from "../../lib/queryClient";
import {
  buildConnectionSections,
  compareCatalogs,
  defaultSchemaBaseline,
  diffCounts,
  schemaGroupIsCompatible,
  type SchemaConnectionGroup,
} from "../../lib/schemaDiff";
import EngineMark from "../../components/EngineMark";
import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import { SelectInput } from "../../design-system/components/FormControls";
import {
  LoadingLabel,
  StatusDot,
  type StatusTone,
} from "../../design-system/components/Status";
import ToolbarMenu, {
  ToolbarMenuItem,
} from "../../components/ToolbarMenu";
import {
  ToolWindowAction,
  ToolWindowHideButton,
  ToolWindowSearchRow,
  ToolWindowSection,
  ToolWindowSideSurface,
} from "../../design-system/components/ToolWindow";
import {
  TreeRowActions,
  TreeSearch,
  TreeSectionButton,
} from "../../design-system/components/TreeControls";
import { useTreeKeyboardNavigation } from "../../design-system/treeKeyboard";
import WorkspaceConnectionDialog from "../../features/workspaces/components/WorkspaceConnectionDialog";
import { deleteWorkspaceConnection } from "../../features/workspaces/tauriAdapter";
import { useToast } from "../../components/Toast";
import { useI18n } from "../../lib/i18n";
import { queryResultPhase } from "../../lib/queryResultPhase";
import ConnectionNode from "./ConnectionNode";
import type { CatalogTreeSearchResult } from "./CatalogTree";
import DdlModal from "./DdlModal";
import { useCatalogTree } from "./useCatalogTree";

function knowledgeSourceTone(source: KnowledgeSource): StatusTone {
  if (source.health === "ready") return "success";
  if (source.health === "failed") return "danger";
  return "warning";
}

function environmentAnalysisTone(
  article: AnalysisArticleRecord,
): StatusTone {
  if (article.state === "live") return "success";
  if (article.state === "review") return "warning";
  return "neutral";
}

function TreeLoadFailure({
  message,
  detail,
  retryLabel,
  treeItem,
  onRetry,
}: {
  message: string;
  detail: string;
  retryLabel: string;
  treeItem: { key: string; parentKey: string; level: number };
  onRetry: () => void;
}) {
  return (
    <button
      type="button"
      className="tw:flex tw:min-h-control-sm tw:w-full tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:px-2 tw:py-1 tw:text-left tw:font-sans tw:text-xs tw:text-danger tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
      onClick={onRetry}
      title={`${message}: ${detail}`}
      role="treeitem"
      aria-level={treeItem.level}
      data-explorer-tree-item
      data-explorer-tree-key={treeItem.key}
      data-explorer-tree-parent-key={treeItem.parentKey}
      data-tree-primary-action
      tabIndex={-1}
    >
      <Icon name="alert" className="tw:shrink-0" />
      <span className="tw:min-w-0 tw:flex-1 tw:truncate">{message}</span>
      <span className="tw:shrink-0">{retryLabel}</span>
    </button>
  );
}

// Database Explorer: connections in the sidebar, the selected one
// expanded to reveal its tables. Clicking a table opens its data in the main area.
export function DatabaseExplorer({
  connections,
  selectedId,
  selectedTableKey,
  activeSchemaGroupKey,
  onSelectConn,
  onOpenTable,
  onOpenSchemaDiff,
  onEdit,
  onDeleted,
  onConnectionUpdated,
  workspaceAccount,
  workspaceHeader,
  onNewConnection,
  onClose,
  onCreateDemoDatabase,
  creatingDemo = false,
  compact = false,
  compactOpen = false,
  revealRequest: externalRevealRequest = 0,
  revealDatabase = null,
  revealNamespace = null,
  activeProjectEnvironmentId = null,
  activeProjectEnvironmentView = null,
  activeProjectEnvironmentResourceId = null,
  onOpenProjectEnvironment,
}: {
  connections: ConnectionProfile[];
  selectedId: string | null;
  selectedTableKey: string | null;
  activeSchemaGroupKey: string | null;
  onSelectConn: (id: string) => void;
  onOpenTable: (conn: ConnectionProfile, table: CatalogTable) => void;
  onOpenSchemaDiff: (group: SchemaConnectionGroup) => void;
  onEdit: (conn: ConnectionProfile) => void;
  onDeleted: (id: string) => void;
  onConnectionUpdated: (conn: ConnectionProfile) => void;
  workspaceAccount?: ReactNode;
  workspaceHeader?: ReactNode;
  onNewConnection: (preset?: ConnectionLaunchPreset) => void;
  onClose: () => void;
  onCreateDemoDatabase: () => void;
  creatingDemo?: boolean;
  compact?: boolean;
  compactOpen?: boolean;
  revealRequest?: number;
  revealDatabase?: string | null;
  revealNamespace?: string | null;
  activeProjectEnvironmentId?: string | null;
  activeProjectEnvironmentView?: KnowledgeEnvironmentView | null;
  activeProjectEnvironmentResourceId?: string | null;
  onOpenProjectEnvironment: (
    environmentId: string | null,
    view: KnowledgeEnvironmentView,
    resourceId?: string | null,
  ) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const catalogScope = useCatalogScope();
  useWorkspaceResourceQueryRecovery(catalogScope.key, catalogScope.ready);
  const catalogScopeKeyRef = useRef(catalogScope.key);
  const knowledgeEnabled =
    catalogScope.ready &&
    (catalogScope.workspaceKind === "personal" ||
      catalogScope.accountScope !== null);
  const sharedKnowledgeWorkspace =
    knowledgeEnabled && sharedWorkspaceScopeAvailable(catalogScope);
  const inventoryQuery = knowledgeInventoryQuery(catalogScope.key, knowledgeEnabled);
  const knowledgeProjects = useQuery({
    ...inventoryQuery,
    select: (inventory) => inventory.projects,
  });
  const knowledgeSources = useQuery({
    ...inventoryQuery,
    select: (inventory) => inventory.sources,
  });
  const knowledgeSourcesPhase = queryResultPhase(
    knowledgeSources.data,
    knowledgeSources.error,
  );
  const projectEnvironmentIds = useMemo(
    () =>
      (knowledgeProjects.data ?? []).flatMap((project) =>
        project.environments.map((environment) => environment.id),
      ),
    [knowledgeProjects.data],
  );
  const environmentConnections = useQuery({
    queryKey: knowledgeQueryKeys.environmentConnections(undefined, catalogScope.key),
    queryFn: () => listKnowledgeEnvironmentConnections(),
    enabled: knowledgeEnabled,
    retry: false,
    staleTime: 60_000,
  });
  const [globalFilter, setGlobalFilter] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [analysisFilter, setAnalysisFilter] = useState("");
  const [analysisStateFilter, setAnalysisStateFilter] = useState<
    "all" | AnalysisArticleState
  >("all");
  const [searchResultsByCatalog, setSearchResultsByCatalog] = useState<
    Record<string, CatalogTreeSearchResult[]>
  >({});
  const [activeSearchResultKey, setActiveSearchResultKey] = useState<
    string | null
  >(null);
  const [projectSetupOpen, setProjectSetupOpen] = useState(false);
  const [environmentSetupProjectId, setEnvironmentSetupProjectId] =
    useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    new Set(),
  );
  const [expandedEnvironmentIds, setExpandedEnvironmentIds] = useState<Set<string>>(
    new Set(),
  );
  const [expandedResourceKeys, setExpandedResourceKeys] = useState<Set<string>>(
    new Set(),
  );
  const environmentAnalysisQueries = useQueries({
    queries: projectEnvironmentIds.map((environmentId) => ({
      queryKey: analysisQueryKeys.articles(catalogScope.key, environmentId),
      queryFn: () => listAnalysisArticles(environmentId),
      enabled:
        sharedKnowledgeWorkspace &&
        (expandedResourceKeys.has(`${environmentId}:analyses`) ||
          (activeProjectEnvironmentId === environmentId &&
            activeProjectEnvironmentView === "analyses")),
      retry: false,
    })),
  });
  const knownKnowledgeScopeRef = useRef<{
    key: string;
    projectIds: Set<string>;
    environmentIds: Set<string>;
  } | null>(null);
  const [treeScrollElement, setTreeScrollElement] =
    useState<HTMLDivElement | null>(null);
  const treeRootRef = useRef<HTMLDivElement>(null);
  const treeKeyboard = useTreeKeyboardNavigation(treeRootRef);
  const [savingScopeId, setSavingScopeId] = useState<string | null>(null);
  const [localRevealRequest, setLocalRevealRequest] = useState(0);
  const [providerCredentialsOpen, setProviderCredentialsOpen] =
    useState<ProviderKind | null>(null);
  const providerReturnFocusRef = useRef<HTMLElement | null>(null);
  const {
    state: {
      wanted,
      refreshErrors: refreshErrs,
      openConnections: open,
      refreshingId: refreshing,
      deletingId: deleting,
      collapsedSections,
      objectSectionsOpen,
      showRowCounts,
      openMenuId,
      workspaceDialog,
      ddlDialog,
    },
    commands,
  } = useCatalogExplorerState(catalogScope.key);
  const closeOpenMenu = useEffectEvent(() => {
    commands.patch({ openMenuId: null });
  });

  useEffect(() => {
    if (!knowledgeProjects.data) return;
    const projectIds = new Set(
      knowledgeProjects.data.map((project) => project.id),
    );
    const environmentIds = new Set(projectEnvironmentIds);
    const previous =
      knownKnowledgeScopeRef.current?.key === catalogScope.key
        ? knownKnowledgeScopeRef.current
        : null;
    const newProjectIds = [...projectIds].filter(
      (id) => !previous?.projectIds.has(id),
    );
    const newEnvironmentIds = [...environmentIds].filter(
      (id) => !previous?.environmentIds.has(id),
    );

    if (previous === null) {
      setExpandedProjectIds(projectIds);
      setExpandedEnvironmentIds(environmentIds);
      setExpandedResourceKeys(
        new Set([
          "unassigned",
          ...projectEnvironmentIds.map(
            (environmentId) => `${environmentId}:databases`,
          ),
        ]),
      );
    } else {
      setExpandedProjectIds((current) =>
        new Set([...current, ...newProjectIds]),
      );
      setExpandedEnvironmentIds((current) =>
        new Set([...current, ...newEnvironmentIds]),
      );
      setExpandedResourceKeys(
        (current) =>
          new Set([
            ...current,
            ...newEnvironmentIds.map(
              (environmentId) => `${environmentId}:databases`,
            ),
          ]),
      );
    }
    knownKnowledgeScopeRef.current = {
      key: catalogScope.key,
      projectIds,
      environmentIds,
    };
  }, [catalogScope.key, knowledgeProjects.data, projectEnvironmentIds]);

  useEffect(() => {
    if (!knowledgeEnabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onKnowledgeSourceChanged(() => {
      if (disposed) return;
      void queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.inventory(),
      });
      void queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.agentEnvironments(),
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [knowledgeEnabled, queryClient]);

  const environmentConnectionsById = new Map<string, EnvironmentConnection[]>();
  for (const binding of environmentConnections.data ?? []) {
    const current = environmentConnectionsById.get(binding.projectEnvironmentId) ?? [];
    current.push(binding);
    environmentConnectionsById.set(binding.projectEnvironmentId, current);
  }
  const environmentBindingsReady = environmentConnections.isSuccess;
  const boundConnectionIds = new Set(
    environmentBindingsReady
      ? [...environmentConnectionsById.values()].flatMap((bindings) =>
          bindings.flatMap((binding) =>
            binding.connectionId ? [binding.connectionId] : [],
          ),
        )
      : [],
  );
  const unassignedConnections =
    knowledgeProjects.isSuccess && environmentBindingsReady
      ? connections.filter((connection) => !boundConnectionIds.has(connection.id))
      : connections;
  const unassignedSections = buildConnectionSections(unassignedConnections);
  const unassignedConnectionIds = new Set(
    unassignedConnections.map((connection) => connection.id),
  );
  const environmentDropTargets = projectEnvironmentIds.map(
    (environmentId) => ({
      id: environmentId,
      accepting: environmentConnections.isSuccess,
      connectionIds: new Set(
        (environmentConnectionsById.get(environmentId) ?? []).flatMap(
          (binding) => (binding.connectionId ? [binding.connectionId] : []),
        ),
      ),
    }),
  );

  async function bindDroppedConnection(
    connection: ConnectionProfile,
    environmentId: string,
  ) {
    const environment = (knowledgeProjects.data ?? [])
      .flatMap((project) => project.environments)
      .find((candidate) => candidate.id === environmentId);
    if (!environment) return;
    try {
      const binding = await bindKnowledgeEnvironmentConnectionWithRefresh({
        projectEnvironmentId: environmentId,
        connectionId: connection.id,
        role: "primary",
        alias:
          connection.name.trim() || connection.database.trim() || "database",
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: knowledgeQueryKeys.environmentConnections(),
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: knowledgeQueryKeys.agentEnvironments(),
          refetchType: "active",
        }),
      ]);
      const context = productAnalyticsWorkspaceContext(catalogScope);
      if (context) {
        void captureProductEvent({
          name: "environment_connection_bound",
          properties: {
            accessMode: productAnalyticsAccessMode(connection.credentialMode),
            engine: productAnalyticsConnectionEngine(connection.engine),
          },
          context,
          dedupeId: binding.id,
        });
      }
      toast(
        t("connections.environmentConnectionMoved", {
          connection:
            connection.name || connection.database || t("app.unnamed"),
          environment: environment.name,
        }),
      );
    } catch (error) {
      toast(errMessage(error), "error");
    }
  }

  function openProviderCredentials(provider: ProviderKind) {
    providerReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setProviderCredentialsOpen(provider);
  }
  const {
    groupByConnectionId,
    draggingId,
    dropTarget,
    dragPreview,
    suppressClickRef,
    pointerDown: pointerDownConnection,
    pointerMove: pointerMoveConnection,
    pointerUp: pointerUpConnection,
    pointerCancel: pointerCancelConnection,
  } = useSchemaGroupDrag(connections, onConnectionUpdated, {
    environmentTargets: environmentDropTargets,
    unassignedConnectionIds,
    onDropOnEnvironment: bindDroppedConnection,
  });

  useEffect(() => {
    if (!openMenuId) return;
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".db-menu")) return;
      closeOpenMenu();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [openMenuId]);

  // Query observers survive the shell while a workspace changes. Clear the explorer's
  // per-connection intent at the same boundary as its scoped keys so no hidden row can
  // resubscribe an old connection in the newly active account.
  useEffect(() => {
    catalogScopeKeyRef.current = catalogScope.key;
  }, [catalogScope.key]);

  useEffect(() => {
    setProjectSetupOpen(false);
    setEnvironmentSetupProjectId(null);
  }, [catalogScope.key]);

  useEffect(() => {
    setAnalysisFilter("");
    setAnalysisStateFilter("all");
  }, [activeProjectEnvironmentId, catalogScope.key]);

  useEffect(() => {
    if (
      !activeProjectEnvironmentId ||
      activeProjectEnvironmentView !== "analyses" ||
      !projectEnvironmentIds.includes(activeProjectEnvironmentId)
    ) {
      return;
    }
    const analysisKey = `${activeProjectEnvironmentId}:analyses`;
    setExpandedResourceKeys((current) => {
      if (current.has(analysisKey)) return current;
      return new Set([...current, analysisKey]);
    });
  }, [
    activeProjectEnvironmentId,
    activeProjectEnvironmentView,
    projectEnvironmentIds,
  ]);

  const wantedIds = useMemo(() => [...wanted].sort(), [wanted]);
  const readableWantedIds = useMemo(() => {
    const byId = new Map<string, ConnectionProfile>(
      connections.map((connection) => [connection.id, connection]),
    );
    return wantedIds.filter((id) => {
      const connection = byId.get(id);
      return connection !== undefined
        && connectionAccessIssue(connection) === undefined;
    });
  }, [connections, wantedIds]);
  const {
    databasesByConnection,
    databaseOverviews,
    overviewErrsByDatabase,
    databaseCatalogs,
    detailErrsByDatabase,
    overviews,
    overviewErrs,
    catalogs,
    detailErrs,
    requestOverview,
    requestDetails,
    forgetOverview,
    forgetConnection,
  } = useCatalogTree(readableWantedIds, catalogScope);
  const errs = { ...overviewErrs, ...refreshErrs };

  // Expanding a node subscribes to its catalog; the query cache decides whether that is a
  // fetch or a free read. Retries are not automatic (see the query defaults), so a node
  // that failed refetches when the user expands it again.
  function ensureLoaded(id: string) {
    commands.want(id);
    commands.clearRefreshError(id);
    if (
      queryClient.getQueryState(qk.connectionDatabases(id, catalogScope.key))
        ?.status === "error"
    ) {
      void queryClient.refetchQueries({
        queryKey: qk.connectionDatabases(id, catalogScope.key),
      });
    }
  }

  function ensureGroupLoaded(id: string) {
    const group = groupByConnectionId.get(id);
    if (!group) {
      ensureLoaded(id);
      return;
    }
    for (const conn of group.connections) ensureLoaded(conn.id);
  }

  function toggleOpen(id: string) {
    const willOpen = !open.has(id);
    commands.toggleConnection(id);
    if (willOpen) {
      ensureGroupLoaded(id);
      return;
    }
    commands.forget(id);
    forgetConnection(id);
  }

  function expandAllConnections() {
    for (const connection of connections) ensureGroupLoaded(connection.id);
    setExpandedProjectIds(
      new Set((knowledgeProjects.data ?? []).map((project) => project.id)),
    );
    setExpandedEnvironmentIds(new Set(projectEnvironmentIds));
    setExpandedResourceKeys(
      new Set(
        ["unassigned", ...projectEnvironmentIds.flatMap((environmentId) => [
          `${environmentId}:databases`,
          `${environmentId}:sources`,
          `${environmentId}:analyses`,
        ])],
      ),
    );
    commands.patch({
      openConnections: new Set(
        connections.map((connection) => connection.id),
      ),
    });
  }

  function collapseAllConnections() {
    for (const id of readableWantedIds) forgetConnection(id);
    setExpandedProjectIds(new Set());
    setExpandedEnvironmentIds(new Set());
    setExpandedResourceKeys(new Set());
    commands.patch({
      openConnections: new Set(),
      wanted: new Set(),
      objectSectionsOpen: new Set(),
    });
  }

  function updateGlobalFilter(value: string) {
    setGlobalFilter(value);
  }

  const onSearchResultsChange = useCallback(
    (catalogKey: string, results: CatalogTreeSearchResult[]) => {
      setSearchResultsByCatalog((current) => {
        if (results.length === 0) {
          if (!(catalogKey in current)) return current;
          const next = { ...current };
          delete next[catalogKey];
          return next;
        }
        if (
          current[catalogKey]?.length === results.length &&
          current[catalogKey]?.every((result, index) =>
            result.key === results[index]?.key,
          )
        ) {
          return current;
        }
        return { ...current, [catalogKey]: results };
      });
    },
    [],
  );

  const searchResults = useMemo(
    () => Object.values(searchResultsByCatalog).flat(),
    [searchResultsByCatalog],
  );
  const activeSearchResult = activeSearchResultKey
    ? searchResults.find((result) => result.key === activeSearchResultKey)
    : undefined;

  useEffect(() => {
    if (globalFilter) return;
    setSearchResultsByCatalog({});
    setActiveSearchResultKey(null);
  }, [globalFilter]);

  function moveSearchResult(direction: 1 | -1) {
    if (searchResults.length === 0) return;
    const currentIndex = activeSearchResultKey
      ? searchResults.findIndex(
          (result) => result.key === activeSearchResultKey,
        )
      : -1;
    const nextIndex =
      (currentIndex + direction + searchResults.length) %
      searchResults.length;
    setActiveSearchResultKey(searchResults[nextIndex]?.key ?? null);
  }

  function openExplorerSearch() {
    setSearchOpen(true);
  }

  function closeExplorerSearch() {
    setGlobalFilter("");
    setSearchOpen(false);
    treeKeyboard.restoreFocus();
  }

  const openSelectedConnection = useEffectEvent((id: string) => {
    commands.openConnection(id);
    ensureGroupLoaded(id);
  });

  // Selecting a connection auto-expands it (collapse stays a free action after).
  useEffect(() => {
    if (!selectedId) return;
    openSelectedConnection(selectedId);
  }, [selectedId]);

  // Refresh every database target discovered through this server connection. The
  // database-scoped endpoints are live reads; invalidating their exact prefix replaces
  // relation and detail projections without reusing the legacy configured-database cache.
  async function refreshSchema(id: string) {
    const scopeKey = catalogScope.key;
    commands.patch({ refreshingId: id });
    commands.clearRefreshError(id);
    try {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: qk.connectionDatabases(id, scopeKey),
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["databaseCatalogOverview", id],
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["databaseCatalog", id],
          refetchType: "active",
        }),
      ]);
      if (catalogScopeKeyRef.current !== scopeKey) return;
      commands.want(id);
    } catch (e) {
      if (catalogScopeKeyRef.current !== scopeKey) return;
      commands.setRefreshError(id, errMessage(e));
    } finally {
      if (catalogScopeKeyRef.current === scopeKey) {
        commands.patch({ refreshingId: null });
      }
    }
  }

  async function refreshExplorer() {
    const scopeKey = catalogScope.key;
    try {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: connectionQueryKeys.all(scopeKey),
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: knowledgeQueryKeys.inventory(scopeKey),
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: knowledgeQueryKeys.environmentConnections(),
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: analysisQueryKeys.articles(scopeKey),
          refetchType: "active",
        }),
        selectedId ? refreshSchema(selectedId) : Promise.resolve(),
      ]);
    } catch (error) {
      if (catalogScopeKeyRef.current === scopeKey) {
        toast(errMessage(error), "error");
      }
    }
  }

  async function removeConnection(conn: ConnectionProfile) {
    commands.patch({ deletingId: conn.id });
    try {
      if (conn.workspaceAccess === "manage") {
        await deleteWorkspaceConnection(conn.id);
      } else {
        await deleteConnection(conn.id);
      }
      commands.forget(conn.id);
      forgetConnection(conn.id);
      queryClient.removeQueries({ queryKey: qk.catalog(conn.id, catalogScope.key) });
      queryClient.removeQueries({
        queryKey: qk.catalogOverview(conn.id, catalogScope.key),
      });
      queryClient.removeQueries({
        queryKey: qk.catalogSnapshot(conn.id, catalogScope.key),
      });
      queryClient.removeQueries({
        queryKey: qk.connectionDatabases(conn.id, catalogScope.key),
      });
      queryClient.removeQueries({
        queryKey: ["databaseCatalogOverview", conn.id],
      });
      queryClient.removeQueries({
        queryKey: ["databaseCatalog", conn.id],
      });
      toast(t("connections.connectionDeleted"));
      onDeleted(conn.id);
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      commands.patch({ deletingId: null });
    }
  }

  async function setSchemaScope(
    connection: ConnectionProfile,
    schemas: string[],
  ) {
    if (
      savingScopeId !== null ||
      connection.workspaceAccess === "view"
    ) {
      return;
    }
    setSavingScopeId(connection.id);
    try {
      const extraParams = { ...connection.extraParams };
      if (schemas.length > 0) {
        extraParams[SCHEMA_SCOPE_PARAMETER] = JSON.stringify(schemas);
      } else {
        delete extraParams[SCHEMA_SCOPE_PARAMETER];
      }
      const updated = await upsertConnection({
        ...connection,
        extraParams,
      });
      onConnectionUpdated(updated);
    } catch (error) {
      toast(errMessage(error), "error");
    } finally {
      setSavingScopeId(null);
    }
  }

  function toggleObjectSection(connectionId: string, kind: string) {
    const key = `${connectionId}:${kind}`;
    if (!objectSectionsOpen.has(key)) {
      const separator = kind.indexOf("\u0000");
      const connection = connections.find(
        (candidate) => candidate.id === connectionId,
      );
      const database =
        separator >= 0
          ? kind.slice(0, separator)
          : connection?.database;
      if (database) requestDetails(connectionId, database);
    }
    commands.toggleObjectSection(key);
  }

  function toggleRelationSection(connectionId: string, sectionKey: string) {
    const key = `${connectionId}:${sectionKey}`;
    commands.toggleCollapsedSection(key);
  }

  function renderConnection(
    connection: ConnectionProfile,
    nested = false,
    treeParentKey: string | null = null,
    treeLevel = 1,
  ) {
    const schemaGroup = groupByConnectionId.get(connection.id);
    const openConnectionSchemaDiff =
      schemaGroup && schemaGroup.connections.length > 1
        ? () => {
            for (const member of schemaGroup.connections) {
              ensureLoaded(member.id);
            }
            onOpenSchemaDiff(schemaGroup);
          }
        : undefined;
    return (
      <ConnectionNode
        key={connection.id}
        connection={connection}
        nested={nested}
        selected={connection.id === selectedId}
        selectedTableKey={selectedTableKey}
        expanded={open.has(connection.id) || globalFilter.trim().length > 0}
        draggingId={draggingId}
        dropTarget={dropTarget}
        suppressClickRef={suppressClickRef}
        openMenuId={openMenuId}
        onOpenMenu={(id) => commands.patch({ openMenuId: id })}
        refreshingId={refreshing}
        deletingId={deleting}
        showRowCounts={showRowCounts}
        onShowRowCounts={(show) => commands.patch({ showRowCounts: show })}
        schemaScopeSaving={savingScopeId === connection.id}
        onSetSchemaScope={(schemas) =>
          void setSchemaScope(connection, schemas)
        }
        overview={overviews[connection.id]}
        fullCatalog={catalogs[connection.id]}
        error={errs[connection.id]}
        detailError={detailErrs[connection.id]}
        databases={databasesByConnection[connection.id]}
        databaseOverviews={databaseOverviews}
        databaseCatalogs={databaseCatalogs}
        overviewErrorsByDatabase={overviewErrsByDatabase}
        detailErrorsByDatabase={detailErrsByDatabase}
        treeScrollElement={treeScrollElement}
        filter={globalFilter}
        activeSearchResultKey={activeSearchResultKey}
        onSearchResultsChange={onSearchResultsChange}
        groupByConnectionId={groupByConnectionId}
        catalogs={catalogs}
        collapsedSections={collapsedSections}
        objectSectionsOpen={objectSectionsOpen}
        onPointerDown={pointerDownConnection}
        onPointerMove={pointerMoveConnection}
        onPointerUp={pointerUpConnection}
        onPointerCancel={pointerCancelConnection}
        onToggleOpen={() => toggleOpen(connection.id)}
        onSelect={() => onSelectConn(connection.id)}
        onEdit={() => onEdit(connection)}
        onWorkspaceDialog={(mode) =>
          commands.openWorkspaceDialog({ connection, mode })
        }
        onRefresh={() => void refreshSchema(connection.id)}
        onDelete={() => void removeConnection(connection)}
        onOpenSchemaDiff={openConnectionSchemaDiff}
        onOpenTable={(table) => onOpenTable(connection, table)}
        onRequestDetails={(database) =>
          requestDetails(connection.id, database)
        }
        onRequestOverview={(database) =>
          requestOverview(connection.id, database)
        }
        onForgetOverview={(database) =>
          forgetOverview(connection.id, database)
        }
        onRetryOverview={(database) => {
          commands.clearRefreshError(connection.id);
          void queryClient.refetchQueries({
            queryKey: qk.databaseCatalogOverview(
              connection.id,
              database,
              catalogScope.key,
            ),
            exact: true,
          });
        }}
        onToggleRelationSection={(sectionKey) =>
          toggleRelationSection(connection.id, sectionKey)
        }
        onToggleObjectSection={(kind) =>
          toggleObjectSection(connection.id, kind)
        }
        revealRequest={externalRevealRequest + localRevealRequest}
        revealDatabase={revealDatabase}
        revealNamespace={revealNamespace}
        treeParentKey={treeParentKey}
        treeLevel={treeLevel}
      />
    );
  }

  function renderGroup(group: SchemaConnectionGroup) {
    const isDropTarget =
      dropTarget?.kind === "group" && dropTarget.key === group.key;
    const engine = group.connections[0]?.engine;
    const baseline = defaultSchemaBaseline(group);
    const baselineCatalog = baseline ? catalogs[baseline.id] : undefined;
    const targets = group.connections.filter((connection) => connection.id !== baseline?.id);
    const diffs = baselineCatalog
      ? targets.flatMap((connection) => {
          const catalog = catalogs[connection.id];
          return catalog ? [compareCatalogs(catalog, baselineCatalog)] : [];
        })
      : [];
    const complete = targets.length > 0 && diffs.length === targets.length;
    const groupCounts = diffs.reduce(
      (total, diff) => {
        const counts = diffCounts(diff);
        total.added += counts.added;
        total.missing += counts.missing;
        total.changed += counts.changed;
        return total;
      },
      { added: 0, missing: 0, changed: 0 },
    );
    const groupTotal = groupCounts.added + groupCounts.missing + groupCounts.changed;
    const groupTreeKey = `schema-group:${group.key}`;
    return (
      <div
        key={`group-${group.key}`}
        data-schema-group-key={group.key}
        data-drop-target={isDropTarget}
        className="tw:relative tw:my-1 tw:border-l tw:border-border-strong tw:pt-0 tw:pr-0 tw:pb-1 tw:pl-1 tw:transition-colors tw:data-[drop-target=true]:border-ring tw:data-[drop-target=true]:bg-muted"
      >
        <div
          data-active={activeSchemaGroupKey === group.key}
          className="tw:flex tw:min-h-control-sm tw:items-center tw:gap-1 tw:px-1 tw:text-xs tw:text-muted-foreground tw:data-[active=true]:text-primary"
          title={t("connections.schemaGroupTitle", { group: group.label })}
          role="treeitem"
          aria-level={1}
          aria-selected={activeSchemaGroupKey === group.key}
          data-explorer-tree-item
          data-explorer-tree-key={groupTreeKey}
          tabIndex={-1}
        >
          {engine && <EngineMark engine={engine} size="tree" />}
          <span className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:font-bold tw:text-foreground">
            {group.label}
          </span>
          <button
            type="button"
            className="tw:inline-flex tw:min-h-control-xs tw:min-w-0 tw:cursor-pointer tw:items-center tw:justify-center tw:gap-[2px] tw:rounded-full tw:border tw:border-border-subtle tw:bg-card tw:px-1.5 tw:font-sans tw:text-2xs tw:font-bold tw:whitespace-nowrap tw:text-muted-foreground tw:hover:border-ring tw:hover:text-primary"
            title={t("schemaDiff.openTitle")}
            aria-label={t("schemaDiff.openTitle")}
            data-tree-primary-action
            tabIndex={-1}
            onClick={() => {
              for (const connection of group.connections) ensureLoaded(connection.id);
              onOpenSchemaDiff(group);
            }}
          >
            {!schemaGroupIsCompatible(group) ? (
              <Icon name="alert" />
            ) : complete && groupTotal === 0 ? (
              <Icon name="check" />
            ) : complete ? (
              <span className="tw:inline-flex tw:gap-[2px] tw:font-mono tw:[font-variant-numeric:tabular-nums]">
                {groupCounts.added > 0 ? (
                  <span className="tw:text-success">
                    +{groupCounts.added}
                  </span>
                ) : null}
                {groupCounts.missing > 0 ? (
                  <span className="tw:text-danger">
                    −{groupCounts.missing}
                  </span>
                ) : null}
                {groupCounts.changed > 0 ? (
                  <span className="tw:text-warning">
                    ~{groupCounts.changed}
                  </span>
                ) : null}
              </span>
            ) : (
              <span>{t("schemaDiff.open")}</span>
            )}
          </button>
        </div>
        {group.connections.map((conn) =>
          renderConnection(conn, true, groupTreeKey, 2)
        )}
      </div>
    );
  }

  function toggleExpandedId(
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    id: string,
  ) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderUnavailableBinding(
    binding: EnvironmentConnection,
    treeParentKey: string,
  ) {
    return (
      <button
        key={binding.id}
        type="button"
        className="tw:flex tw:min-h-[var(--ds-tree-row-height)] tw:w-full tw:min-w-0 tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:px-1 tw:py-[var(--ds-tree-row-padding-block)] tw:pl-5 tw:text-left tw:font-sans tw:text-sm tw:text-muted-foreground tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
        onClick={() =>
          onOpenProjectEnvironment(
            binding.projectEnvironmentId,
            "databases",
          )
        }
        title={t("connections.environmentDatabaseUnavailable")}
        role="treeitem"
        aria-level={4}
        data-explorer-tree-item
        data-explorer-tree-key={`binding:${binding.id}`}
        data-explorer-tree-parent-key={treeParentKey}
        data-tree-primary-action
        tabIndex={-1}
      >
        <StatusDot tone="warning" />
        <Icon name="database" className="tw:shrink-0" />
        <span className="tw:min-w-0 tw:flex-1 tw:truncate">
          {binding.alias || binding.connectionName}
        </span>
        <Icon name="alert" className="tw:shrink-0 tw:text-warning" />
      </button>
    );
  }

  function renderEnvironmentResources(environment: KnowledgeEnvironment) {
    const databaseKey = `${environment.id}:databases`;
    const sourceKey = `${environment.id}:sources`;
    const analysisKey = `${environment.id}:analyses`;
    const environmentIndex = projectEnvironmentIds.indexOf(environment.id);
    const bindingQuery = environmentConnections;
    const bindingPhase = queryResultPhase(
      bindingQuery?.data,
      bindingQuery?.error,
    );
    const bindings = environmentConnectionsById.get(environment.id) ?? [];
    const environmentSources = (knowledgeSources.data ?? []).filter(
      (source) => source.projectEnvironmentId === environment.id,
    );
    const databaseExpanded = expandedResourceKeys.has(databaseKey);
    const sourceExpanded = expandedResourceKeys.has(sourceKey);
    const analysisExpanded = expandedResourceKeys.has(analysisKey);
    const analysisQuery = environmentAnalysisQueries[environmentIndex];
    const environmentAnalyses = analysisQuery?.data ?? [];
    const analysisNeedle = analysisFilter.trim().toLocaleLowerCase();
    const visibleEnvironmentAnalyses =
      activeProjectEnvironmentId === environment.id
        ? environmentAnalyses.filter(
            (article) =>
              (analysisStateFilter === "all" ||
                article.state === analysisStateFilter) &&
              (!analysisNeedle ||
                article.definition.title
                  .toLocaleLowerCase()
                  .includes(analysisNeedle) ||
                article.definition.question
                  .toLocaleLowerCase()
                  .includes(analysisNeedle) ||
                article.definition.summary
                  .toLocaleLowerCase()
                  .includes(analysisNeedle)),
          )
        : environmentAnalyses;
    const activeAnalysisIsVisible = visibleEnvironmentAnalyses.some(
      (article) => article.id === activeProjectEnvironmentResourceId,
    );
    const environmentTreeKey = `environment:${environment.id}`;
    const databaseTreeKey = `${environmentTreeKey}:resource:databases`;
    const sourceTreeKey = `${environmentTreeKey}:resource:sources`;
    const analysisTreeKey = `${environmentTreeKey}:resource:analyses`;

    return (
      <div className="tw:grid tw:pl-3">
        <TreeSectionButton
          expanded={databaseExpanded}
          icon="database"
          treeItem={{
            key: databaseTreeKey,
            parentKey: environmentTreeKey,
            level: 3,
          }}
          selected={
            activeProjectEnvironmentId === environment.id &&
            activeProjectEnvironmentView === "databases"
          }
          actions={
            <TreeRowActions>
              <Button
                iconOnly
                size="xs"
                variant="ghost"
                title={t("connections.environmentAddDatabase")}
                aria-label={t("connections.environmentAddDatabase")}
                tabIndex={-1}
                onClick={() => {
                  onOpenProjectEnvironment(environment.id, "databases");
                  onNewConnection();
                }}
              >
                <Icon name="plus" />
              </Button>
            </TreeRowActions>
          }
          onToggle={() => {
            toggleExpandedId(setExpandedResourceKeys, databaseKey);
            onOpenProjectEnvironment(environment.id, "databases");
          }}
        >
          {t("connections.environmentDatabases")}
        </TreeSectionButton>
        {databaseExpanded ? (
          <div className="tw:grid tw:border-l tw:border-border-subtle tw:pl-1">
            {bindingPhase === "coldError" || bindingPhase === "staleError" ? (
              <TreeLoadFailure
                message={t("connections.environmentDatabaseLoadFailed")}
                detail={errMessage(bindingQuery.error)}
                retryLabel={t("app.retry")}
                treeItem={{
                  key: `${databaseTreeKey}:retry`,
                  parentKey: databaseTreeKey,
                  level: 4,
                }}
                onRetry={() => void bindingQuery.refetch()}
              />
            ) : null}
            {bindingPhase === "coldLoading" ? (
              <div className="tw:min-h-control-sm tw:px-2 tw:py-1 tw:text-xs">
                <LoadingLabel>{t("common.loading")}</LoadingLabel>
              </div>
            ) : bindingQuery?.data === undefined ? null : bindings.length > 0 ? (
              bindings.map((binding) => {
                const connection = binding.connectionId
                  ? connections.find(
                      (candidate) => candidate.id === binding.connectionId,
                    )
                  : null;
                return connection
                  ? renderConnection(connection, true, databaseTreeKey, 4)
                  : renderUnavailableBinding(binding, databaseTreeKey);
              })
            ) : (
              <button
                type="button"
                className="tw:min-h-control-sm tw:cursor-pointer tw:border-0 tw:bg-transparent tw:px-5 tw:py-1 tw:text-left tw:font-sans tw:text-xs tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground"
                onClick={() =>
                  onOpenProjectEnvironment(environment.id, "databases")
                }
                role="treeitem"
                aria-level={4}
                data-explorer-tree-item
                data-explorer-tree-key={`${databaseTreeKey}:add`}
                data-explorer-tree-parent-key={databaseTreeKey}
                data-tree-primary-action
                tabIndex={-1}
              >
                {t("connections.environmentAddDatabase")}
              </button>
            )}
          </div>
        ) : null}

        <TreeSectionButton
          expanded={sourceExpanded}
          icon="branch"
          treeItem={{
            key: sourceTreeKey,
            parentKey: environmentTreeKey,
            level: 3,
          }}
          selected={
            activeProjectEnvironmentId === environment.id &&
            activeProjectEnvironmentView === "sources"
          }
          actions={
            <TreeRowActions>
              <Button
                iconOnly
                size="xs"
                variant="ghost"
                title={t("connections.environmentAddSource")}
                aria-label={t("connections.environmentAddSource")}
                tabIndex={-1}
                onClick={() =>
                  onOpenProjectEnvironment(environment.id, "sources")
                }
              >
                <Icon name="plus" />
              </Button>
            </TreeRowActions>
          }
          onToggle={() => {
            toggleExpandedId(setExpandedResourceKeys, sourceKey);
            onOpenProjectEnvironment(environment.id, "sources");
          }}
        >
          {t("connections.environmentDataSources")}
        </TreeSectionButton>
        {sourceExpanded ? (
          <div className="tw:grid tw:border-l tw:border-border-subtle tw:pl-1">
            {knowledgeSourcesPhase === "coldError" || knowledgeSourcesPhase === "staleError" ? (
              <TreeLoadFailure
                message={t("connections.environmentSourceLoadFailed")}
                detail={errMessage(knowledgeSources.error)}
                retryLabel={t("app.retry")}
                treeItem={{
                  key: `${sourceTreeKey}:retry`,
                  parentKey: sourceTreeKey,
                  level: 4,
                }}
                onRetry={() => void knowledgeSources.refetch()}
              />
            ) : null}
            {knowledgeSourcesPhase === "coldLoading" ? (
              <div className="tw:min-h-control-sm tw:px-2 tw:py-1 tw:text-xs">
                <LoadingLabel>{t("common.loading")}</LoadingLabel>
              </div>
            ) : knowledgeSources.data === undefined ? null : environmentSources.length > 0 ? (
              environmentSources.map((source) => (
                <button
                  key={source.sourceId}
                  type="button"
                  className="tw:flex tw:min-h-[var(--ds-tree-row-height)] tw:w-full tw:min-w-0 tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:px-1 tw:py-[var(--ds-tree-row-padding-block)] tw:pl-5 tw:text-left tw:font-sans tw:text-sm tw:text-foreground tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                  onClick={() =>
                    onOpenProjectEnvironment(environment.id, "sources")
                  }
                  title={`${source.provider === "github" ? "GitHub" : t("connections.environmentLocalFolder")} · ${knowledgeRevisionLabel(source.revision, {
                    dirty: t("knowledge.revisionDirty"),
                    snapshot: t("knowledge.revisionSnapshot"),
                  })}`}
                  role="treeitem"
                  aria-level={4}
                  data-explorer-tree-item
                  data-explorer-tree-key={`source:${source.sourceId}`}
                  data-explorer-tree-parent-key={sourceTreeKey}
                  data-tree-primary-action
                  tabIndex={-1}
                >
                  <StatusDot tone={knowledgeSourceTone(source)} />
                  <Icon
                    name={source.provider === "github" ? "branch" : "folder"}
                    className="tw:shrink-0"
                  />
                  <span className="tw:min-w-0 tw:flex-1 tw:truncate">
                    {source.displayName}
                  </span>
                </button>
              ))
            ) : (
              <button
                type="button"
                className="tw:min-h-control-sm tw:cursor-pointer tw:border-0 tw:bg-transparent tw:px-5 tw:py-1 tw:text-left tw:font-sans tw:text-xs tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground"
                onClick={() =>
                  onOpenProjectEnvironment(environment.id, "sources")
                }
                role="treeitem"
                aria-level={4}
                data-explorer-tree-item
                data-explorer-tree-key={`${sourceTreeKey}:add`}
                data-explorer-tree-parent-key={sourceTreeKey}
                data-tree-primary-action
                tabIndex={-1}
              >
                {t("connections.environmentAddSource")}
              </button>
            )}
          </div>
        ) : null}

        <TreeSectionButton
          expanded={analysisExpanded}
          icon="chart"
          treeItem={{
            key: analysisTreeKey,
            parentKey: environmentTreeKey,
            level: 3,
          }}
          selected={
            activeProjectEnvironmentId === environment.id &&
            activeProjectEnvironmentView === "analyses" &&
            !activeAnalysisIsVisible
          }
          onToggle={() => {
            toggleExpandedId(setExpandedResourceKeys, analysisKey);
            onOpenProjectEnvironment(environment.id, "analyses");
          }}
        >
          {t("connections.environmentAnalyses")}
        </TreeSectionButton>
        {analysisExpanded ? (
          <div className="tw:grid tw:border-l tw:border-border-subtle tw:pl-1">
            {sharedKnowledgeWorkspace && analysisQuery?.isPending ? (
              <div className="tw:min-h-control-sm tw:px-2 tw:py-1 tw:text-xs">
                <LoadingLabel>{t("common.loading")}</LoadingLabel>
              </div>
            ) : sharedKnowledgeWorkspace && analysisQuery?.error ? (
              <button
                type="button"
                className="tw:flex tw:min-h-control-sm tw:w-full tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:px-2 tw:py-1 tw:text-left tw:font-sans tw:text-xs tw:text-danger tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                onClick={() => void analysisQuery.refetch()}
                title={errMessage(analysisQuery.error)}
                role="treeitem"
                aria-level={4}
                data-explorer-tree-item
                data-explorer-tree-key={`${analysisTreeKey}:retry`}
                data-explorer-tree-parent-key={analysisTreeKey}
                data-tree-primary-action
                tabIndex={-1}
              >
                <Icon name="alert" className="tw:shrink-0" />
                <span className="tw:min-w-0 tw:flex-1 tw:truncate">
                  {t("connections.environmentAnalysisLoadFailed")}
                </span>
                <span className="tw:shrink-0">{t("app.retry")}</span>
              </button>
            ) : visibleEnvironmentAnalyses.length > 0 ? (
              visibleEnvironmentAnalyses.map((article) => (
                <button
                  key={article.id}
                  type="button"
                  data-selected={
                    activeProjectEnvironmentResourceId === article.id
                  }
                  className="tw:flex tw:min-h-[var(--ds-tree-row-height)] tw:w-full tw:min-w-0 tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:px-1 tw:py-[var(--ds-tree-row-padding-block)] tw:pl-5 tw:text-left tw:font-sans tw:text-sm tw:text-foreground tw:data-[selected=true]:bg-selection tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                  onClick={() =>
                    onOpenProjectEnvironment(
                      environment.id,
                      "analyses",
                      article.id,
                    )
                  }
                  title={article.definition.question}
                  role="treeitem"
                  aria-level={4}
                  aria-selected={
                    activeProjectEnvironmentResourceId === article.id
                  }
                  data-explorer-tree-item
                  data-explorer-tree-key={`analysis:${article.id}`}
                  data-explorer-tree-parent-key={analysisTreeKey}
                  data-tree-primary-action
                  tabIndex={-1}
                >
                  <StatusDot tone={environmentAnalysisTone(article)} />
                  <Icon name="chart" className="tw:shrink-0" />
                  <span className="tw:min-w-0 tw:flex-1 tw:truncate">
                    {article.definition.title}
                  </span>
                </button>
              ))
            ) : (
              <button
                type="button"
                className="tw:min-h-control-sm tw:cursor-pointer tw:border-0 tw:bg-transparent tw:px-5 tw:py-1 tw:text-left tw:font-sans tw:text-xs tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground"
                onClick={() =>
                  onOpenProjectEnvironment(environment.id, "analyses")
                }
                role="treeitem"
                aria-level={4}
                data-explorer-tree-item
                data-explorer-tree-key={`${analysisTreeKey}:empty`}
                data-explorer-tree-parent-key={analysisTreeKey}
                data-tree-primary-action
                tabIndex={-1}
              >
                {environmentAnalyses.length > 0
                  ? t("analysis.noMatch")
                  : t("connections.environmentNoAnalyses")}
              </button>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function renderProject(project: KnowledgeProject) {
    const projectExpanded = expandedProjectIds.has(project.id);
    const activeEnvironmentBelongsToProject = project.environments.some(
      (environment) => environment.id === activeProjectEnvironmentId,
    );
    const projectTreeKey = `project:${project.id}`;
    return (
      <div key={project.id} className="tw:grid">
        <TreeSectionButton
          expanded={projectExpanded}
          icon="folder"
          prominence="project"
          treeItem={{
            key: projectTreeKey,
            parentKey: null,
            level: 1,
          }}
          selected={activeEnvironmentBelongsToProject && !projectExpanded}
          actions={
            <TreeRowActions>
              <Button
                iconOnly
                size="xs"
                variant="ghost"
                title={t("connections.addEnvironment")}
                aria-label={t("connections.addEnvironment")}
                tabIndex={-1}
                onClick={() => setEnvironmentSetupProjectId(project.id)}
              >
                <Icon name="plus" />
              </Button>
            </TreeRowActions>
          }
          onToggle={() => toggleExpandedId(setExpandedProjectIds, project.id)}
        >
          {project.name}
        </TreeSectionButton>
        {projectExpanded ? (
          <div className="tw:grid tw:border-l tw:border-border-strong tw:pl-1">
            {project.environments.map((environment) => {
              const environmentExpanded = expandedEnvironmentIds.has(
                environment.id,
              );
              const environmentTreeKey = `environment:${environment.id}`;
              const isEnvironmentDropTarget =
                dropTarget?.kind === "environment" &&
                dropTarget.id === environment.id;
              return (
                <div
                  key={environment.id}
                  data-knowledge-environment-drop-id={environment.id}
                  data-drop-target={isEnvironmentDropTarget}
                  className="tw:grid tw:border-l tw:border-transparent tw:transition-colors tw:data-[drop-target=true]:border-ring tw:data-[drop-target=true]:bg-muted"
                >
                  <TreeSectionButton
                    expanded={environmentExpanded}
                    icon="folder"
                    treeItem={{
                      key: environmentTreeKey,
                      parentKey: projectTreeKey,
                      level: 2,
                    }}
                    selected={
                      activeProjectEnvironmentId === environment.id &&
                      !environmentExpanded
                    }
                    onToggle={() => {
                      toggleExpandedId(
                        setExpandedEnvironmentIds,
                        environment.id,
                      );
                      onOpenProjectEnvironment(environment.id, "databases");
                    }}
                  >
                    {environment.name}
                  </TreeSectionButton>
                  {environmentExpanded
                    ? renderEnvironmentResources(environment)
                    : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  function handleProjectCreated(project: KnowledgeProject) {
    const environment = project.environments[0] ?? null;
    setExpandedProjectIds((current) => new Set([...current, project.id]));
    if (!environment) return;
    setExpandedEnvironmentIds(
      (current) => new Set([...current, environment.id]),
    );
    setExpandedResourceKeys(
      (current) =>
        new Set([
          ...current,
          `${environment.id}:databases`,
        ]),
    );
    onOpenProjectEnvironment(environment.id, "databases");
  }

  function handleEnvironmentCreated(project: KnowledgeProject) {
    const previousEnvironmentIds = new Set(
      (knowledgeProjects.data ?? [])
        .find((candidate) => candidate.id === project.id)
        ?.environments.map((environment) => environment.id) ?? [],
    );
    const environment =
      project.environments.find(
        (candidate) => !previousEnvironmentIds.has(candidate.id),
      ) ?? project.environments[project.environments.length - 1] ?? null;
    setExpandedProjectIds((current) => new Set([...current, project.id]));
    if (!environment) return;
    setExpandedEnvironmentIds(
      (current) => new Set([...current, environment.id]),
    );
    setExpandedResourceKeys(
      (current) =>
        new Set([...current, `${environment.id}:databases`]),
    );
    onOpenProjectEnvironment(environment.id, "databases");
  }

  function openEnvironmentSetup() {
    const projects = knowledgeProjects.data ?? [];
    const activeProject = projects.find((project) =>
      project.environments.some(
        (environment) => environment.id === activeProjectEnvironmentId,
      ),
    );
    const projectId = activeProject?.id ?? projects[0]?.id ?? null;
    if (projectId) setEnvironmentSetupProjectId(projectId);
  }

  const selectedConnection =
    connections.find((connection) => connection.id === selectedId) ?? null;

  function revealEditorObject() {
    if (!selectedConnection || !selectedTableKey) return;
    setGlobalFilter("");
    setSearchOpen(false);
    commands.openConnection(selectedConnection.id);
    ensureGroupLoaded(selectedConnection.id);
    setLocalRevealRequest((request) => request + 1);
  }

  function renderLaunchButton(
    label: string,
    preset: ConnectionLaunchPreset,
  ) {
    return (
      <ToolWindowAction
        leading={<EngineMark engine={preset.engine ?? "postgres"} />}
        trailing={<Icon name="chevronRight" />}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          onNewConnection(preset);
        }}
      >
        {label}
      </ToolWindowAction>
    );
  }

  return (
    <ToolWindowSideSurface
      compact={compact}
      compactOpen={compactOpen}
      id="workbench-sidebar"
    >
      <div
        className="tw:group tw:flex tw:min-h-control-md tw:shrink-0 tw:items-center tw:gap-[2px] tw:border-b tw:border-border-subtle tw:bg-background tw:px-1"
        role="toolbar"
        aria-label={t("connections.databaseExplorerActions")}
      >
        <Button
          iconOnly
          size="xs"
          variant="ghost"
          disabled={knowledgeProjects.isPending}
          onClick={() => setProjectSetupOpen(true)}
          title={t("connections.addProject")}
          aria-label={t("connections.addProject")}
        >
          <Icon name="folderPlus" />
        </Button>
        <Button
          iconOnly
          size="xs"
          variant="ghost"
          disabled={
            knowledgeProjects.isPending ||
            (knowledgeProjects.data?.length ?? 0) === 0
          }
          onClick={openEnvironmentSetup}
          title={t("connections.addEnvironment")}
          aria-label={t("connections.addEnvironment")}
        >
          <Icon name="plus" />
        </Button>
        <Button
          iconOnly
          size="xs"
          variant="ghost"
          disabled={
            knowledgeProjects.isFetching ||
            knowledgeSources.isFetching ||
            refreshing !== null
          }
          onClick={() => void refreshExplorer()}
          title={t("connections.refreshExplorer")}
          aria-label={t("connections.refreshExplorer")}
        >
          <Icon name="refresh" />
        </Button>
        <Button
          iconOnly
          size="xs"
          variant="ghost"
          active={searchOpen}
          disabled={connections.length === 0}
          onClick={openExplorerSearch}
          title={t("connections.searchLoadedObjects")}
          aria-label={t("connections.searchLoadedObjects")}
          aria-pressed={searchOpen}
        >
          <Icon name="search" />
        </Button>
        <ToolbarMenu
          icon="view"
          label={t("connections.viewOptions")}
        >
          <ToolbarMenuItem
            icon="target"
            disabled={!selectedTableKey}
            onClick={revealEditorObject}
          >
            {t("connections.scrollFromEditor")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="chevronsRight"
            disabled={
              connections.length === 0 &&
              (knowledgeProjects.data?.length ?? 0) === 0
            }
            onClick={expandAllConnections}
          >
            {t("connections.expandAll")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="chevronsLeft"
            disabled={
              open.size === 0 &&
              expandedProjectIds.size === 0 &&
              expandedEnvironmentIds.size === 0 &&
              expandedResourceKeys.size === 0
            }
            onClick={collapseAllConnections}
          >
            {t("connections.collapseAll")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="search"
            disabled={connections.length === 0}
            onClick={openExplorerSearch}
          >
            {t("connections.filterTables")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon={showRowCounts ? "check" : "list"}
            onClick={() =>
              commands.patch({ showRowCounts: !showRowCounts })
            }
          >
            {t("connections.showRowCounts")}
          </ToolbarMenuItem>
        </ToolbarMenu>
        <span className="tw:pointer-events-none tw:ml-auto tw:opacity-0 tw:transition-opacity tw:group-hover:pointer-events-auto tw:group-hover:opacity-100 tw:group-focus-within:pointer-events-auto tw:group-focus-within:opacity-100">
          <ToolWindowHideButton
            label={t("common.close")}
            onClick={onClose}
          />
        </span>
      </div>
      {workspaceHeader}
      {connections.length > 0 && searchOpen ? (
        <ToolWindowSearchRow>
          <div className="tw:min-w-0 tw:flex-1">
            <TreeSearch
              value={globalFilter}
              placeholder={t("connections.filterLoadedObjectsPlaceholder")}
              clearLabel={t("common.close")}
              onChange={updateGlobalFilter}
              autoFocus
              onEscape={() => {
                if (globalFilter) {
                  setGlobalFilter("");
                  return;
                }
                closeExplorerSearch();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveSearchResult(1);
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveSearchResult(-1);
                }
                if (event.key === "Enter" && activeSearchResult) {
                  event.preventDefault();
                  if (
                    activeSearchResult.kind === "relation" &&
                    activeSearchResult.table
                  ) {
                    const connection = connections.find(
                      (candidate) =>
                        candidate.id === activeSearchResult.connectionId,
                    );
                    if (connection) {
                      onOpenTable(
                        {
                          ...connection,
                          database: activeSearchResult.database,
                        },
                        activeSearchResult.table,
                      );
                    }
                  } else {
                    treeKeyboard.focusKey(activeSearchResult.treeKey);
                  }
                }
              }}
            />
          </div>
          {globalFilter ? (
            <span
              className="tw:shrink-0 tw:px-1 tw:text-2xs tw:text-muted-foreground"
              aria-live="polite"
            >
              {t("connections.filterResultCount", {
                count: searchResults.length,
              })}
            </span>
          ) : null}
        </ToolWindowSearchRow>
      ) : activeProjectEnvironmentId &&
        activeProjectEnvironmentView === "analyses" ? (
        <ToolWindowSearchRow>
          <div className="tw:min-w-0 tw:flex-1">
            <TreeSearch
              value={analysisFilter}
              placeholder={t("analysis.filterPlaceholder")}
              clearLabel={t("common.close")}
              onChange={setAnalysisFilter}
              onEscape={() => setAnalysisFilter("")}
            />
          </div>
          <div className="tw:w-[112px] tw:shrink-0">
            <SelectInput
              density="compact"
              aria-label={t("analysis.stateFilterLabel")}
              value={analysisStateFilter}
              onChange={(event) =>
                setAnalysisStateFilter(
                  event.target.value as "all" | AnalysisArticleState,
                )
              }
            >
              <option value="all">{t("analysis.filterAll")}</option>
              <option value="draft">{t("analysis.stateDraft")}</option>
              <option value="review">{t("analysis.stateReview")}</option>
              <option value="live">{t("analysis.stateLive")}</option>
              <option value="archived">{t("analysis.stateArchived")}</option>
            </SelectInput>
          </div>
        </ToolWindowSearchRow>
      ) : null}

      <div
        ref={setTreeScrollElement}
        data-catalog-tree-scroll
        className="tw:min-h-0 tw:flex-1 tw:overflow-x-hidden tw:overflow-y-auto tw:p-1 tw:[container-name:db-sidebar] tw:[container-type:inline-size]"
      >
        {knowledgeEnabled && knowledgeProjects.isPending ? (
          <div className="tw:min-h-control-md tw:px-2 tw:py-1 tw:text-xs">
            <LoadingLabel>{t("connections.loadingProjects")}</LoadingLabel>
          </div>
        ) : null}
        {knowledgeEnabled && knowledgeProjects.error ? (
          <p
            className="tw:m-0 tw:px-2 tw:py-1 tw:text-xs tw:text-danger"
            role="alert"
          >
            {errMessage(knowledgeProjects.error)}
          </p>
        ) : null}
        {knowledgeEnabled &&
        knowledgeProjects.isSuccess &&
        (knowledgeProjects.data?.length ?? 0) === 0 ? (
          <div className="tw:px-2 tw:py-3">
            <p className="tw:m-0 tw:text-xs tw:leading-relaxed tw:text-muted-foreground">
              {t("connections.projectSetupDescription")}
            </p>
          </div>
        ) : null}
        {connections.length === 0 ? (
          <div className="tw:grid tw:gap-5 tw:p-3">
            <ToolWindowSection title={t("connections.createDataSource")}>
              {renderLaunchButton("PostgreSQL", {
                engine: "postgres",
                source: "standard",
              })}
              {renderLaunchButton("MySQL / MariaDB", {
                engine: "mysql",
                source: "standard",
              })}
              {renderLaunchButton("SQLite", {
                engine: "sqlite",
                provider: "generic",
                source: "standard",
              })}
              {renderLaunchButton("MongoDB", {
                engine: "mongodb",
                source: "standard",
              })}
              <ToolWindowAction
                leading={<Icon name="moreVertical" />}
                trailing={<Icon name="chevronRight" />}
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  onNewConnection();
                }}
              >
                {t("connections.allDataSources")}
              </ToolWindowAction>
            </ToolWindowSection>

            <ToolWindowSection
              title={t("connections.dataSourceFromCloudProvider")}
            >
              <ToolWindowAction
                leading={<Icon name="key" />}
                trailing={<Icon name="chevronRight" />}
                onClick={() =>
                  openProviderCredentials("gcpCloudSql")
                }
              >
                {t("connections.providerGcpCloudSql")}
              </ToolWindowAction>
            </ToolWindowSection>

            <ToolWindowSection title={t("connections.sampleDatabase")}>
              <ToolWindowAction
                leading={<EngineMark engine="sqlite" />}
                trailing={<Icon name="download" />}
                disabled={creatingDemo}
                onClick={onCreateDemoDatabase}
              >
                {creatingDemo
                  ? t("connections.demoCreating")
                  : t("connections.demoSqlite")}
              </ToolWindowAction>
            </ToolWindowSection>
          </div>
        ) : null}
        <div
          ref={treeRootRef}
          role="tree"
          aria-label={t("connections.databaseExplorer")}
          onFocusCapture={treeKeyboard.onFocusCapture}
          onKeyDown={treeKeyboard.onKeyDown}
        >
          {knowledgeProjects.data?.map(renderProject)}
          {knowledgeEnabled &&
          (knowledgeProjects.data?.length ?? 0) > 0 &&
          unassignedSections.length > 0 ? (
            <div className="tw:grid tw:pt-1">
              <TreeSectionButton
                expanded={expandedResourceKeys.has("unassigned")}
                icon="folder"
                treeItem={{
                  key: "resource:unassigned",
                  parentKey: null,
                  level: 1,
                }}
                onToggle={() =>
                  toggleExpandedId(setExpandedResourceKeys, "unassigned")
                }
              >
                {t("connections.unassigned")}
              </TreeSectionButton>
              {expandedResourceKeys.has("unassigned") ? (
                <div className="tw:grid tw:border-l tw:border-border-subtle tw:pl-1">
                  {unassignedSections.map((section) =>
                    section.kind === "group"
                      ? renderGroup(section.group)
                      : renderConnection(
                          section.connection,
                          true,
                          "resource:unassigned",
                          2,
                        ),
                  )}
                </div>
              ) : null}
            </div>
          ) : !knowledgeEnabled ? (
            unassignedSections.map((section) =>
              section.kind === "group"
                ? renderGroup(section.group)
                : renderConnection(section.connection),
            )
          ) : null}
        </div>
      </div>

      {workspaceAccount ? (
        <div className="ds-control-row tw:flex tw:min-w-0 tw:shrink-0 tw:items-center tw:gap-2 tw:border-t tw:border-border-subtle tw:bg-background tw:p-2">
          {workspaceAccount}
        </div>
      ) : null}

      {projectSetupOpen ? (
        <ProjectSetupDialog
          catalogScopeKey={catalogScope.key}
          onClose={() => setProjectSetupOpen(false)}
          onCreated={handleProjectCreated}
        />
      ) : null}

      {environmentSetupProjectId ? (
        <EnvironmentSetupDialog
          projects={knowledgeProjects.data ?? []}
          preferredProjectId={environmentSetupProjectId}
          catalogScopeKey={catalogScope.key}
          onClose={() => setEnvironmentSetupProjectId(null)}
          onCreated={handleEnvironmentCreated}
        />
      ) : null}

      {dragPreview &&
        (() => {
          const conn =
            connections.find((connection) => connection.id === dragPreview.id) ??
            null;
          if (!conn) return null;
          return (
            <div
              className="tw:pointer-events-none tw:fixed tw:top-0 tw:left-0 tw:z-[var(--ds-z-popover)] tw:inline-flex tw:max-w-[min(280px,70vw)] tw:items-center tw:gap-2 tw:rounded-sm tw:border tw:border-border-strong tw:bg-popover tw:p-2 tw:text-ui tw:font-semibold tw:text-popover-foreground tw:shadow-popover"
              style={{
                transform: `translate3d(${Math.round(dragPreview.x + 12)}px, ${Math.round(dragPreview.y + 12)}px, 0)`,
              }}
            >
              <EngineMark engine={conn.engine} />
              <span className="tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
                {conn.name || t("app.unnamed")}
              </span>
            </div>
          );
        })()}

      {ddlDialog && (
        <DdlModal
          connection={ddlDialog.connection}
          table={ddlDialog.table}
          onClose={() => commands.patch({ ddlDialog: null })}
        />
      )}
      {workspaceDialog ? (
        <WorkspaceConnectionDialog
          connection={workspaceDialog.connection}
          mode={workspaceDialog.mode}
          onBound={onConnectionUpdated}
          onClose={() => commands.patch({ workspaceDialog: null })}
        />
      ) : null}
      {providerCredentialsOpen ? (
        <ProviderCredentialDialog
          initialProvider={providerCredentialsOpen}
          onClose={() => setProviderCredentialsOpen(null)}
          returnFocusRef={providerReturnFocusRef}
        />
      ) : null}
    </ToolWindowSideSurface>
  );
}
