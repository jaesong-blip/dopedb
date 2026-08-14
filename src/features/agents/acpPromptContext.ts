// The Agent composer can attach a bounded projection of the active workbench
// context. This pure model keeps draft reads and selection matching out of the
// ACP session controller and the visual composer.

import type { CatalogTable } from "../../ipc/types";
import type { ConnectionProfile } from "../connections/domain";
import type { WorkbenchDocument } from "../workbench/domain";
import { readWorkbenchDraft } from "../workbench/draftStore";
import type { AcpPromptContext, AcpTableContext } from "./domain";

const MAX_DOCUMENT_CONTEXT_CHARS = 16 * 1024;

type AgentSelection = AcpTableContext & {
  connectionId: string;
};

export type AcpContextLabel = {
  icon: "database" | "file" | "table" | "columns";
  text: string;
};

export function buildAcpPromptContext(
  connection: ConnectionProfile,
  activeDocument: WorkbenchDocument | null,
  selectedTable: CatalogTable | null,
  selection: AgentSelection | null,
): AcpPromptContext {
  const document =
    activeDocument?.kind === "sql"
      ? {
          database: activeDocument.selectedDatabase || connection.database,
          documentName: activeDocument.title,
          documentText: readWorkbenchDraft(
            activeDocument.id,
            activeDocument.draft,
          ).slice(0, MAX_DOCUMENT_CONTEXT_CHARS),
        }
      : {
          database: null,
          documentName: null,
          documentText: null,
        };
  const activeDataTable =
    activeDocument?.kind === "data" ? activeDocument.table : selectedTable;
  if (!activeDataTable) {
    return {
      ...document,
      database: document.database ?? connection.database,
      table: null,
    };
  }
  const database = activeDataTable.database ?? connection.database;
  const selectedMatches =
    selection?.connectionId === connection.id &&
    (selection.database ?? connection.database) === database &&
    selection.table === activeDataTable.name &&
    (selection.schema ?? null) === (activeDataTable.schema ?? null);
  return {
    ...document,
    database,
    table: selectedMatches
      ? {
          database: selection.database,
          schema: selection.schema,
          table: selection.table,
          column: selection.column,
          rowIndex: selection.rowIndex,
          row: selection.row,
        }
      : {
          database,
          schema: activeDataTable.schema ?? null,
          table: activeDataTable.name,
          column: null,
          rowIndex: null,
          row: null,
        },
  };
}

export function summarizeAcpPromptContext(
  context: AcpPromptContext,
): AcpContextLabel[] {
  const labels: AcpContextLabel[] = [];
  if (context.database !== null) {
    labels.push({
      icon: "database",
      text: context.database,
    });
  }
  if (context.documentText !== null) {
    labels.push({
      icon: "file",
      text: context.documentName ?? "SQL document",
    });
  }
  if (context.table) {
    labels.push({
      icon: "table",
      text: [
        context.table.database,
        context.table.schema,
        context.table.table,
      ].filter(Boolean).join("."),
    });
    if (context.table.column) {
      labels.push({
        icon: "columns",
        text: context.table.row
          ? `${context.table.column} · row ${(context.table.rowIndex ?? 0) + 1}`
          : context.table.column,
      });
    }
  }
  return labels;
}
