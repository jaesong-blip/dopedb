import type {
  Catalog,
  CatalogObject,
  CatalogOverview,
  CatalogTable,
} from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import { Icon } from "../../components/Icon";
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
        className={[
          "db-table",
          "ds-object-row",
          selected && selectedTableKey === key ? "selected" : "",
          tone ? `schema-diff-${tone}` : "",
        ]
          .filter(Boolean)
          .join(" ")}
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
          className={`schema-diff-dot${tone ? ` diff-${tone}` : " diff-none"}`}
          title={
            tableDiff ? schemaTableDiffTitle(t, tableDiff) : undefined
          }
          aria-hidden="true"
        />
        <Icon
          className="db-object-icon"
          name={
            isDocumentEngine(connection.engine)
              ? "collection"
              : table.kind === "view"
                ? "view"
                : "table"
          }
        />
        <span className="tbl-name">
          {tableLabel(connection.engine, table)}
        </span>
        {showRowCounts &&
          table.rowEstimate != null &&
          table.rowEstimate >= 0 && (
            <span className="tbl-count muted">
              ~{table.rowEstimate.toLocaleString()}
            </span>
          )}
        {!isDocumentEngine(connection.engine) && (
          <button
            className="ddl-btn"
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
        className="db-table schema-diff-missing-row ds-object-row"
        title={t("connections.schemaDiffTableMissing")}
      >
        <span className="schema-diff-dot diff-missing" aria-hidden="true" />
        <Icon
          className="db-object-icon"
          name={table.kind === "view" ? "view" : "table"}
        />
        <span className="tbl-name">
          {tableLabel(connection.engine, table)}
        </span>
        <span className="schema-diff-kind">
          {t(
            table.kind === "view"
              ? "schemaDiff.objectView"
              : "schemaDiff.objectTable",
          )}
        </span>
        <span className="schema-diff-inline diff-missing">base</span>
      </div>
    );
  }

  function renderObject(object: CatalogObject, icon: Parameters<typeof Icon>[0]["name"], index: number) {
    return (
      <div
        className="db-catalog-object ds-object-row"
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
        <Icon className="db-object-icon" name={icon} />
        <span className="tbl-name">{catalogObjectLabel(object)}</span>
        {object.parent && (
          <span className="db-object-parent muted">
            {t("connections.objectOn")} {object.parent}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="db-tables">
      {catalog &&
        catalog.tables.length + (catalog.objects?.length ?? 0) > 5 && (
          <input
            className="table-filter"
            placeholder={t("connections.filterTables")}
            value={filter}
            onChange={(event) => props.onFilter(event.target.value)}
          />
        )}
      {error && <div className="error small-pad">{error}</div>}
      {detailError && <div className="muted small-pad">{detailError}</div>}
      {!catalog && !error && (
        <div className="muted small-pad loading">
          {t("connections.loadingSchema")}
        </div>
      )}
      {catalog &&
        ordered.length === 0 &&
        filteredObjects.length === 0 &&
        missingTables.length === 0 && (
          <div className="muted small-pad">
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
          <div
            className="db-section"
            role="button"
            tabIndex={0}
            aria-expanded={tablesOpen}
            onClick={() => props.onToggleDefaultSection("table")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onToggleDefaultSection("table");
              }
            }}
          >
            <span className="tw">
              <Icon
                name={tablesOpen ? "chevronDown" : "chevronRight"}
              />
            </span>
            <Icon
              className="db-section-icon"
              name={
                isDocumentEngine(connection.engine) ? "collection" : "table"
              }
            />
            {t(
              isDocumentEngine(connection.engine)
                ? "connections.collections"
                : "connections.tables",
              { count: tables.length },
            )}
          </div>
          {tablesOpen && tables.map(renderTable)}
        </>
      )}
      {(views.length > 0 ||
        (!normalizedFilter &&
          catalog &&
          !isDocumentEngine(connection.engine))) && (
        <>
          <div
            className="db-section"
            role="button"
            tabIndex={0}
            aria-expanded={viewsOpen}
            onClick={() => props.onToggleDefaultSection("view")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onToggleDefaultSection("view");
              }
            }}
          >
            <span className="tw">
              <Icon name={viewsOpen ? "chevronDown" : "chevronRight"} />
            </span>
            <Icon className="db-section-icon" name="view" />
            {t("connections.views", { count: views.length })}
          </div>
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
          <div className="db-object-section" key={section.kind}>
            <div
              className="db-section"
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              onClick={() => props.onToggleObjectSection(section.kind)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  props.onToggleObjectSection(section.kind);
                }
              }}
            >
              <span className="tw">
                <Icon
                  name={expanded ? "chevronDown" : "chevronRight"}
                />
              </span>
              <Icon className="db-section-icon" name={section.icon} />
              {t(section.label, { count: objects.length })}
            </div>
            {expanded &&
              objects.map((object, index) =>
                renderObject(object, section.icon, index),
              )}
          </div>
        );
      })}
      {missingTables.length > 0 && (
        <>
          <div className="db-section schema-diff-section">
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
