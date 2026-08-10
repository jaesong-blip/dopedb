import { describe, expect, it } from "vitest";
import {
  connectionId,
  retrySqlDocumentConflict,
  sqlDocumentConflict,
  sqlDocumentId,
  type SqlDocument,
} from "../sqlDocuments/domain";
import {
  findSqlParameters,
  materializeSqlParameters,
} from "../query/sqlParameters";
import { resolveSqlNamespaceAtCaret } from "../queries/resolveMode";
import { sqlExecutionMarkerPosition } from "../queries/editorStatus";
import {
  canFallbackFromCombinedRead,
  initialSqlRunPath,
} from "../../screens/Sql/runPath";
import { queryDocument, stableDocument } from "./domain";
import {
  publishWorkbenchDraft,
  readWorkbenchDraft,
  seedWorkbenchDraft,
} from "./draftStore";
import { emptyWorkbenchState, workbenchReducer } from "./state";

function storedDocument(id = "doc-1"): SqlDocument {
  return {
    id: sqlDocumentId(id),
    connectionId: connectionId("db-1"),
    title: "Saved query",
    dialect: "postgresql",
    selectedDatabase: "app",
    selectedSchema: "billing",
    resolveMode: "script",
    content: "SELECT 1;",
    localRevision: 2,
    remoteId: null,
    remoteRevision: null,
    dirty: true,
    syncStatus: "local",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("workbench state ownership", () => {
  it("restores persisted SQL without removing the connection welcome document", () => {
    const welcome = stableDocument("db-1", "welcome");
    const initialized = workbenchReducer(emptyWorkbenchState, {
      type: "initialize",
      document: welcome,
    });
    const restored = workbenchReducer(initialized, {
      type: "restoreSql",
      connectionId: "db-1",
      documents: [storedDocument()],
      activateFirst: true,
    });

    expect(restored.documents.map((document) => document.kind)).toEqual([
      "welcome",
      "sql",
    ]);
    expect(restored.activeDocumentId).toContain(":sql:doc-1");
  });

  it("keeps one document instance and moves only the active pointer", () => {
    const query = queryDocument("db-1", "sql");
    const first = workbenchReducer(emptyWorkbenchState, {
      type: "activate",
      document: query,
    });
    const second = workbenchReducer(first, {
      type: "activate",
      document: query,
    });

    expect(second.documents).toHaveLength(1);
    expect(second.activeDocumentId).toBe(query.id);

    seedWorkbenchDraft(query.id, query.draft ?? "");
    publishWorkbenchDraft(query.id, "SELECT 42;");
    expect(readWorkbenchDraft(query.id, "SELECT 0;")).toBe("SELECT 42;");
    seedWorkbenchDraft(query.id, "SELECT 84;");
    expect(readWorkbenchDraft(query.id, "SELECT 0;")).toBe("SELECT 84;");
    expect(second.documents[0]).toBe(query);
  });

  it("creates the welcome fallback when the last SQL tab closes", () => {
    const query = queryDocument("db-1", "sql");
    const state = workbenchReducer(emptyWorkbenchState, {
      type: "activate",
      document: query,
    });
    const closed = workbenchReducer(state, {
      type: "close",
      id: query.id,
      connectionId: "db-1",
      keepWelcomeFallback: true,
    });

    expect(closed.documents).toEqual([stableDocument("db-1", "welcome")]);
    expect(closed.activeDocumentId).toBe("db-1:welcome");
  });

  it("applies a successful save through the one state reducer", () => {
    const query = queryDocument("db-1", "sql", "SELECT 0;");
    const state = workbenchReducer(emptyWorkbenchState, {
      type: "activate",
      document: query,
    });
    const databaseSelected = workbenchReducer(state, {
      type: "updateSelectedDatabase",
      id: query.id,
      selectedDatabase: "analytics",
    });
    const databaseDocument = databaseSelected.documents[0];
    expect(databaseDocument?.kind === "sql" && databaseDocument.selectedSchema).toBeNull();
    const selected = workbenchReducer(databaseSelected, {
      type: "updateSelectedSchema",
      id: query.id,
      selectedSchema: "public",
    });
    const resolved = workbenchReducer(selected, {
      type: "updateResolveMode",
      id: query.id,
      resolveMode: "playground",
    });
    const persisted = workbenchReducer(resolved, {
      type: "persist",
      id: query.id,
      document: storedDocument(),
    });
    const current = persisted.documents[0];

    expect(current?.kind).toBe("sql");
    if (current?.kind !== "sql") throw new Error("expected SQL document");
    expect(current.draft).toBe("SELECT 1;");
    expect(current.revision).toBe(2);
    expect(current.selectedDatabase).toBe("app");
    expect(current.selectedSchema).toBe("billing");
    expect(current.resolveMode).toBe("script");
    expect(
      resolveSqlNamespaceAtCaret({
        sqlBeforeCaret:
          "SELECT * FROM users;\nSET search_path TO billing;\nSELECT * FROM invoices",
        engine: "postgres",
        mode: current.resolveMode,
        selectedNamespace: "public",
        namespaceOptions: ["billing", "public"],
      }),
    ).toBe("billing");
    expect(
      resolveSqlNamespaceAtCaret({
        sqlBeforeCaret:
          "-- SET search_path TO billing;\nSELECT 'USE billing' AS note",
        engine: "postgres",
        mode: "script",
        selectedNamespace: "public",
        namespaceOptions: ["billing", "public"],
      }),
    ).toBe("public");

    expect(initialSqlRunPath(true, "SELECT * FROM invoices")).toBe(
      "combinedReadStream",
    );
    expect(
      initialSqlRunPath(true, "-- invoice list\nSELECT * FROM invoices"),
    ).toBe("combinedReadStream");
    expect(
      initialSqlRunPath(
        true,
        "UPDATE invoices SET state = state WHERE 1 = 0",
      ),
    ).toBe("plannedReadStream");
    expect(
      initialSqlRunPath(
        true,
        "WITH changed AS (DELETE FROM invoices RETURNING id) SELECT * FROM changed",
      ),
    ).toBe("plannedReadStream");
    expect(
      initialSqlRunPath(true, "SELECT * FROM invoices FOR UPDATE"),
    ).toBe("plannedReadStream");
    expect(initialSqlRunPath(false, "SELECT * FROM invoices")).toBe(
      "plannedReadStream",
    );
    expect(canFallbackFromCombinedRead("proposalRequired")).toBe(true);
    expect(canFallbackFromCombinedRead("network")).toBe(false);

    const parameterSql =
      "SELECT * FROM invoices WHERE account_id = :account AND created_at >= ${since}";
    const parameters = findSqlParameters(parameterSql, "postgres");
    expect(materializeSqlParameters(parameterSql, parameters, {
      "named:account": "42",
      "named:since": "DATE '2026-01-01'",
    })).toBe(
      "SELECT * FROM invoices WHERE account_id = 42 AND created_at >= DATE '2026-01-01'",
    );

    const executedSql = "SELECT 1;\nSELECT 2;";
    const executionStatus = {
      source: { sql: "SELECT 2;", from: 10, to: 19 },
      state: "completed" as const,
      label: "Completed",
    };
    expect(sqlExecutionMarkerPosition(executedSql, executionStatus)).toBe(19);
    expect(
      sqlExecutionMarkerPosition("SELECT 1;\nSELECT 3;", executionStatus),
    ).toBeNull();

    const conflict = sqlDocumentConflict(storedDocument(), {
      title: "Local query",
      selectedDatabase: "analytics",
      selectedSchema: "public",
      resolveMode: "playground",
      content: "SELECT * FROM events;",
    });
    expect(retrySqlDocumentConflict(conflict)).toEqual({
      expectedRevision: 2,
      title: "Local query",
      selectedDatabase: "analytics",
      selectedSchema: "public",
      resolveMode: "playground",
      content: "SELECT * FROM events;",
    });
  });
});
