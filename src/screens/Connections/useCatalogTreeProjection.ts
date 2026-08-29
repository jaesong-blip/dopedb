// Builds the filtered catalog and schema groups consumed by the virtual tree.
// Rendering and expansion state remain in CatalogTree.
import { useMemo } from "react";
import type {
  Catalog,
  CatalogObject,
  CatalogOverview,
  CatalogTable,
} from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import {
  filterLoadedCatalogObjects,
  SQL_OBJECT_SECTIONS,
  supportedObjectKinds,
  tableMatchesFilter,
} from "../../features/catalogExplorer/catalogDomain";
import { filterCatalog } from "../../features/catalogExplorer/scopeFilter";
import {
  orderTablesBySchemaDiff,
  type SchemaConnectionGroup,
} from "../../lib/schemaDiff";
import { catalogFromOverview } from "./catalogOverview";
import { schemaDiffForConnection } from "./schemaDiffPresentation";

interface SchemaContents {
  tables: CatalogTable[];
  views: CatalogTable[];
  objectsByKind: Map<string, CatalogObject[]>;
}

interface CatalogTreeProjectionInput {
  connection: ConnectionProfile;
  overview?: CatalogOverview;
  fullCatalog?: Catalog;
  applySchemaScope?: boolean;
  filter: string;
  groupByConnectionId: Map<string, SchemaConnectionGroup>;
  catalogs: Record<string, Catalog>;
}

export function useCatalogTreeProjection({
  connection,
  overview,
  fullCatalog,
  applySchemaScope,
  filter,
  groupByConnectionId,
  catalogs,
}: CatalogTreeProjectionInput) {
  return useMemo(() => {
    const unfilteredCatalog = overview
      ? catalogFromOverview(overview, fullCatalog)
      : fullCatalog;
    const catalog = unfilteredCatalog
      ? applySchemaScope === false
        ? unfilteredCatalog
        : filterCatalog(connection, unfilteredCatalog)
      : undefined;
    const diff = schemaDiffForConnection(
      connection,
      groupByConnectionId,
      catalogs,
    );
    const {
      normalizedFilter,
      tables: filteredTables,
      objects: filteredObjects,
    } = filterLoadedCatalogObjects(catalog, filter);
    const ordered = orderTablesBySchemaDiff(filteredTables, diff);
    const missingTables = diff
      ? normalizedFilter
        ? diff.missingTables.filter((table) =>
            tableMatchesFilter(table, normalizedFilter),
          )
        : diff.missingTables
      : [];
    const tables = ordered.filter((table) => table.kind !== "view");
    const supportedKinds = supportedObjectKinds(connection.engine);
    const objectSections = SQL_OBJECT_SECTIONS.filter(
      (section) =>
        supportedKinds.has(section.kind) ||
        filteredObjects.some((object) => object.kind === section.kind),
    );
    const groups = new Map<string, SchemaContents>();
    const contentsFor = (schema: string) => {
      const existing = groups.get(schema);
      if (existing) return existing;
      const created: SchemaContents = {
        tables: [],
        views: [],
        objectsByKind: new Map(),
      };
      groups.set(schema, created);
      return created;
    };
    for (const table of ordered) {
      const contents = contentsFor(table.schema ?? "");
      if (table.kind === "view") contents.views.push(table);
      else contents.tables.push(table);
    }
    for (const object of filteredObjects) {
      const objectsByKind = contentsFor(object.schema ?? "").objectsByKind;
      const objects = objectsByKind.get(object.kind) ?? [];
      objects.push(object);
      objectsByKind.set(object.kind, objects);
    }
    const schemaGroups = [...groups.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return {
      unfilteredCatalog,
      catalog,
      diff,
      normalizedFilter,
      filteredObjects,
      ordered,
      missingTables,
      tables,
      objectSections,
      schemaGroups,
    };
  }, [
    applySchemaScope,
    catalogs,
    connection,
    filter,
    fullCatalog,
    groupByConnectionId,
    overview,
  ]);
}
