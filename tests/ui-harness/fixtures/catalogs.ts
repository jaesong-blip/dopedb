// 카탈로그 fixture. 실제 스키마 덤프가 아니라 탐색 밀도, grid, ERD와 긴 이름
// 계약을 위한 최소 관계 집합이다.
import type {
  Catalog,
  CatalogColumn,
  CatalogOverview,
  CatalogSnapshot,
  CatalogTable,
  SafetySettings,
} from "../../../src/ipc/types";

function column(
  name: string,
  dataType: string,
  ordinal: number,
  options: Partial<CatalogColumn> = {},
): CatalogColumn {
  return {
    name,
    dataType,
    nullable: true,
    pk: false,
    ordinal,
    length: null,
    precision: null,
    scale: null,
    defaultExpression: null,
    generatedExpression: null,
    identity: false,
    autoIncrement: false,
    collation: null,
    comment: null,
    ...options,
  };
}

function table(
  schema: string,
  name: string,
  rowEstimate: number,
  columns: CatalogColumn[],
  kind = "table",
): CatalogTable {
  return {
    schema,
    name,
    kind,
    nativeId: null,
    comment: null,
    partitionParent: null,
    partitionChildren: [],
    columns,
    foreignKeys: [],
    constraints: [],
    indexes: [],
    rowEstimate,
  };
}

export const ordersTable = table("public", "orders", 128_400, [
  column("id", "bigint", 1, { nullable: false, pk: true, identity: true }),
  column("customer_id", "bigint", 2, { nullable: false }),
  column("status", "text", 3, { nullable: false }),
  column("total", "numeric(12,2)", 4, {
    nullable: false,
    precision: 12,
    scale: 2,
  }),
  column("created_at", "timestamptz", 5, { nullable: false }),
]);

export const customersTable = table("public", "customers", 9_120, [
  column("id", "bigint", 1, { nullable: false, pk: true, identity: true }),
  column("name", "text", 2, { nullable: false }),
  column("segment", "text", 3),
]);

export const orderItemsTable = table("public", "order_items", 512_880, [
  column("id", "bigint", 1, { nullable: false, pk: true, identity: true }),
  column("order_id", "bigint", 2, { nullable: false }),
  column("sku", "text", 3, { nullable: false }),
  column("quantity", "integer", 4, { nullable: false }),
]);

export const monthlyRevenueTable = table(
  "public",
  "monthly_revenue",
  24,
  [
    column("month", "date", 1, { nullable: false }),
    column("revenue", "numeric(14,2)", 2, {
      precision: 14,
      scale: 2,
    }),
  ],
  "view",
);

export const longAuditTable = table(
  "audit",
  "audit_log_with_a_deliberately_long_table_name",
  2_048_000,
  [
    column("event_identifier_with_a_long_name", "uuid", 1, {
      nullable: false,
      pk: true,
    }),
    column("operation_context_json_document", "jsonb", 2, {
      nullable: false,
    }),
    column("recorded_at", "timestamptz", 3, { nullable: false }),
  ],
);

export const analyticsCatalog = {
  tables: [
    ordersTable,
    customersTable,
    orderItemsTable,
    monthlyRevenueTable,
    longAuditTable,
  ],
  objects: [
    {
      schema: "public",
      name: "refresh_monthly_revenue",
      kind: "routine",
      nativeId: null,
      detail: "function()",
      parent: null,
      arguments: [],
      returnType: "void",
      language: "sql",
      comment: "Fixture routine",
    },
  ],
} satisfies Catalog;

export const analyticsOverview = {
  relations: analyticsCatalog.tables.map((entry) => ({
    schema: entry.schema,
    name: entry.name,
    kind: entry.kind,
    nativeId: entry.nativeId,
    comment: entry.comment,
    rowEstimate: entry.rowEstimate,
    parent: null,
  })),
  detailState: "deferred",
} satisfies CatalogOverview;

function snapshotColumn(entry: CatalogColumn) {
  return {
    name: entry.name,
    ordinal: entry.ordinal,
    nativeType: entry.dataType,
    typeFamily:
      entry.dataType.includes("int")
        ? ("integer" as const)
        : entry.dataType.includes("numeric")
          ? ("decimal" as const)
          : entry.dataType.includes("json")
            ? ("json" as const)
            : entry.dataType.includes("time")
              ? ("timestamp" as const)
              : entry.dataType === "uuid"
                ? ("uuid" as const)
                : ("text" as const),
    length: entry.length,
    precision: entry.precision,
    scale: entry.scale,
    nullable: entry.nullable,
    defaultExpression: entry.defaultExpression,
    generatedExpression: entry.generatedExpression,
    identity: entry.identity,
    autoIncrement: entry.autoIncrement,
    collation: entry.collation,
    comment: entry.comment,
    sensitivity: null,
  };
}

export const analyticsSnapshot = {
  schemaVersion: 1,
  connectionId: "fixture-connection-0000-0000-0000-000000000001",
  engine: "postgres",
  database: "analytics",
  capturedAt: "2026-07-28T09:00:00.000Z",
  fingerprint: "fixture-catalog-fingerprint-analytics-v1",
  namespaces: [{ name: "public" }, { name: "audit" }],
  relations: analyticsCatalog.tables.map((entry) => ({
    object: {
      catalog: "analytics",
      namespace: entry.schema,
      name: entry.name,
      kind: entry.kind === "view" ? ("view" as const) : ("table" as const),
      nativeId: entry.nativeId,
    },
    comment: entry.comment,
    rowEstimate: entry.rowEstimate,
    partitionParent: null,
    partitionChildren: [],
    columns: entry.columns.map(snapshotColumn),
    constraints:
      entry.name === "orders"
        ? [
            {
              name: "orders_pkey",
              kind: "primary" as const,
              columns: ["id"],
              referencedRelation: null,
              referencedColumns: [],
              checkExpression: null,
              updateAction: null,
              deleteAction: null,
              deferrable: false,
              validated: true,
            },
            {
              name: "orders_customer_id_fkey",
              kind: "foreign" as const,
              columns: ["customer_id"],
              referencedRelation: {
                catalog: "analytics",
                namespace: "public",
                name: "customers",
                kind: "table" as const,
                nativeId: null,
              },
              referencedColumns: ["id"],
              checkExpression: null,
              updateAction: "NO ACTION",
              deleteAction: "RESTRICT",
              deferrable: false,
              validated: true,
            },
          ]
        : [],
    indexes: [],
  })),
  routines: [],
  otherObjects: [],
} satisfies CatalogSnapshot;

/** 읽기 전용 기본값. 승인 없이 write가 열리지 않는 상태를 기준으로 둔다. */
export const readOnlySafety = {
  requireApproval: true,
  allowWrites: false,
  wrapWritesInTx: true,
  explainPreview: true,
  autoRunReads: true,
  maxRows: 1_000,
  execPreviewRowLimit: 100,
} satisfies SafetySettings;

export const writeReviewSafety = {
  ...readOnlySafety,
  allowWrites: true,
  autoRunReads: false,
} satisfies SafetySettings;
