import type {
  Catalog,
  CatalogObject,
  CatalogOverview,
  CatalogTable,
} from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import { Icon } from "../../components/Icon";
import {
  TreeSearch,
  TreeSectionButton,
} from "../../design-system/components/TreeControls";
import { LoadingLabel } from "../../design-system/components/Status";
import { isDocumentEngine } from "../../lib/capabilities";
import { useI18n } from "../../lib/i18n";
import {
  orderTablesBySchemaDiff,
  tableDiffTone,
  type SchemaConnectionGroup,
} from "../../lib/schemaDiff";
import { tableKey, tableLabel } from "../../lib/tableRef";
import {
  schemaDiffForConnection,
  schemaTableDiffTitle,
} from "./schemaDiffPresentation";
import { catalogFromOverview } from "./catalogOverview";
import {
  catalogObjectLabel,
  objectMatchesFilter,
  SQL_OBJECT_SECTIONS,
  supportedObjectKinds,
  tableMatchesFilter,
} from "../../features/catalogExplorer/catalogDomain";

type Props = {
  connection: ConnectionProfile;
  selected: boolean;
  selectedTableKey: string | null;
  overview?: CatalogOverview;
  fullCatalog?: Catalog;
  error?: string;
  detailError?: string;
  filter: string;
  showRowCounts: boolean;
  groupByConnectionId: Map<string, SchemaConnectionGroup>;
  catalogs: Record<string, Catalog>;
  collapsedSections: Set<string>;
  objectSectionsOpen: Set<string>;
  onFilter: (value: string) => void;
  onOpenTable: (table: CatalogTable) => void;
  onShowDdl: (table: CatalogTable) => void;
  onToggleDefaultSection: (kind: "table" | "view") => void;
  onToggleObjectSection: (kind: string) => void;
};

export default function CatalogTree(props: Props) {
  const { t } = useI18n();
  const {
    connection,
    selected,
    selectedTableKey,
    overview,
    fullCatalog,
    error,
    detailError,
    filter,
    showRowCounts,
    groupByConnectionId,
    catalogs,
    collapsedSections,
    objectSectionsOpen,
  } = props;
  const catalog = overview
    ? catalogFromOverview(overview, fullCatalog)
    : fullCatalog;
  const diff = schemaDiffForConnection(
    connection,
    groupByConnectionId,
    catalogs,
  );
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredTables = catalog
    ? normalizedFilter
      ? catalog.tables.filter((table) =>
          tableMatchesFilter(table, normalizedFilter),
        )
      : catalog.tables
    : [];
  const filteredObjects = catalog
    ? normalizedFilter
      ? (catalog.objects ?? []).filter((object) =>
          objectMatchesFilter(object, normalizedFilter),
        )
      : (catalog.objects ?? [])
    : [];
  const ordered = orderTablesBySchemaDiff(filteredTables, diff);
  const missingTables = diff
    ? normalizedFilter
      ? diff.missingTables.filter((table) =>
          tableMatchesFilter(table, normalizedFilter),
        )
      : diff.missingTables
    : [];
  const tables = ordered.filter((table) => table.kind !== "view");
  const views = ordered.filter((table) => table.kind === "view");
  const supportedKinds = supportedObjectKinds(connection.engine);
  const tablesOpen = !collapsedSections.has(`${connection.id}:table`);
  const viewsOpen = !collapsedSections.has(`${connection.id}:view`);
  const objectSections = SQL_OBJECT_SECTIONS.filter(
    (section) =>
      supportedKinds.has(section.kind) ||
      filteredObjects.some((object) => object.kind === section.kind),
  );

  function renderTable(table: CatalogTable) {
    const key = tableKey(table);
    const tableDiff = diff?.tableDiffs[key];
    const tone = tableDiffTone(tableDiff);
    return (
      <div
        key={key}
        className="db-table ds-object-row tw:group tw:relative tw:gap-1 tw:rounded-xs tw:select-none tw:text-ui"
        data-diff={tone ?? "none"}
        aria-selected={selected && selectedTableKey === key}
        role="button"
        tabIndex={0}
        onClick={() => props.onOpenTable(table)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onOpenTable(table);
          }
        }}
        title={
          tableDiff
            ? schemaTableDiffTitle(t, tableDiff)
            : fullCatalog
              ? t("connections.columns", { count: table.columns.length })
              : undefined
        }
      >
        <span
          data-diff={tone ?? "none"}
          className="tw:size-[7px] tw:shrink-0 tw:rounded-full tw:bg-transparent tw:data-[diff=added]:bg-success tw:data-[diff=missing]:bg-danger tw:data-[diff=changed]:bg-warning tw:data-[diff=mixed]:border tw:data-[diff=mixed]:border-danger tw:data-[diff=mixed]:bg-warning"
          title={
            tableDiff ? schemaTableDiffTitle(t, tableDiff) : undefined
          }
          aria-hidden="true"
        />
        <Icon
          className="tw:shrink-0 tw:text-[length:var(--ds-icon-sm)] tw:text-muted-foreground tw:group-hover:text-current"
          name={
            isDocumentEngine(connection.engine)
              ? "collection"
              : table.kind === "view"
                ? "view"
                : "table"
          }
        />
        <span className="tbl-name tw:min-w-[10ch] tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
          {tableLabel(connection.engine, table)}
        </span>
        {showRowCounts &&
          table.rowEstimate != null &&
          table.rowEstimate >= 0 && (
            <span className="tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-xs tw:text-muted-foreground tw:opacity-60 tw:[font-variant-numeric:tabular-nums] tw:group-hover:opacity-100">
              ~{table.rowEstimate.toLocaleString()}
            </span>
          )}
        {!isDocumentEngine(connection.engine) && (
          <button
            className="ddl-btn tw:absolute tw:top-1/2 tw:right-2 tw:-translate-y-1/2 tw:cursor-pointer tw:rounded-xs tw:border tw:border-border-subtle tw:bg-card tw:px-1.5 tw:py-px tw:text-2xs tw:font-semibold tw:text-muted-foreground tw:opacity-0 tw:transition-opacity tw:group-hover:opacity-100 tw:group-focus-within:opacity-100 tw:hover:border-ring tw:hover:text-foreground"
            type="button"
            title={t("connections.showDdl")}
            onClick={(event) => {
              event.stopPropagation();
              props.onShowDdl(table);
            }}
          >
            DDL
          </button>
        )}
      </div>
    );
  }

  function renderMissingTable(table: CatalogTable) {
    return (
      <div
        key={`missing-${tableKey(table)}`}
        className="db-table ds-object-row tw:cursor-default tw:gap-1 tw:rounded-xs tw:text-muted-foreground"
        title={t("connections.schemaDiffTableMissing")}
      >
        <span
          className="tw:size-[7px] tw:shrink-0 tw:rounded-full tw:bg-danger"
          aria-hidden="true"
        />
        <Icon
          className="tw:shrink-0 tw:text-[length:var(--ds-icon-sm)] tw:text-muted-foreground"
          name={table.kind === "view" ? "view" : "table"}
        />
        <span className="tbl-name tw:min-w-[10ch] tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
          {tableLabel(connection.engine, table)}
        </span>
        <span className="tw:shrink-0 tw:text-2xs tw:font-bold tw:tracking-[0.04em] tw:text-muted-foreground tw:uppercase">
          {t(
            table.kind === "view"
              ? "schemaDiff.objectView"
              : "schemaDiff.objectTable",
          )}
        </span>
        <span className="tw:shrink-0 tw:text-2xs tw:font-bold tw:text-danger">
          base
        </span>
      </div>
    );
  }

  function renderObject(object: CatalogObject, icon: Parameters<typeof Icon>[0]["name"], index: number) {
    return (
      <div
        className="ds-object-row tw:cursor-default tw:gap-1 tw:rounded-xs tw:text-ui"
        key={`${object.schema ?? ""}:${object.kind}:${object.name}:${
          object.detail ?? index
        }`}
        title={[
          catalogObjectLabel(object),
          object.parent
            ? `${t("connections.objectOn")} ${object.parent}`
            : null,
          object.detail && object.kind === "trigger" ? object.detail : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        <Icon
          className="tw:shrink-0 tw:text-[length:var(--ds-icon-sm)] tw:text-muted-foreground"
          name={icon}
        />
        <span className="tbl-name tw:min-w-[10ch] tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
          {catalogObjectLabel(object)}
        </span>
        {object.parent && (
          <span className="tw:max-w-[42%] tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-xs tw:text-muted-foreground">
            {t("connections.objectOn")} {object.parent}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="tw:flex tw:flex-col tw:gap-px tw:pt-1 tw:pr-0 tw:pb-2 tw:pl-3">
      {catalog &&
        catalog.tables.length + (catalog.objects?.length ?? 0) > 5 && (
          <div className="tw:mb-1">
            <TreeSearch
              clearLabel={t("common.close")}
              placeholder={t("connections.filterTables")}
              value={filter}
              onChange={props.onFilter}
            />
          </div>
        )}
      {error ? (
        <div className="tw:px-2 tw:py-1 tw:text-sm tw:text-danger">
          {error}
        </div>
      ) : null}
      {detailError ? (
        <div className="tw:px-2 tw:py-1 tw:text-sm tw:text-muted-foreground">
          {detailError}
        </div>
      ) : null}
      {!catalog && !error && (
        <div className="tw:px-2 tw:py-1 tw:text-sm">
          <LoadingLabel>{t("connections.loadingSchema")}</LoadingLabel>
        </div>
      )}
      {catalog &&
        ordered.length === 0 &&
        filteredObjects.length === 0 &&
        missingTables.length === 0 && (
          <div className="tw:px-2 tw:py-1 tw:text-sm tw:text-muted-foreground">
            {normalizedFilter
              ? t("connections.noTablesMatch", {
                  filter: normalizedFilter,
                })
              : t("connections.noObjects")}
          </div>
        )}
      {(tables.length > 0 ||
        (!normalizedFilter &&
          catalog &&
          !isDocumentEngine(connection.engine))) && (
        <>
          <TreeSectionButton
            expanded={tablesOpen}
            icon={
              isDocumentEngine(connection.engine) ? "collection" : "table"
            }
            onToggle={() => props.onToggleDefaultSection("table")}
          >
            {t(
              isDocumentEngine(connection.engine)
                ? "connections.collections"
                : "connections.tables",
              { count: tables.length },
            )}
          </TreeSectionButton>
          {tablesOpen && tables.map(renderTable)}
        </>
      )}
      {(views.length > 0 ||
        (!normalizedFilter &&
          catalog &&
          !isDocumentEngine(connection.engine))) && (
        <>
          <TreeSectionButton
            expanded={viewsOpen}
            icon="view"
            onToggle={() => props.onToggleDefaultSection("view")}
          >
            {t("connections.views", { count: views.length })}
          </TreeSectionButton>
          {viewsOpen && views.map(renderTable)}
        </>
      )}
      {objectSections.map((section) => {
        const objects = filteredObjects.filter(
          (object) => object.kind === section.kind,
        );
        if (normalizedFilter && objects.length === 0) return null;
        const sectionKey = `${connection.id}:${section.kind}`;
        const expanded =
          Boolean(normalizedFilter) || objectSectionsOpen.has(sectionKey);
        return (
          <div
            className="tw:flex tw:flex-col tw:gap-px"
            key={section.kind}
          >
            <TreeSectionButton
              expanded={expanded}
              icon={section.icon}
              onToggle={() =>
                props.onToggleObjectSection(section.kind)
              }
            >
              {t(section.label, { count: objects.length })}
            </TreeSectionButton>
            {expanded &&
              objects.map((object, index) =>
                renderObject(object, section.icon, index),
              )}
          </div>
        );
      })}
      {missingTables.length > 0 && (
        <>
          <div className="tw:mt-1 tw:px-2 tw:py-1 tw:text-xs tw:font-semibold tw:tracking-[0.04em] tw:text-danger tw:uppercase">
            {t("connections.schemaDiffMissingSection", {
              count: missingTables.length,
            })}
          </div>
          {missingTables.map(renderMissingTable)}
        </>
      )}
    </div>
  );
}
