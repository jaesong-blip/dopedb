// DopeDB-style Database Explorer sidebar: connection tree, DDL modal, schema-group
// drag-and-drop. Split out of the old Connections/index.tsx (see ConnectionForm.tsx
// for the connection create/edit form that used to live alongside it).
import {
  useEffect,
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
import type { ProviderKind } from "../../features/providers/domain";
import type {
  EnvironmentConnection,
  FunnelAnalysisArtifact,
  KnowledgeEnvironment,
  KnowledgeEnvironmentView,
  KnowledgeProject,
  KnowledgeSource,
} from "../../features/knowledge/domain";
import {
  listKnowledgeEnvironmentConnections,
  listFunnelAnalysisArtifacts,
  listKnowledgeProjects,
  listKnowledgeSources,
  onKnowledgeSourceChanged,
} from "../../features/knowledge/tauriAdapter";
import { EnvironmentSetupDialog } from "../../features/knowledge/components/EnvironmentSetupDialog";
import { ProjectSetupDialog } from "../../features/knowledge/components/ProjectSetupDialog";
import {
  knowledgeEnvironmentBadge,
  knowledgeRevisionLabel,
} from "../../features/knowledge/presentation";
import { useCatalogExplorerState } from "../../features/catalogExplorer/state";
import { useSchemaGroupDrag } from "../../features/catalogExplorer/useSchemaGroupDrag";
import {
  qk,
  useCatalogScope,
} from "../../lib/queries";
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
import { EnvironmentBadge } from "../../design-system/components/EnvironmentBadge";
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
import WorkspaceConnectionDialog from "../../features/workspaces/components/WorkspaceConnectionDialog";
import { deleteWorkspaceConnection } from "../../features/workspaces/tauriAdapter";
import { useToast } from "../../components/Toast";
import { useI18n } from "../../lib/i18n";
import ConnectionNode from "./ConnectionNode";
import DdlModal from "./DdlModal";
import { useCatalogTree } from "./useCatalogTree";

function knowledgeSourceTone(source: KnowledgeSource): StatusTone {
  if (source.health === "ready") return "success";
  if (source.health === "failed") return "danger";
  return "warning";
}

function environmentDashboardTone(
  dashboard: FunnelAnalysisArtifact,
): StatusTone {
  if (dashboard.state === "published") return "success";
  if (dashboard.state === "draft") return "warning";
  return "neutral";
}

// DopeDB-style Database Explorer: connections in the sidebar, the selected one
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
  const catalogScopeKeyRef = useRef(catalogScope.key);
  const knowledgeEnabled =
    catalogScope.ready &&
    catalogScope.accountScope !== null;
  const sharedKnowledgeWorkspace =
    knowledgeEnabled && catalogScope.accountScope !== "personal";
  const knowledgeProjects = useQuery({
    queryKey: ["knowledge", "projects", catalogScope.key],
    queryFn: listKnowledgeProjects,
    enabled: knowledgeEnabled,
    retry: false,
  });
  const knowledgeSources = useQuery({
    queryKey: ["knowledge", "sources", catalogScope.key],
    queryFn: listKnowledgeSources,
    enabled: knowledgeEnabled,
    retry: false,
  });
  const projectEnvironmentIds = useMemo(
    () =>
      (knowledgeProjects.data ?? []).flatMap((project) =>
        project.environments.map((environment) => environment.id),
      ),
    [knowledgeProjects.data],
  );
  const environmentConnectionQueries = useQueries({
    queries: projectEnvironmentIds.map((environmentId) => ({
      queryKey: [
        "knowledge",
        "environment-connections",
        environmentId,
        catalogScope.key,
      ],
      queryFn: () => listKnowledgeEnvironmentConnections(environmentId),
      enabled: knowledgeEnabled,
      retry: false,
    })),
  });
  const [globalFilter, setGlobalFilter] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
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
  const environmentDashboardQueries = useQueries({
    queries: projectEnvironmentIds.map((environmentId) => ({
      queryKey: [
        "knowledge",
        "funnel-analysis",
        environmentId,
        catalogScope.key,
      ],
      queryFn: () => listFunnelAnalysisArtifacts(environmentId),
      enabled:
        sharedKnowledgeWorkspace &&
        expandedResourceKeys.has(`${environmentId}:dashboards`),
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
      void queryClient.invalidateQueries({ queryKey: ["knowledge", "sources"] });
      void queryClient.invalidateQueries({
        queryKey: ["agentKnowledgeEnvironments"],
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
  projectEnvironmentIds.forEach((environmentId, index) => {
    environmentConnectionsById.set(
      environmentId,
      environmentConnectionQueries[index]?.data ?? [],
    );
  });
  const environmentBindingsReady =
    environmentConnectionQueries.length === projectEnvironmentIds.length &&
    environmentConnectionQueries.every((query) => query.isSuccess);
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
  } = useSchemaGroupDrag(connections, onConnectionUpdated);

  useEffect(() => {
    if (!openMenuId) return;
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".db-menu")) return;
      commands.patch({ openMenuId: null });
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
          `${environmentId}:dashboards`,
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

  // Selecting a connection auto-expands it (collapse stays a free action after).
  useEffect(() => {
    if (!selectedId) return;
    commands.openConnection(selectedId);
    ensureGroupLoaded(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          queryKey: ["connections", scopeKey],
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["knowledge", "projects", scopeKey],
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["knowledge", "sources", scopeKey],
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["knowledge", "environment-connections"],
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["knowledge", "funnel-analysis"],
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

  function renderConnection(connection: ConnectionProfile, nested = false) {
    return (
      <ConnectionNode
        key={connection.id}
        connection={connection}
        nested={nested}
        selected={connection.id === selectedId}
        selectedTableKey={selectedTableKey}
        expanded={open.has(connection.id)}
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
        {group.connections.map((conn) => renderConnection(conn, true))}
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

  function renderUnavailableBinding(binding: EnvironmentConnection) {
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
    const dashboardKey = `${environment.id}:dashboards`;
    const environmentIndex = projectEnvironmentIds.indexOf(environment.id);
    const bindings = environmentConnectionsById.get(environment.id) ?? [];
    const environmentSources = (knowledgeSources.data ?? []).filter(
      (source) => source.projectEnvironmentId === environment.id,
    );
    const databaseExpanded = expandedResourceKeys.has(databaseKey);
    const sourceExpanded = expandedResourceKeys.has(sourceKey);
    const dashboardExpanded = expandedResourceKeys.has(dashboardKey);
    const dashboardQuery = environmentDashboardQueries[environmentIndex];
    const environmentDashboards = dashboardQuery?.data ?? [];
    const activeDashboardIsVisible = environmentDashboards.some(
      (dashboard) => dashboard.id === activeProjectEnvironmentResourceId,
    );

    return (
      <div className="tw:grid tw:pl-3">
        <TreeSectionButton
          expanded={databaseExpanded}
          icon="database"
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
            {environmentConnectionQueries[environmentIndex]?.isPending ? (
              <div className="tw:min-h-control-sm tw:px-2 tw:py-1 tw:text-xs">
                <LoadingLabel>{t("common.loading")}</LoadingLabel>
              </div>
            ) : bindings.length > 0 ? (
              bindings.map((binding) => {
                const connection = binding.connectionId
                  ? connections.find(
                      (candidate) => candidate.id === binding.connectionId,
                    )
                  : null;
                return connection
                  ? renderConnection(connection, true)
                  : renderUnavailableBinding(binding);
              })
            ) : (
              <button
                type="button"
                className="tw:min-h-control-sm tw:cursor-pointer tw:border-0 tw:bg-transparent tw:px-5 tw:py-1 tw:text-left tw:font-sans tw:text-xs tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground"
                onClick={() =>
                  onOpenProjectEnvironment(environment.id, "databases")
                }
              >
                {t("connections.environmentAddDatabase")}
              </button>
            )}
          </div>
        ) : null}

        <TreeSectionButton
          expanded={sourceExpanded}
          icon="branch"
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
            {knowledgeSources.isPending ? (
              <div className="tw:min-h-control-sm tw:px-2 tw:py-1 tw:text-xs">
                <LoadingLabel>{t("common.loading")}</LoadingLabel>
              </div>
            ) : environmentSources.length > 0 ? (
              environmentSources.map((source) => (
                <button
                  key={source.sourceId}
                  type="button"
                  className="tw:flex tw:min-h-[var(--ds-tree-row-height)] tw:w-full tw:min-w-0 tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:px-1 tw:py-[var(--ds-tree-row-padding-block)] tw:pl-5 tw:text-left tw:font-sans tw:text-sm tw:text-foreground tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                  onClick={() =>
                    onOpenProjectEnvironment(environment.id, "sources")
                  }
                  title={`${source.provider === "github" ? "GitHub" : t("connections.environmentLocalFolder")} · ${knowledgeRevisionLabel(source.revision)}`}
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
              >
                {t("connections.environmentAddSource")}
              </button>
            )}
          </div>
        ) : null}

        <TreeSectionButton
          expanded={dashboardExpanded}
          icon="chart"
          selected={
            activeProjectEnvironmentId === environment.id &&
            activeProjectEnvironmentView === "dashboards" &&
            !activeDashboardIsVisible
          }
          onToggle={() => {
            toggleExpandedId(setExpandedResourceKeys, dashboardKey);
            onOpenProjectEnvironment(environment.id, "dashboards");
          }}
        >
          {t("connections.environmentDashboards")}
        </TreeSectionButton>
        {dashboardExpanded ? (
          <div className="tw:grid tw:border-l tw:border-border-subtle tw:pl-1">
            {sharedKnowledgeWorkspace && dashboardQuery?.isPending ? (
              <div className="tw:min-h-control-sm tw:px-2 tw:py-1 tw:text-xs">
                <LoadingLabel>{t("common.loading")}</LoadingLabel>
              </div>
            ) : sharedKnowledgeWorkspace && dashboardQuery?.error ? (
              <button
                type="button"
                className="tw:flex tw:min-h-control-sm tw:w-full tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:px-2 tw:py-1 tw:text-left tw:font-sans tw:text-xs tw:text-danger tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                onClick={() => void dashboardQuery.refetch()}
                title={errMessage(dashboardQuery.error)}
              >
                <Icon name="alert" className="tw:shrink-0" />
                <span className="tw:min-w-0 tw:flex-1 tw:truncate">
                  {t("connections.environmentDashboardLoadFailed")}
                </span>
                <span className="tw:shrink-0">{t("app.retry")}</span>
              </button>
            ) : environmentDashboards.length > 0 ? (
              environmentDashboards.map((dashboard) => (
                <button
                  key={dashboard.id}
                  type="button"
                  data-selected={
                    activeProjectEnvironmentResourceId === dashboard.id
                  }
                  className="tw:flex tw:min-h-[var(--ds-tree-row-height)] tw:w-full tw:min-w-0 tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:px-1 tw:py-[var(--ds-tree-row-padding-block)] tw:pl-5 tw:text-left tw:font-sans tw:text-sm tw:text-foreground tw:data-[selected=true]:bg-selection tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                  onClick={() =>
                    onOpenProjectEnvironment(
                      environment.id,
                      "dashboards",
                      dashboard.id,
                    )
                  }
                  title={dashboard.question}
                >
                  <StatusDot tone={environmentDashboardTone(dashboard)} />
                  <Icon name="chart" className="tw:shrink-0" />
                  <span className="tw:min-w-0 tw:flex-1 tw:truncate">
                    {dashboard.title}
                  </span>
                </button>
              ))
            ) : (
              <button
                type="button"
                className="tw:min-h-control-sm tw:cursor-pointer tw:border-0 tw:bg-transparent tw:px-5 tw:py-1 tw:text-left tw:font-sans tw:text-xs tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground"
                onClick={() =>
                  onOpenProjectEnvironment(environment.id, "dashboards")
                }
              >
                {t("connections.environmentNoDashboards")}
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
    return (
      <div key={project.id} className="tw:grid">
        <TreeSectionButton
          expanded={projectExpanded}
          icon="folder"
          prominence="project"
          selected={activeEnvironmentBelongsToProject && !projectExpanded}
          actions={
            <TreeRowActions>
              <Button
                iconOnly
                size="xs"
                variant="ghost"
                title={t("connections.addEnvironment")}
                aria-label={t("connections.addEnvironment")}
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
              return (
                <div key={environment.id} className="tw:grid">
                  <TreeSectionButton
                    expanded={environmentExpanded}
                    icon="folder"
                    selected={
                      activeProjectEnvironmentId === environment.id &&
                      !environmentExpanded
                    }
                    trailing={
                      <EnvironmentBadge
                        environment={knowledgeEnvironmentBadge(
                          environment.riskClass,
                        )}
                      />
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
            onClick={() => setSearchOpen(true)}
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
              placeholder={t("connections.filterTables")}
              clearLabel={t("common.close")}
              onChange={updateGlobalFilter}
              autoFocus
              onEscape={() => {
                setGlobalFilter("");
                setSearchOpen(false);
              }}
            />
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
        {knowledgeProjects.data?.map(renderProject)}

        {connections.length === 0 && !knowledgeEnabled ? (
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
                onClick={() => openProviderCredentials("neon")}
              >
                {t("connections.providerNeon")}
              </ToolWindowAction>
              <ToolWindowAction
                leading={<Icon name="key" />}
                trailing={<Icon name="chevronRight" />}
                onClick={() =>
                  openProviderCredentials("gcpCloudSql")
                }
              >
                {t("connections.providerGcpCloudSql")}
              </ToolWindowAction>
              <ToolWindowAction
                leading={<Icon name="key" />}
                trailing={<Icon name="chevronRight" />}
                onClick={() =>
                  openProviderCredentials("planetScale")
                }
              >
                {t("connections.providerPlanetScale")}
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
        {knowledgeEnabled &&
        (knowledgeProjects.data?.length ?? 0) > 0 &&
        unassignedSections.length > 0 ? (
          <div className="tw:grid tw:pt-1">
            <TreeSectionButton
              expanded={expandedResourceKeys.has("unassigned")}
              icon="folder"
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
                    : renderConnection(section.connection, true),
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
          returnFocus={() => providerReturnFocusRef.current?.focus()}
        />
      ) : null}
    </ToolWindowSideSurface>
  );
}
