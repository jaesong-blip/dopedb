import type {
  PointerEvent,
  RefObject,
} from "react";

import ConfirmButton from "../../components/ConfirmButton";
import EngineMark from "../../components/EngineMark";
import { Icon } from "../../components/Icon";
import { EnvironmentBadge } from "../../design-system/components/EnvironmentBadge";
import {
  PopupMenu,
  PopupMenuCheckbox,
  PopupMenuItem,
} from "../../design-system/components/PopupMenu";
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
  const isDropTarget =
    props.dropTarget?.kind === "connection" &&
    props.dropTarget.id === connection.id;

  return (
    <div className="tw:relative">
      <div
        data-connection-id={connection.id}
        data-nested={props.nested}
        data-dragging={props.draggingId === connection.id}
        data-drop-target={isDropTarget}
        className="db-conn ds-object-row tw:group tw:relative tw:touch-none tw:select-none tw:gap-1 tw:rounded-xs tw:pr-[calc(var(--ds-control-sm)+var(--ds-space-1))] tw:font-medium tw:data-[nested=true]:pl-2 tw:data-[dragging=true]:opacity-50 tw:data-[drop-target=true]:bg-muted tw:data-[drop-target=true]:ring-2 tw:data-[drop-target=true]:ring-ring"
        role="button"
        aria-selected={props.selected}
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
          className="tw tw:grid tw:w-3 tw:shrink-0 tw:place-items-center tw:text-2xs tw:text-muted-foreground"
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
        <span className="db-conn-name tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
          {connection.name || t("app.unnamed")}
        </span>
        {connection.env ? (
          <EnvironmentBadge environment={connection.env} />
        ) : null}
        {accessLabel && (
          <span
            data-access={connection.workspaceAccess}
            className="tw:inline-flex tw:shrink-0 tw:items-center tw:justify-center tw:gap-[2px] tw:rounded-xs tw:border tw:border-border-subtle tw:px-1.5 tw:py-px tw:font-mono tw:text-2xs tw:text-muted-foreground tw:uppercase tw:data-[access=write]:border-primary tw:data-[access=write]:text-primary tw:data-[access=manage]:border-primary tw:data-[access=manage]:text-primary tw:@max-[270px]:size-[18px] tw:@max-[270px]:rounded-full tw:@max-[270px]:p-0"
            aria-label={accessLabel}
            title={accessLabel}
          >
            <span
              className="tw:hidden tw:size-1.5 tw:rounded-full tw:bg-current tw:@max-[270px]:block"
              aria-hidden="true"
            />
            <span className="tw:@max-[270px]:hidden">{accessLabel}</span>
          </span>
        )}
        {(!props.nested || !connection.env) && (
          <SchemaDiffBadge
            connection={connection}
            groupsByConnectionId={props.groupByConnectionId}
            catalogs={props.catalogs}
          />
        )}
        <div
          className="db-menu tw:pointer-events-none tw:absolute tw:top-1/2 tw:right-1 tw:-translate-y-1/2 tw:opacity-0 tw:transition-opacity tw:group-hover:pointer-events-auto tw:group-hover:opacity-100 tw:focus-within:pointer-events-auto tw:focus-within:opacity-100 tw:data-[open=true]:pointer-events-auto tw:data-[open=true]:z-[var(--ds-z-popover)] tw:data-[open=true]:opacity-100"
          data-open={props.openMenuId === connection.id}
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
          {props.openMenuId === connection.id ? (
            <PopupMenu id={`connection-menu-${connection.id}`}>
              {connection.workspaceAccess === "local" ? (
                <PopupMenuItem
                  onClick={() => {
                    props.onOpenMenu(null);
                    props.onEdit();
                  }}
                >
                  {t("connections.edit")}
                </PopupMenuItem>
              ) : connection.workspaceAccess !== "view" &&
                connection.credentialMode === "memberLocal" ? (
                <PopupMenuItem
                  onClick={() => {
                    props.onOpenMenu(null);
                    props.onWorkspaceDialog("credentials");
                  }}
                >
                  {t("workspace.bindCredentialsShort")}
                </PopupMenuItem>
              ) : null}
              {connection.workspaceAccess === "local" ? (
                <PopupMenuItem
                  onClick={() => {
                    props.onOpenMenu(null);
                    props.onWorkspaceDialog("copy");
                  }}
                >
                  {t("workspace.copyToWorkspace")}
                </PopupMenuItem>
              ) : null}
              {connection.workspaceAccess !== "view" ? (
                <PopupMenuItem
                  disabled={props.refreshingId === connection.id}
                  onClick={() => {
                    props.onOpenMenu(null);
                    props.onRefresh();
                  }}
                >
                  {props.refreshingId === connection.id
                    ? t("common.working")
                    : t("connections.refreshSchema")}
                </PopupMenuItem>
              ) : null}
              <PopupMenuCheckbox
                checked={props.showRowCounts}
                onChange={(event) =>
                  props.onShowRowCounts(event.target.checked)
                }
              >
                {t("connections.showRowCounts")}
              </PopupMenuCheckbox>
              {connection.workspaceAccess === "local" ? (
                <ConfirmButton
                  className="tw:flex tw:min-h-control-md tw:cursor-pointer tw:items-center tw:gap-2 tw:rounded-sm tw:border-0 tw:bg-transparent tw:px-2 tw:font-sans tw:text-left tw:text-sm tw:text-danger tw:hover:bg-muted"
                  confirmLabel={t("common.reallyDelete")}
                  disabled={props.deletingId === connection.id}
                  onConfirm={props.onDelete}
                >
                  {t("common.delete")}
                </ConfirmButton>
              ) : null}
            </PopupMenu>
          ) : null}
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
