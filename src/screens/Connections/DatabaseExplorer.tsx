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
import { useQueryClient } from "@tanstack/react-query";
import type { CatalogTable } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import type { ConnectionLaunchPreset } from "../../features/connections/presets";
import { deleteConnection } from "../../features/connections/tauriAdapter";
import { ProviderCredentialDialog } from "../../features/providers/ProviderCredentialDialog";
import type { ProviderKind } from "../../features/providers/domain";
import { useCatalogExplorerState } from "../../features/catalogExplorer/state";
import { useSchemaGroupDrag } from "../../features/catalogExplorer/useSchemaGroupDrag";
import {
  fetchFreshCatalog,
  qk,
  replaceFreshCatalog,
  useCatalogScope,
} from "../../lib/queries";
import {
  compareCatalogs,
  defaultSchemaBaseline,
  diffCounts,
  schemaGroupIsCompatible,
  type SchemaConnectionGroup,
} from "../../lib/schemaDiff";
import EngineMark from "../../components/EngineMark";
import { Icon } from "../../components/Icon";
import {
  ToolWindowAction,
  ToolWindowHeader,
  ToolWindowSection,
} from "../../design-system/components/ToolWindow";
import { TreeSearch } from "../../design-system/components/TreeControls";
import WorkspaceConnectionDialog from "../../features/workspaces/components/WorkspaceConnectionDialog";
import { useToast } from "../../components/Toast";
import { useI18n } from "../../lib/i18n";
import ConnectionNode from "./ConnectionNode";
import DdlModal from "./DdlModal";
import { useCatalogTree } from "./useCatalogTree";

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
  onCreateDemoDatabase,
  creatingDemo = false,
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
  onCreateDemoDatabase: () => void;
  creatingDemo?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const catalogScope = useCatalogScope();
  const catalogScopeKeyRef = useRef(catalogScope.key);
  const [globalFilter, setGlobalFilter] = useState("");
  const [providerCredentialsOpen, setProviderCredentialsOpen] =
    useState<ProviderKind | null>(null);
  const providerReturnFocusRef = useRef<HTMLElement | null>(null);
  const {
    state: {
      wanted,
      refreshErrors: refreshErrs,
      filters,
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

  function openProviderCredentials(provider: ProviderKind) {
    providerReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setProviderCredentialsOpen(provider);
  }
  const {
    sections,
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

  const wantedIds = useMemo(() => [...wanted].sort(), [wanted]);
  const { overviews, overviewErrs, catalogs, detailErrs, requestDetails, forgetDetails } =
    useCatalogTree(wantedIds, catalogScope);
  const errs = { ...overviewErrs, ...refreshErrs };

  // Expanding a node subscribes to its catalog; the query cache decides whether that is a
  // fetch or a free read. Retries are not automatic (see the query defaults), so a node
  // that failed refetches when the user expands it again.
  function ensureLoaded(id: string) {
    commands.want(id);
    commands.clearRefreshError(id);
    if (
      queryClient.getQueryState(qk.catalogOverview(id, catalogScope.key))?.status === "error"
    ) {
      void queryClient.refetchQueries({ queryKey: qk.catalogOverview(id, catalogScope.key) });
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
    if (willOpen) ensureGroupLoaded(id);
  }

  function updateGlobalFilter(value: string) {
    if (!globalFilter.trim() && value.trim()) {
      for (const connection of connections) {
        commands.openConnection(connection.id);
        ensureGroupLoaded(connection.id);
      }
    }
    setGlobalFilter(value);
  }

  // Selecting a connection auto-expands it (collapse stays a free action after).
  useEffect(() => {
    if (!selectedId) return;
    commands.openConnection(selectedId);
    ensureGroupLoaded(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Force a live re-introspection — the schema cache is written once and never
  // expires, so a table list can go stale (e.g. tables added after first connect).
  // Writing the result into the shared cache updates every surface reading this catalog.
  async function refreshSchema(id: string) {
    const scopeKey = catalogScope.key;
    commands.patch({ refreshingId: id });
    commands.clearRefreshError(id);
    try {
      const catalog = await fetchFreshCatalog(id);
      if (catalogScopeKeyRef.current !== scopeKey) return;
      await replaceFreshCatalog(queryClient, id, scopeKey, catalog);
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

  async function removeConnection(conn: ConnectionProfile) {
    commands.patch({ deletingId: conn.id });
    try {
      await deleteConnection(conn.id);
      commands.forget(conn.id);
      forgetDetails(conn.id);
      queryClient.removeQueries({ queryKey: qk.catalog(conn.id, catalogScope.key) });
      queryClient.removeQueries({
        queryKey: qk.catalogOverview(conn.id, catalogScope.key),
      });
      queryClient.removeQueries({
        queryKey: qk.catalogSnapshot(conn.id, catalogScope.key),
      });
      toast(t("connections.connectionDeleted"));
      onDeleted(conn.id);
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      commands.patch({ deletingId: null });
    }
  }

  function toggleObjectSection(connectionId: string, kind: string) {
    const key = `${connectionId}:${kind}`;
    if (!objectSectionsOpen.has(key)) requestDetails(connectionId);
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
        overview={overviews[connection.id]}
        fullCatalog={catalogs[connection.id]}
        error={errs[connection.id]}
        detailError={detailErrs[connection.id]}
        filter={globalFilter || filters[connection.id] || ""}
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
        onFilter={(value) => commands.filter(connection.id, value)}
        onOpenTable={(table) => onOpenTable(connection, table)}
        onShowDdl={(table) =>
          commands.openDdlDialog({ connection, table })
        }
        onRequestDetails={() => requestDetails(connection.id)}
        onRetryOverview={() => {
          commands.clearRefreshError(connection.id);
          void queryClient.refetchQueries({
            queryKey: qk.catalogOverview(connection.id, catalogScope.key),
            exact: true,
          });
        }}
        onToggleRelationSection={(sectionKey) =>
          toggleRelationSection(connection.id, sectionKey)
        }
        onToggleObjectSection={(kind) =>
          toggleObjectSection(connection.id, kind)
        }
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
          {engine && <EngineMark engine={engine} />}
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

  function renderLaunchButton(
    label: string,
    preset: ConnectionLaunchPreset,
  ) {
    return (
      <ToolWindowAction
        leading={<EngineMark engine={preset.engine ?? "postgres"} />}
        trailing={<Icon name="chevronRight" />}
        onClick={() => onNewConnection(preset)}
      >
        {label}
      </ToolWindowAction>
    );
  }

  return (
    <aside
      className="sidebar tw:my-1 tw:ml-1 tw:flex tw:h-[calc(100%_-_(var(--ds-space-1)*2))] tw:w-[calc(100%_-_var(--ds-space-1))] tw:flex-col tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background"
      id="workbench-sidebar"
    >
      <ToolWindowHeader
        title={t("connections.databaseExplorer")}
        actions={
          <>
          <button
            type="button"
            className="btn small icon-only icon-xs"
            onClick={() => onNewConnection()}
            title={t("connections.new")}
            aria-label={t("connections.new")}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="btn small icon-only icon-xs"
            disabled={!selectedId}
            onClick={() => selectedId && void refreshSchema(selectedId)}
            title={t("connections.refreshSchema")}
            aria-label={t("connections.refreshSchema")}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="btn small icon-only icon-xs"
            disabled={!selectedId || !open.has(selectedId)}
            onClick={() => selectedId && commands.toggleConnection(selectedId)}
            title={t("connections.collapse")}
            aria-label={t("connections.collapse")}
          >
            <Icon name="chevronsLeft" />
          </button>
          </>
        }
      />
      {workspaceHeader}
      {connections.length > 0 ? (
        <div className="tw:border-b tw:border-border-subtle tw:p-2">
          <TreeSearch
            value={globalFilter}
            placeholder={t("connections.filterTables")}
            clearLabel={t("common.close")}
            onChange={updateGlobalFilter}
          />
        </div>
      ) : null}

      <div className="explorer tw:min-h-0 tw:flex-1 tw:overflow-x-hidden tw:overflow-y-auto tw:p-1 tw:[container-name:db-sidebar] tw:[container-type:inline-size]">
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
                onClick={() => onNewConnection()}
              >
                {t("connections.allDataSources")}
              </ToolWindowAction>
            </ToolWindowSection>

            <ToolWindowSection title={t("connections.connectCloudProvider")}>
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
        {sections.map((section) =>
          section.kind === "group"
            ? renderGroup(section.group)
            : renderConnection(section.connection),
        )}
      </div>

      {workspaceAccount ? (
        <div className="sidebar-foot ds-control-row tw:flex tw:min-w-0 tw:shrink-0 tw:items-center tw:gap-2 tw:border-t tw:border-border-subtle tw:bg-background tw:p-2">
          {workspaceAccount}
        </div>
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
    </aside>
  );
}
