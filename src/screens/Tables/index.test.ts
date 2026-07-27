import { describe, expect, it } from "vitest";
import type { CatalogTable } from "../../ipc/types";
import { resolveCatalogTable } from "../../features/tableData/catalogTable";

describe("resolveCatalogTable", () => {
  it("upgrades an overview relation to the full catalog metadata", () => {
    const overview = {
      schema: "public",
      name: "orders",
      kind: "table",
      nativeId: null,
      comment: null,
      partitionParent: null,
      partitionChildren: [],
      columns: [],
      foreignKeys: [],
      constraints: [],
      indexes: [],
      rowEstimate: null,
    } as CatalogTable;
    const full = {
      ...overview,
      columns: [{ name: "id", pk: true }],
    } as CatalogTable;

    expect(resolveCatalogTable({ tables: [full], objects: [] }, overview)).toBe(full);
  });

  it("does not hydrate a recreated relation from stale full metadata", () => {
    const requested = {
      schema: "public",
      name: "orders",
      kind: "table",
      nativeId: "new-oid",
      comment: null,
      partitionParent: null,
      partitionChildren: [],
      columns: [],
      foreignKeys: [],
      constraints: [],
      indexes: [],
      rowEstimate: null,
    } as CatalogTable;
    const stale = {
      ...requested,
      nativeId: "old-oid",
      columns: [{ name: "legacy_column", pk: true }],
    } as CatalogTable;
    const staleView = {
      ...requested,
      kind: "view",
      columns: [{ name: "legacy_view_column" }],
    } as CatalogTable;

    expect(resolveCatalogTable({ tables: [stale], objects: [] }, requested)).toBe(
      requested,
    );
    expect(resolveCatalogTable({ tables: [staleView], objects: [] }, requested)).toBe(
      requested,
    );
  });
});
