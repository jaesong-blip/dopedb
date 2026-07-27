import { useQuery } from "@tanstack/react-query";
import type { Catalog, CatalogTable } from "../../ipc/types";
import {
  catalogQuery,
  catalogSnapshotQuery,
  useCatalogScope,
} from "../../lib/queries";

/** Upgrades a navigation-only relation when its full catalog entry is available. */
export function resolveCatalogTable(
  catalog: Catalog | undefined,
  requested: CatalogTable,
): CatalogTable {
  return catalog?.tables.find(
    (candidate) =>
      candidate.name === requested.name
      && candidate.schema === requested.schema
      && candidate.kind === requested.kind
      && (
        !candidate.nativeId
        || !requested.nativeId
        || candidate.nativeId === requested.nativeId
      ),
  ) ?? requested;
}

/** Shares the full-catalog upgrade and delayed snapshot read used by editable SQL tables. */
export function useCatalogTableMetadata(connectionId: string, requested: CatalogTable) {
  const scope = useCatalogScope();
  const catalogQueryResult = useQuery(catalogQuery(connectionId, scope));
  const table = resolveCatalogTable(catalogQueryResult.data, requested);
  const snapshotQuery = useQuery(
    catalogSnapshotQuery(connectionId, catalogQueryResult.data !== undefined, scope),
  );
  return { table, snapshotQuery };
}
