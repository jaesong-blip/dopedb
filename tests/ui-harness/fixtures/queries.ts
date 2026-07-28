// SQL document, proposal, result fixture. 모든 식별자와 payload hash는 fixture임이
// 명백하며 실제 database, credential 또는 사용자의 query를 담지 않는다.
import type { HarnessCommandHandler, HarnessIpcMap } from "../runtime/commandRouter";
import type {
  ExecOutcome,
  QueryResult,
  ScriptOutcome,
} from "../../../src/ipc/types";
import type { SqlOperationProposal } from "../../../src/features/queries/domain";
import {
  connectionId,
  sqlDocumentId,
  type SqlDocument,
} from "../../../src/features/sqlDocuments/domain";
import { analyticsPostgres } from "./connections";

export const analyticsSqlDocument = {
  id: sqlDocumentId("fixture-sql-document-0001"),
  connectionId: connectionId(analyticsPostgres.id),
  title: "Revenue review",
  dialect: "postgres",
  content:
    "SELECT count(*) AS orders FROM public.orders;\nSELECT sum(total) AS revenue FROM public.orders;",
  localRevision: 3,
  remoteId: null,
  remoteRevision: null,
  dirty: false,
  syncStatus: "local",
  createdAt: "2026-07-20T03:00:00.000Z",
  updatedAt: "2026-07-28T08:50:00.000Z",
} satisfies SqlDocument;

export const permissionSqlDocument = {
  ...analyticsSqlDocument,
  id: sqlDocumentId("fixture-sql-document-0002"),
  title: "Archive old orders",
  content: "DELETE FROM public.orders WHERE status = 'cancelled';",
  localRevision: 1,
} satisfies SqlDocument;

function classification(kind: "read" | "write", table = "public.orders") {
  return {
    kind,
    risk: kind === "read" ? ("low" as const) : ("high" as const),
    statementCount: 1,
    noWhere: false,
    tables: [table],
    notes:
      kind === "read"
        ? ["Fixture bounded read"]
        : ["Fixture write requires an exact approval"],
    rollbackSafe: kind === "write",
  };
}

function proposal(
  operationId: string,
  kind: "read" | "write",
): SqlOperationProposal {
  return {
    operationId,
    payloadHash: `fixture-payload-hash-${operationId}`,
    state: kind === "read" ? "ready" : "pending_approval",
    approvalRequired: kind === "write",
    autoRun: false,
    confirmationPhrase: kind === "write" ? "CONFIRM FIXTURE WRITE" : null,
    expiresAt: "2026-07-28T10:00:00.000Z",
    classification: classification(kind),
    preview: {
      mode: kind === "read" ? "explain" : "execRollback",
      estimatedRows: kind === "read" ? 128_400 : 42,
      exactRows: kind === "write" ? 42 : null,
      plan: kind === "read" ? "Fixture index scan on orders" : null,
      note: kind === "write" ? "Fixture transaction rolls back during preview" : null,
    },
  };
}

export const permissionProposal = proposal("fixture-operation-write-review", "write");

export const ordersResult = {
  columns: ["id", "customer_id", "status", "total", "created_at"],
  rows: [
    [10_104, 501, "paid", "184.25", "2026-07-28T08:41:00.000Z"],
    [10_103, 488, "processing", "92.10", "2026-07-28T08:35:00.000Z"],
    [10_102, 501, "paid", "48.00", "2026-07-28T08:21:00.000Z"],
    [10_101, 477, "refunded", "12.75", "2026-07-28T08:03:00.000Z"],
  ],
  rowCount: 4,
  truncated: false,
  durationMs: 18,
} satisfies QueryResult;

export const emptyOrdersResult = {
  columns: ordersResult.columns,
  rows: [],
  rowCount: 0,
  truncated: false,
  durationMs: 7,
} satisfies QueryResult;

export const longAuditResult = {
  columns: [
    "event_identifier_with_a_long_name",
    "operation_context_json_document",
    "recorded_at",
  ],
  rows: [
    [
      "fixture-event-00000000000000000000000000000001",
      {
        actor: "fixture-agent",
        operation: "schema_read",
        path: [
          "analytics",
          "audit",
          "audit_log_with_a_deliberately_long_table_name",
        ],
        note:
          "A deliberately long fixture value verifies that adjacent toolbar controls keep their bounds.",
      },
      "2026-07-28T08:41:00.000Z",
    ],
  ],
  rowCount: 1,
  truncated: false,
  durationMs: 21,
} satisfies QueryResult;

function readOperationId(sql: string) {
  return /count\s*\(\s*\*\s*\)/i.test(sql)
    ? "fixture-operation-count"
    : "fixture-operation-page";
}

export function tableReadIpc(
  pageResult: QueryResult,
  total: number,
): HarnessIpcMap {
  const propose: HarnessCommandHandler = ({ payload }) => {
    const sql = String((payload as { sql?: unknown } | null)?.sql ?? "");
    return proposal(readOperationId(sql), "read");
  };
  const run: HarnessCommandHandler = ({ payload }) => {
    const operationId = String(
      (payload as { operationId?: unknown } | null)?.operationId ?? "",
    );
    const result =
      operationId === "fixture-operation-count"
        ? {
            columns: ["count"],
            rows: [[total]],
            rowCount: 1,
            truncated: false,
            durationMs: 5,
          }
        : pageResult;
    return {
      result,
      affected: null,
      committed: false,
    } satisfies ExecOutcome;
  };
  return { propose_sql: propose, run_sql: run };
}

export const revenueScriptOutcome = {
  statements: [
    {
      sql: "SELECT count(*) AS orders FROM public.orders",
      result: {
        columns: ["orders"],
        rows: [[128_400]],
        rowCount: 1,
        truncated: false,
        durationMs: 12,
      },
      affected: null,
      error: null,
    },
    {
      sql: "SELECT sum(total) AS revenue FROM public.orders",
      result: {
        columns: ["revenue"],
        rows: [["8421942.55"]],
        rowCount: 1,
        truncated: false,
        durationMs: 15,
      },
      affected: null,
      error: null,
    },
  ],
  committed: false,
  allReads: true,
} satisfies ScriptOutcome;

export const revenueScriptProposal = {
  operationId: "fixture-operation-script-read",
  payloadHash: "fixture-payload-hash-script-read",
  state: "ready",
  approvalRequired: false,
  confirmationPhrase: null,
  statementCount: 2,
  expiresAt: "2026-07-28T10:00:00.000Z",
};
