// Workbench document domain. Stable ids describe singleton resources, while query
// documents use unique ids and retain their connection scope.

import type { CatalogTable } from "../../ipc/types";
import type { SqlDocument } from "../sqlDocuments/domain";
import { sqlRecoveryKey } from "../sqlDocuments/domain";
import { tableKey } from "../../lib/tableRef";

export type WorkbenchDocument =
  | {
      id: string;
      connectionId: string;
      kind: "data";
      table: CatalogTable;
    }
  | {
      id: string;
      connectionId: string;
      kind: "schema" | "activity";
    }
  | {
      id: string;
      connectionId: string;
      kind: "sql";
      draft: string;
      title: string;
      selectedSchema: string | null;
      persistedId: string | null;
      revision: number;
      recovered: boolean;
    }
  | {
      id: string;
      connectionId: string;
      kind: "documents";
      draft: string | null;
    };

export type QueryDocument = Extract<
  WorkbenchDocument,
  { kind: "sql" | "documents" }
>;

let sequence = 0;

export function stableDocument(
  connectionId: string,
  kind: "schema" | "activity",
): WorkbenchDocument {
  return { id: `${connectionId}:${kind}`, connectionId, kind };
}

export function tableDocument(
  connectionId: string,
  table: CatalogTable,
): WorkbenchDocument {
  return {
    id: `${connectionId}:data:${tableKey(table)}`,
    connectionId,
    kind: "data",
    table,
  };
}

export function queryDocument(
  connectionId: string,
  kind: QueryDocument["kind"],
  draft?: string | null,
): QueryDocument {
  sequence += 1;
  const suffix = `${Date.now().toString(36)}-${sequence.toString(36)}`;
  return kind === "sql"
      ? {
        id: `${connectionId}:sql:${suffix}`,
        connectionId,
        kind,
        draft: draft ?? "SELECT 1;",
        title: "Untitled query",
        selectedSchema: null,
        persistedId: null,
        revision: 0,
        recovered: false,
      }
    : {
        id: `${connectionId}:documents:${suffix}`,
        connectionId,
        kind,
        draft: draft ?? null,
      };
}

interface SqlRecoverySnapshot {
  revision: number;
  title: string;
  draft: string;
  selectedSchema: string | null;
}

function readRecovery(document: SqlDocument): SqlRecoverySnapshot | null {
  try {
    const raw = localStorage.getItem(sqlRecoveryKey(document.id));
    if (!raw) return null;
    const recovery = JSON.parse(raw) as Partial<SqlRecoverySnapshot>;
    if (
      recovery.revision !== document.localRevision ||
      typeof recovery.title !== "string" ||
      typeof recovery.draft !== "string" ||
      !(
        recovery.selectedSchema === undefined ||
        recovery.selectedSchema === null ||
        typeof recovery.selectedSchema === "string"
      )
    ) {
      return null;
    }
    return {
      revision: recovery.revision,
      title: recovery.title,
      draft: recovery.draft,
      selectedSchema: recovery.selectedSchema ?? null,
    };
  } catch {
    return null;
  }
}

export function persistedQueryDocument(document: SqlDocument): QueryDocument {
  const recovery = readRecovery(document);
  return {
    id: `${document.connectionId}:sql:${document.id}`,
    connectionId: document.connectionId,
    kind: "sql",
    draft: recovery?.draft ?? document.content,
    title: recovery?.title ?? document.title,
    selectedSchema: recovery?.selectedSchema ?? document.selectedSchema,
    persistedId: document.id,
    revision: document.localRevision,
    recovered:
      !!recovery &&
      (recovery.draft !== document.content ||
        recovery.title !== document.title ||
        recovery.selectedSchema !== document.selectedSchema),
  };
}

export function supportsDocument(
  document: WorkbenchDocument,
  connectionId: string,
  supportsSql: boolean,
) {
  return (
    document.connectionId === connectionId &&
    (supportsSql ? document.kind !== "documents" : document.kind !== "sql")
  );
}
