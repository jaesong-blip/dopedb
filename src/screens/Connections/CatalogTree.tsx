import { useEffect, useRef, useState } from "react";
import type {
  Catalog,
  CatalogConstraint,
  CatalogForeignKey,
  CatalogIndex,
  CatalogObject,
  CatalogOverview,
  CatalogTable,
} from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import { Icon } from "../../components/Icon";
import { TreeSectionButton } from "../../design-system/components/TreeControls";
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
import { filterCatalog } from "../../features/catalogExplorer/scopeFilter";

type Props = {
  connection: ConnectionProfile;
  selected: boolean;
  selectedTableKey: string | null;
  overview?: CatalogOverview;
  fullCatalog?: Catalog;
  error?: string;
  detailError?: string;
  applySchemaScope?: boolean;
  filter: string;
  showRowCounts: boolean;
  groupByConnectionId: Map<string, SchemaConnectionGroup>;
  catalogs: Record<string, Catalog>;
  collapsedSections: Set<string>;
  objectSectionsOpen: Set<string>;
  onOpenTable: (table: CatalogTable) => void;
  onRequestDetails: () => void;
  onRetryOverview: () => void;
  onToggleRelationSection: (key: string) => void;
  onToggleObjectSection: (kind: string) => void;
  revealRequest: number;
};

export default function CatalogTree(props: Props) {
  const { t } = useI18n();
  const treeRef = useRef<HTMLDivElement>(null);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedSchemas, setCollapsedSchemas] = useState<Set<string>>(
    () => new Set(),
  );
  const [databaseOpen, setDatabaseOpen] = useState(true);
  const [collapsedMetadataSections, setCollapsedMetadataSections] =
    useState<Set<string>>(() => new Set());
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
  const unfilteredCatalog = overview
    ? catalogFromOverview(overview, fullCatalog)
    : fullCatalog;
  const catalog = unfilteredCatalog
    ? props.applySchemaScope === false
      ? unfilteredCatalog
      : filterCatalog(connection, unfilteredCatalog)
    : undefined;
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
  const objectSections = SQL_OBJECT_SECTIONS.filter(
    (section) =>
      supportedKinds.has(section.kind) ||
      filteredObjects.some((object) => object.kind === section.kind),
  );
  const databaseSectionKey = (section: string) =>
    `${connection.database}\u0000${section}`;

  useEffect(() => {
    if (
      !selected ||
      props.revealRequest === 0 ||
      !selectedTableKey ||
      !unfilteredCatalog
    ) {
      return;
    }
    const table = unfilteredCatalog.tables.find(
      (candidate) => tableKey(candidate) === selectedTableKey,
    );
    if (!table) return;

    setDatabaseOpen(true);
    const schemaKey = schemaStateKey(table.schema ?? "");
    setCollapsedSchemas((current) => {
      if (!current.has(schemaKey)) return current;
      const next = new Set(current);
      next.delete(schemaKey);
      return next;
    });
    const relationSection = isDocumentEngine(connection.engine)
      ? "collections"
      : `${schemaKey}:${table.kind === "view" ? "view" : "table"}`;
    const relationSectionKey = databaseSectionKey(relationSection);
    if (
      collapsedSections.has(
        `${connection.id}:${relationSectionKey}`,
      )
    ) {
      props.onToggleRelationSection(relationSectionKey);
    }

    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        const row = [...treeRef.current?.querySelectorAll<HTMLElement>(
          "[data-table-key]",
        ) ?? []].find(
          (candidate) => candidate.dataset.tableKey === selectedTableKey,
        );
        row?.scrollIntoView({ block: "nearest" });
        row?.querySelector<HTMLButtonElement>(".tbl-name")?.focus();
      });
    });
    return () => {
      cancelAnimationFrame(outerFrame);
      if (innerFrame) cancelAnimationFrame(innerFrame);
    };
    // The request counter deliberately snapshots the current catalog/tree callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revealRequest]);

  function toggleTableDetails(table: CatalogTable) {
    const key = tableKey(table);
    setExpandedTables((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        props.onRequestDetails();
      }
      return next;
    });
  }

  function toggleSchema(schema: string) {
    setCollapsedSchemas((current) => {
      const next = new Set(current);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });
  }

  function toggleMetadataSection(table: CatalogTable, section: string) {
    const key = `${tableKey(table)}:${section}`;
    setCollapsedMetadataSections((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function metadataSectionIsOpen(table: CatalogTable, section: string) {
    return !collapsedMetadataSections.has(`${tableKey(table)}:${section}`);
  }

  function renderColumnRows(table: CatalogTable) {
    return table.columns.map((column) => (
      <div
        className="ds-object-row tw:cursor-default tw:gap-1 tw:rounded-xs tw:pl-4 tw:text-ui"
        key={`${tableKey(table)}:column:${column.ordinal}:${column.name}`}
        title={[
          column.dataType,
          column.nullable ? t("connections.nullable") : t("connections.notNull"),
          column.defaultExpression
            ? `${t("connections.defaultValue")}: ${column.defaultExpression}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        <Icon
          className="tw:shrink-0 tw:text-[length:var(--ds-icon-sm)] tw:text-muted-foreground"
          name={column.pk ? "key" : "columns"}
        />
        <span className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
          {column.name}
        </span>
        <span className="tw:max-w-[48%] tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:font-mono tw:text-2xs tw:text-muted-foreground">
          {column.dataType}
        </span>
      </div>
    ));
  }

  function keyLabel(
    constraint: CatalogConstraint | CatalogForeignKey,
    index: number,
  ) {
    if ("kind" in constraint) {
      return constraint.name ||
        `${constraint.kind} (${constraint.columns.join(", ")})`;
    }
    const target = [
      constraint.referencesSchema,
      constraint.referencesTable,
      constraint.referencesColumn,
    ]
      .filter(Boolean)
      .join(".");
    return constraint.name ||
      `${constraint.column} → ${target || `#${index + 1}`}`;
  }

  function renderKeyRows(table: CatalogTable) {
    const keys: Array<CatalogConstraint | CatalogForeignKey> =
      table.constraints.length > 0
        ? table.constraints
        : table.foreignKeys;
    return keys.map((constraint, index) => (
      <div
        className="ds-object-row tw:cursor-default tw:gap-1 tw:rounded-xs tw:pl-4 tw:text-ui"
        key={`${tableKey(table)}:key:${keyLabel(constraint, index)}:${index}`}
        title={keyLabel(constraint, index)}
      >
        <Icon
          className="tw:shrink-0 tw:text-[length:var(--ds-icon-sm)] tw:text-muted-foreground"
          name="key"
        />
        <span className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
          {keyLabel(constraint, index)}
        </span>
        {"kind" in constraint && (
          <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">
            {constraint.kind}
          </span>
        )}
      </div>
    ));
  }

  function indexLabel(index: CatalogIndex) {
    const columns = index.keys.length > 0
      ? index.keys.map((key) => key.column ?? key.expression).filter(Boolean)
      : index.columns;
    return `${index.name} (${columns.join(", ")})`;
  }

  function renderIndexRows(table: CatalogTable) {
    return table.indexes.map((index) => (
      <div
        className="ds-object-row tw:cursor-default tw:gap-1 tw:rounded-xs tw:pl-4 tw:text-ui"
        key={`${tableKey(table)}:index:${index.name}`}
        title={indexLabel(index)}
      >
        <Icon
          className="tw:shrink-0 tw:text-[length:var(--ds-icon-sm)] tw:text-muted-foreground"
          name="list"
        />
        <span className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
          {indexLabel(index)}
        </span>
        {index.unique && (
          <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">
            {t("connections.unique")}
          </span>
        )}
      </div>
    ));
  }

  function renderMetadataSection(
    table: CatalogTable,
    section: "columns" | "keys" | "indexes",
    count: number,
    children: ReturnType<typeof renderColumnRows>,
  ) {
    if (count === 0) return null;
    const expanded = metadataSectionIsOpen(table, section);
    return (
      <div
        className="tw:flex tw:flex-col tw:gap-px"
        key={`${tableKey(table)}:${section}`}
      >
        <TreeSectionButton
          expanded={expanded}
          icon={section === "keys" ? "key" : section === "indexes" ? "list" : "columns"}
          onToggle={() => toggleMetadataSection(table, section)}
        >
          {t(
            section === "keys"
              ? "connections.keys"
              : section === "indexes"
                ? "connections.indexes"
                : "connections.columns",
            { count },
          )}
        </TreeSectionButton>
        {expanded && children}
      </div>
    );
  }

  function renderTableDetails(table: CatalogTable) {
    if (!fullCatalog) {
      return (
        <div className="tw:pl-5 tw:text-xs tw:text-muted-foreground">
          <LoadingLabel>{t("connections.loadingMetadata")}</LoadingLabel>
        </div>
      );
    }
    const keyCount = table.constraints.length > 0
      ? table.constraints.length
      : table.foreignKeys.length;
    return (
      <div className="tw:flex tw:flex-col tw:gap-px tw:pl-3">
        {renderMetadataSection(
          table,
          "columns",
          table.columns.length,
          renderColumnRows(table),
        )}
        {renderMetadataSection(
          table,
          "keys",
          keyCount,
          renderKeyRows(table),
        )}
        {renderMetadataSection(
          table,
          "indexes",
          table.indexes.length,
          renderIndexRows(table),
        )}
        {table.columns.length + keyCount + table.indexes.length === 0 && (
          <div className="tw:pl-5 tw:text-xs tw:text-muted-foreground">
            {t("connections.noMetadata")}
          </div>
        )}
      </div>
    );
  }

  function renderTable(table: CatalogTable) {
    const key = tableKey(table);
    const tableDiff = diff?.tableDiffs[key];
    const tone = tableDiffTone(tableDiff);
    const detailsOpen = expandedTables.has(key);
    return (
      <div className="tw:flex tw:flex-col tw:gap-px" key={key}>
        <div
          className="db-table ds-object-row tw:group tw:relative tw:gap-1 tw:rounded-xs tw:select-none tw:text-ui"
          data-table-key={key}
          data-diff={tone ?? "none"}
          aria-selected={selected && selectedTableKey === key}
          title={
            tableDiff
              ? schemaTableDiffTitle(t, tableDiff)
              : fullCatalog
                ? t("connections.columns", { count: table.columns.length })
                : undefined
          }
        >
          {!isDocumentEngine(connection.engine) && (
            <button
              type="button"
              className="tw:grid tw:size-3 tw:shrink-0 tw:cursor-pointer tw:place-items-center tw:rounded-xs tw:border-0 tw:bg-transparent tw:p-0 tw:text-2xs tw:text-muted-foreground tw:hover:text-foreground"
              aria-expanded={detailsOpen}
              aria-label={
                detailsOpen
                  ? t("connections.collapseMetadata", { table: table.name })
                  : t("connections.expandMetadata", { table: table.name })
              }
              onClick={() => toggleTableDetails(table)}
            >
              <Icon name={detailsOpen ? "chevronDown" : "chevronRight"} />
            </button>
          )}
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
          <button
            type="button"
            className="tbl-name tw:min-w-[10ch] tw:flex-1 tw:cursor-pointer tw:overflow-hidden tw:border-0 tw:bg-transparent tw:p-0 tw:text-left tw:font-sans tw:text-inherit tw:text-ellipsis tw:whitespace-nowrap"
            onClick={() => props.onOpenTable(table)}
          >
            {table.schema ? table.name : tableLabel(connection.engine, table)}
          </button>
          {showRowCounts &&
            table.rowEstimate != null &&
            table.rowEstimate >= 0 && (
              <span className="tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-xs tw:text-muted-foreground tw:opacity-60 tw:[font-variant-numeric:tabular-nums] tw:group-hover:opacity-100">
                ~{table.rowEstimate.toLocaleString()}
              </span>
            )}
        </div>
        {detailsOpen && renderTableDetails(table)}
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

  function renderObject(
    object: CatalogObject,
    icon: Parameters<typeof Icon>[0]["name"],
    index: number,
    insideSchema = false,
  ) {
    const label =
      insideSchema &&
        (object.kind === "function" || object.kind === "procedure") &&
        object.detail != null
        ? `${object.name}(${object.detail})`
        : insideSchema
          ? object.name
          : catalogObjectLabel(object);
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
          {label}
        </span>
        {object.parent && (
          <span className="tw:max-w-[42%] tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-xs tw:text-muted-foreground">
            {t("connections.objectOn")} {object.parent}
          </span>
        )}
      </div>
    );
  }

  const schemaGroups = Array.from(
    [...tables, ...views].reduce((groups, table) => {
      const schema = table.schema ?? "";
      const current = groups.get(schema) ?? {
        relations: [],
        objects: [],
      };
      current.relations.push(table);
      groups.set(schema, current);
      return groups;
    }, new Map<string, {
      relations: CatalogTable[];
      objects: CatalogObject[];
    }>()),
  ).sort(([left], [right]) => left.localeCompare(right));

  for (const object of filteredObjects) {
    const schema = object.schema ?? "";
    const existing = schemaGroups.find(([name]) => name === schema);
    if (existing) {
      existing[1].objects.push(object);
    } else {
      schemaGroups.push([
        schema,
        { relations: [], objects: [object] },
      ]);
    }
  }
  schemaGroups.sort(([left], [right]) => left.localeCompare(right));

  function schemaStateKey(schema: string) {
    return schema || "__default__";
  }

  function renderSchema(
    schema: string,
    contents: {
      relations: CatalogTable[];
      objects: CatalogObject[];
    },
  ) {
    const schemaKey = schemaStateKey(schema);
    const schemaOpen =
      Boolean(normalizedFilter) || !collapsedSchemas.has(schemaKey);
    const schemaTables = contents.relations.filter(
      (table) => table.kind !== "view",
    );
    const schemaViews = contents.relations.filter(
      (table) => table.kind === "view",
    );
    const tableSectionKey = databaseSectionKey(`${schemaKey}:table`);
    const viewSectionKey = databaseSectionKey(`${schemaKey}:view`);
    const tablesOpen =
      Boolean(normalizedFilter) ||
      !collapsedSections.has(`${connection.id}:${tableSectionKey}`);
    const viewsOpen =
      Boolean(normalizedFilter) ||
      !collapsedSections.has(`${connection.id}:${viewSectionKey}`);
    return (
      <div className="tw:flex tw:flex-col tw:gap-px" key={`schema:${schema}`}>
        <TreeSectionButton
          expanded={schemaOpen}
          icon="folder"
          onToggle={() => toggleSchema(schemaKey)}
        >
          {schema || t("connections.defaultSchema")}
        </TreeSectionButton>
        {schemaOpen && (
          <div className="tw:flex tw:flex-col tw:gap-px tw:pl-3">
            {schemaTables.length > 0 && (
              <>
                <TreeSectionButton
                  expanded={tablesOpen}
                  icon="table"
                  onToggle={() =>
                    props.onToggleRelationSection(tableSectionKey)
                  }
                >
                  {t("connections.tables", { count: schemaTables.length })}
                </TreeSectionButton>
                {tablesOpen && schemaTables.map(renderTable)}
              </>
            )}
            {schemaViews.length > 0 && (
              <>
                <TreeSectionButton
                  expanded={viewsOpen}
                  icon="view"
                  onToggle={() =>
                    props.onToggleRelationSection(viewSectionKey)
                  }
                >
                  {t("connections.views", { count: schemaViews.length })}
                </TreeSectionButton>
                {viewsOpen && schemaViews.map(renderTable)}
              </>
            )}
            {objectSections.map((section) => {
              const objects = contents.objects.filter(
                (object) => object.kind === section.kind,
              );
              if (normalizedFilter && objects.length === 0) return null;
              const objectSectionKey = databaseSectionKey(
                `${schemaKey}:${section.kind}`,
              );
              const expanded =
                Boolean(normalizedFilter) ||
                objectSectionsOpen.has(
                  `${connection.id}:${objectSectionKey}`,
                );
              return (
                <div
                  className="tw:flex tw:flex-col tw:gap-px"
                  key={section.kind}
                >
                  <TreeSectionButton
                    expanded={expanded}
                    icon={section.icon}
                    onToggle={() =>
                      props.onToggleObjectSection(objectSectionKey)
                    }
                  >
                    {t(section.label, { count: objects.length })}
                  </TreeSectionButton>
                  {expanded &&
                    objects.map((object, index) =>
                      renderObject(object, section.icon, index, true),
                    )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function databaseDisplayName() {
    const value = connection.database.trim();
    if (!value) return connection.name || t("connections.database");
    if (connection.engine !== "sqlite") return value;
    const segments = value.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? value;
  }

  function renderDatabaseContents() {
    if (isDocumentEngine(connection.engine)) {
      const collectionSectionKey = databaseSectionKey("collections");
      const tablesOpen =
        Boolean(normalizedFilter) ||
        !collapsedSections.has(
          `${connection.id}:${collectionSectionKey}`,
        );
      return (
        <>
          {(tables.length > 0 || (!normalizedFilter && catalog)) && (
            <>
              <TreeSectionButton
                expanded={tablesOpen}
                icon="collection"
                onToggle={() =>
                  props.onToggleRelationSection(collectionSectionKey)
                }
              >
                {t("connections.collections", { count: tables.length })}
              </TreeSectionButton>
              {tablesOpen && tables.map(renderTable)}
            </>
          )}
        </>
      );
    }
    return schemaGroups.map(([schema, contents]) =>
      renderSchema(schema, contents),
    );
  }

  return (
    <div
      ref={treeRef}
      className="tw:flex tw:flex-col tw:gap-px tw:pt-1 tw:pr-0 tw:pb-2 tw:pl-3"
    >
      {error ? (
        <div className="tw:flex tw:items-start tw:gap-2 tw:px-2 tw:py-1 tw:text-sm tw:text-danger">
          <span className="tw:min-w-0 tw:flex-1 tw:wrap-break-word">
            {error}
          </span>
          <button
            type="button"
            className="tw:shrink-0 tw:cursor-pointer tw:rounded-xs tw:border tw:border-border-subtle tw:bg-card tw:px-1.5 tw:py-px tw:font-sans tw:text-2xs tw:text-foreground tw:hover:border-ring"
            onClick={props.onRetryOverview}
          >
            {t("common.refresh")}
          </button>
        </div>
      ) : null}
      {detailError ? (
        <div className="tw:flex tw:items-start tw:gap-2 tw:px-2 tw:py-1 tw:text-sm tw:text-muted-foreground">
          <span className="tw:min-w-0 tw:flex-1 tw:wrap-break-word">
            {detailError}
          </span>
          <button
            type="button"
            className="tw:shrink-0 tw:cursor-pointer tw:rounded-xs tw:border tw:border-border-subtle tw:bg-card tw:px-1.5 tw:py-px tw:font-sans tw:text-2xs tw:text-foreground tw:hover:border-ring"
            onClick={props.onRequestDetails}
          >
            {t("common.refresh")}
          </button>
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
      {catalog &&
        (ordered.length > 0 ||
          filteredObjects.length > 0 ||
          (!normalizedFilter && catalog)) && (
          <div className="tw:flex tw:flex-col tw:gap-px">
            <TreeSectionButton
              expanded={Boolean(normalizedFilter) || databaseOpen}
              icon="database"
              onToggle={() => setDatabaseOpen((open) => !open)}
            >
              {databaseDisplayName()}
            </TreeSectionButton>
            {(Boolean(normalizedFilter) || databaseOpen) && (
              <div className="tw:flex tw:flex-col tw:gap-px tw:pl-3">
                {renderDatabaseContents()}
              </div>
            )}
          </div>
        )}
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
