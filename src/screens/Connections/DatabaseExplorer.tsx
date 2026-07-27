// DopeDB-style Database Explorer sidebar: connection tree, DDL modal, schema-group
// drag-and-drop. Split out of the old Connections/index.tsx (see ConnectionForm.tsx
// for the connection create/edit form that used to live alongside it).
import {
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CatalogTable } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import { deleteConnection } from "../../features/connections/tauriAdapter";
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
import WorkspaceConnectionDialog from "../../features/workspaces/components/WorkspaceConnectionDialog";
import { useToast } from "../../components/Toast";
import { useI18n } from "../../lib/i18n";
import ConnectionNode from "./ConnectionNode";
import DdlModal from "./DdlModal";
import { useCatalogTree } from "./useCatalogTree";
import "./connections.css";

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
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const catalogScope = useCatalogScope();
  const catalogScopeKeyRef = useRef(catalogScope.key);
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

  function toggleDefaultOpenSection(connectionId: string, kind: "table" | "view") {
    const key = `${connectionId}:${kind}`;
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
        filter={filters[connection.id] ?? ""}
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
        onToggleDefaultSection={(kind) =>
          toggleDefaultOpenSection(connection.id, kind)
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
        className={isDropTarget ? "db-group drop-target" : "db-group"}
      >
        <div
          className={`db-group-head${activeSchemaGroupKey === group.key ? " active" : ""}`}
          title={t("connections.schemaGroupTitle", { group: group.label })}
        >
          {engine && <EngineMark engine={engine} />}
          <span className="db-group-name">{group.label}</span>
          <button
            type="button"
            className="db-group-compare"
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
              <span className="db-group-diff-counts">
                {groupCounts.added > 0 && <span className="diff-add">+{groupCounts.added}</span>}
                {groupCounts.missing > 0 && <span className="diff-remove">−{groupCounts.missing}</span>}
                {groupCounts.changed > 0 && <span className="diff-change">~{groupCounts.changed}</span>}
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

  return (
    <aside className="sidebar" id="workbench-sidebar">
      {workspaceHeader}

      <div className="explorer">
        {connections.length === 0 && (
          <div className="muted empty">{t("connections.noConnections")}</div>
        )}
        {sections.map((section) =>
          section.kind === "group"
            ? renderGroup(section.group)
            : renderConnection(section.connection),
        )}
      </div>

      {workspaceAccount ? (
        <div className="sidebar-foot ds-control-row">{workspaceAccount}</div>
      ) : null}

      {dragPreview &&
        (() => {
          const conn =
            connections.find((connection) => connection.id === dragPreview.id) ??
            null;
          if (!conn) return null;
          return (
            <div
              className="db-drag-preview"
              style={{
                transform: `translate3d(${Math.round(dragPreview.x + 12)}px, ${Math.round(dragPreview.y + 12)}px, 0)`,
              }}
            >
              <EngineMark engine={conn.engine} />
              <span>{conn.name || t("app.unnamed")}</span>
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
    </aside>
  );
}
