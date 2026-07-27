import { describe, expect, it } from "vitest";
import type {
  CatalogOverview,
  CatalogOverviewRelation,
  CatalogTable,
} from "../../ipc/types";
import {
  catalogFromOverview,
  catalogOverviewTable,
} from "./catalogOverview";

describe("catalogOverviewTable", () => {
  it("keeps relation identity, hierarchy, and bounded row metadata", () => {
    const relation = {
      schema: "public",
      name: "invoice_items",
      kind: "table",
      nativeId: "items-1",
      comment: "Line items",
      rowEstimate: 42,
      parent: {
        schema: "public",
        name: "invoices",
        kind: "table",
        nativeId: "invoices-1",
      },
    } as CatalogOverviewRelation;

    expect(catalogOverviewTable(relation)).toMatchObject({
      schema: "public",
      name: "invoice_items",
      rowEstimate: 42,
      partitionParent: { namespace: "public", name: "invoices" },
      columns: [],
    });
  });

  it("keeps the live relation tree while hydrating only the same native identity", () => {
    const oldTable = {
      ...catalogOverviewTable({
        schema: "public",
        name: "orders",
        kind: "table",
        nativeId: "old-oid",
        comment: null,
        rowEstimate: 1,
        parent: null,
      }),
      columns: [{ name: "legacy_column" }],
    } as CatalogTable;
    const currentTable = {
      schema: "public",
      name: "orders",
      kind: "table",
      nativeId: "new-oid",
      comment: null,
      rowEstimate: 2,
      parent: null,
    } as CatalogOverviewRelation;
    const addedTable = {
      ...currentTable,
      name: "new_table",
      nativeId: "new-table-oid",
    };
    const overview = {
      relations: [currentTable, addedTable],
      detailState: "deferred",
    } as CatalogOverview;

    const catalog = catalogFromOverview(overview, {
      tables: [oldTable],
      objects: [],
    });

    expect(catalog.tables.map((table) => table.name)).toEqual([
      "orders",
      "new_table",
    ]);
    expect(catalog.tables[0].columns).toEqual([]);
    expect(catalog.tables[0].rowEstimate).toBe(2);
  });
});
