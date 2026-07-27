import type {
  PointerEvent,
  RefObject,
} from "react";

import ConfirmButton from "../../components/ConfirmButton";
import EngineMark from "../../components/EngineMark";
import { Icon } from "../../components/Icon";
import type { ConnectionProfile } from "../../features/connections/domain";
import type {
  Catalog,
  CatalogOverview,
  CatalogTable,
} from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { SchemaConnectionGroup } from "../../lib/schemaDiff";
import { SchemaDiffBadge } from "./schemaDiffPresentation";
import CatalogTree from "./CatalogTree";
import type { DropTarget } from "../../features/catalogExplorer/catalogDomain";

type Props = {
  connection: ConnectionProfile;
  nested: boolean;
  selected: boolean;
  selectedTableKey: string | null;
  expanded: boolean;
  draggingId: string | null;
  dropTarget: DropTarget | null;
  suppressClickRef: RefObject<boolean>;
  openMenuId: string | null;
  onOpenMenu: (id: string | null) => void;
  refreshingId: string | null;
  deletingId: string | null;
  showRowCounts: boolean;
  onShowRowCounts: (show: boolean) => void;
  overview?: CatalogOverview;
  fullCatalog?: Catalog;
  error?: string;
  detailError?: string;
  filter: string;
  groupByConnectionId: Map<string, SchemaConnectionGroup>;
  catalogs: Record<string, Catalog>;
  collapsedSections: Set<string>;
  objectSectionsOpen: Set<string>;
  onPointerDown: (
    event: PointerEvent<HTMLDivElement>,
    connection: ConnectionProfile,
  ) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onToggleOpen: () => void;
  onSelect: () => void;
  onEdit: () => void;
  onWorkspaceDialog: (mode: "copy" | "credentials") => void;
  onRefresh: () => void;
  onDelete: () => void;
  onFilter: (value: string) => void;
  onOpenTable: (table: CatalogTable) => void;
  onShowDdl: (table: CatalogTable) => void;
  onToggleDefaultSection: (kind: "table" | "view") => void;
  onToggleObjectSection: (kind: string) => void;
};

export default function ConnectionNode(props: Props) {
  const { t } = useI18n();
  const { connection } = props;
  const accessLabelBase =
    connection.workspaceAccess === "view"
      ? t("workspace.accessView")
      : connection.workspaceAccess === "read"
        ? t("workspace.accessRead")
        : connection.workspaceAccess === "write"
          ? t("workspace.accessWrite")
          : connection.workspaceAccess === "manage"
            ? t("workspace.accessManage")
            : null;
  const accessLabel =
    accessLabelBase && connection.credentialMode === "managed"
      ? `${accessLabelBase} · ${t("workspace.managedCredentials")}`
      : accessLabelBase;
  const description = `${connection.engine} · ${connection.host}${
    connection.engine !== "sqlite" ? `:${connection.port}` : ""
  } · ${connection.database}`;
  const rowClass = [
    "db-conn",
    "ds-object-row",
    props.selected ? "selected" : "",
    props.nested ? "nested" : "",
    props.draggingId === connection.id ? "dragging" : "",
    props.dropTarget?.kind === "connection" &&
    props.dropTarget.id === connection.id
      ? "drop-target"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="db-node">
      <div
        data-connection-id={connection.id}
        className={rowClass}
        role="button"
        aria-label={`${connection.name || t("app.unnamed")} · ${description}`}
        tabIndex={0}
        onPointerDown={(event) => props.onPointerDown(event, connection)}
        onPointerMove={props.onPointerMove}
        onPointerUp={props.onPointerUp}
        onPointerCancel={props.onPointerCancel}
        onClick={() => {
          if (props.suppressClickRef.current) {
            props.suppressClickRef.current = false;
            return;
          }
          if (props.selected) props.onToggleOpen();
          else props.onSelect();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (props.selected) props.onToggleOpen();
            else props.onSelect();
          }
        }}
      >
        <span
          className="tw"
          title={
            props.expanded
              ? t("connections.collapse")
              : t("connections.expand")
          }
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleOpen();
          }}
        >
          <Icon
            name={props.expanded ? "chevronDown" : "chevronRight"}
          />
        </span>
        {!props.nested && <EngineMark engine={connection.engine} />}
        <span className="db-conn-name">
          {connection.name || t("app.unnamed")}
        </span>
        {connection.env && (
          <span className={`env-chip env-${connection.env}`}>
            {connection.env}
          </span>
        )}
        {accessLabel && (
          <span
            className={`workspace-access-chip access-${connection.workspaceAccess}`}
            aria-label={accessLabel}
            title={accessLabel}
          >
            <span className="workspace-access-dot" aria-hidden="true" />
            <span className="workspace-access-label">{accessLabel}</span>
          </span>
        )}
        <SchemaDiffBadge
          connection={connection}
          groupsByConnectionId={props.groupByConnectionId}
          catalogs={props.catalogs}
        />
        <div
          className={`db-menu${props.openMenuId === connection.id ? " open" : ""}`}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              props.onOpenMenu(null);
              event.currentTarget
                .querySelector<HTMLButtonElement>(".db-menu-trigger")
                ?.focus();
            }
          }}
        >
          <button
            type="button"
            className="btn small icon-only icon-xs db-menu-trigger"
            title={t("connections.connectionMenu")}
            aria-label={t("connections.connectionMenu")}
            aria-expanded={props.openMenuId === connection.id}
            aria-controls={`connection-menu-${connection.id}`}
            onClick={() =>
              props.onOpenMenu(
                props.openMenuId === connection.id ? null : connection.id,
              )
            }
          >
            <Icon name="moreVertical" />
          </button>
          {props.openMenuId === connection.id && (
            <div
              className="db-menu-panel"
              id={`connection-menu-${connection.id}`}
            >
              {connection.workspaceAccess === "local" ? (
                <button
                  type="button"
                  onClick={() => {
                    props.onOpenMenu(null);
                    props.onEdit();
                  }}
                >
                  {t("connections.edit")}
                </button>
              ) : connection.workspaceAccess !== "view" &&
                connection.credentialMode === "memberLocal" ? (
                <button
                  type="button"
                  onClick={() => {
                    props.onOpenMenu(null);
                    props.onWorkspaceDialog("credentials");
                  }}
                >
                  {t("workspace.bindCredentialsShort")}
                </button>
              ) : null}
              {connection.workspaceAccess === "local" && (
                <button
                  type="button"
                  onClick={() => {
                    props.onOpenMenu(null);
                    props.onWorkspaceDialog("copy");
                  }}
                >
                  {t("workspace.copyToWorkspace")}
                </button>
              )}
              {connection.workspaceAccess !== "view" && (
                <button
                  type="button"
                  disabled={props.refreshingId === connection.id}
                  onClick={() => {
                    props.onOpenMenu(null);
                    props.onRefresh();
                  }}
                >
                  {props.refreshingId === connection.id
                    ? t("common.working")
                    : t("connections.refreshSchema")}
                </button>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={props.showRowCounts}
                  onChange={(event) =>
                    props.onShowRowCounts(event.target.checked)
                  }
                />
                {t("connections.showRowCounts")}
              </label>
              {connection.workspaceAccess === "local" && (
                <ConfirmButton
                  className="db-menu-item danger"
                  confirmLabel={t("common.reallyDelete")}
                  disabled={props.deletingId === connection.id}
                  onConfirm={props.onDelete}
                >
                  {t("common.delete")}
                </ConfirmButton>
              )}
            </div>
          )}
        </div>
      </div>

      {props.expanded && (
        <CatalogTree
          connection={connection}
          selected={props.selected}
          selectedTableKey={props.selectedTableKey}
          overview={props.overview}
          fullCatalog={props.fullCatalog}
          error={props.error}
          detailError={props.detailError}
          filter={props.filter}
          showRowCounts={props.showRowCounts}
          groupByConnectionId={props.groupByConnectionId}
          catalogs={props.catalogs}
          collapsedSections={props.collapsedSections}
          objectSectionsOpen={props.objectSectionsOpen}
          onFilter={props.onFilter}
          onOpenTable={props.onOpenTable}
          onShowDdl={props.onShowDdl}
          onToggleDefaultSection={props.onToggleDefaultSection}
          onToggleObjectSection={props.onToggleObjectSection}
        />
      )}
    </div>
  );
}
