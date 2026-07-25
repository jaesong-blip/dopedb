import { describe, expect, it } from "vitest";
import { connectionId, sqlDocumentId, type SqlDocument } from "../sqlDocuments/domain";
import { queryDocument, stableDocument } from "./domain";
import { emptyWorkbenchState, workbenchReducer } from "./state";

function storedDocument(id = "doc-1"): SqlDocument {
  return {
    id: sqlDocumentId(id),
    connectionId: connectionId("db-1"),
    title: "Saved query",
    dialect: "postgresql",
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
  it("restores persisted SQL without removing the connection schema document", () => {
    const schema = stableDocument("db-1", "schema");
    const initialized = workbenchReducer(emptyWorkbenchState, {
      type: "initialize",
      document: schema,
    });
    const restored = workbenchReducer(initialized, {
      type: "restoreSql",
      connectionId: "db-1",
      documents: [storedDocument()],
      activateFirst: true,
    });

    expect(restored.documents.map((document) => document.kind)).toEqual([
      "schema",
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
  });

  it("creates the schema fallback when the last SQL tab closes", () => {
    const query = queryDocument("db-1", "sql");
    const state = workbenchReducer(emptyWorkbenchState, {
      type: "activate",
      document: query,
    });
    const closed = workbenchReducer(state, {
      type: "close",
      id: query.id,
      connectionId: "db-1",
      keepSchemaFallback: true,
    });

    expect(closed.documents).toEqual([stableDocument("db-1", "schema")]);
    expect(closed.activeDocumentId).toBe("db-1:schema");
  });

  it("applies a successful save through the one state reducer", () => {
    const query = queryDocument("db-1", "sql", "SELECT 0;");
    const state = workbenchReducer(emptyWorkbenchState, {
      type: "activate",
      document: query,
    });
    const persisted = workbenchReducer(state, {
      type: "persist",
      id: query.id,
      document: storedDocument(),
    });
    const current = persisted.documents[0];

    expect(current?.kind).toBe("sql");
    if (current?.kind !== "sql") throw new Error("expected SQL document");
    expect(current.draft).toBe("SELECT 1;");
    expect(current.revision).toBe(2);
  });
});
