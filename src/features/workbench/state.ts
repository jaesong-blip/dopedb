// Pure state machine for the workbench document strip. React effects and UI handlers
// dispatch commands here instead of mutating document arrays in multiple places.

import type { SqlDocument } from "../sqlDocuments/domain";
import {
  persistedQueryDocument,
  stableDocument,
  type WorkbenchDocument,
} from "./domain";

export interface WorkbenchState {
  documents: WorkbenchDocument[];
  activeDocumentId: string | null;
}

export const emptyWorkbenchState: WorkbenchState = {
  documents: [],
  activeDocumentId: null,
};

export type WorkbenchAction =
  | { type: "reset" }
  | { type: "initialize"; document: WorkbenchDocument }
  | {
      type: "restoreSql";
      connectionId: string;
      documents: SqlDocument[];
      activateFirst: boolean;
    }
  | { type: "activate"; document: WorkbenchDocument }
  | { type: "activateId"; id: string }
  | {
      type: "close";
      id: string;
      connectionId: string;
      keepSchemaFallback: boolean;
    }
  | { type: "updateDraft"; id: string; draft: string }
  | { type: "updateTitle"; id: string; title: string }
  | { type: "persist"; id: string; document: SqlDocument };

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case "reset":
      return emptyWorkbenchState;
    case "initialize":
      return {
        documents: [action.document],
        activeDocumentId: action.document.id,
      };
    case "restoreSql": {
      const restored = action.documents.map(persistedQueryDocument);
      const documents = [
        ...state.documents.filter(
          (document) =>
            document.connectionId !== action.connectionId || document.kind !== "sql",
        ),
        ...restored,
      ];
      return {
        documents,
        activeDocumentId:
          action.activateFirst && restored[0]
            ? restored[0].id
            : documents.some((document) => document.id === state.activeDocumentId)
              ? state.activeDocumentId
              : (documents[0]?.id ?? null),
      };
    }
    case "activate":
      return {
        documents: state.documents.some(
          (document) => document.id === action.document.id,
        )
          ? state.documents
          : [...state.documents, action.document],
        activeDocumentId: action.document.id,
      };
    case "activateId":
      return state.documents.some((document) => document.id === action.id)
        ? { ...state, activeDocumentId: action.id }
        : state;
    case "close": {
      const selected = state.documents.filter(
        (document) => document.connectionId === action.connectionId,
      );
      const index = selected.findIndex((document) => document.id === action.id);
      if (index < 0) return state;
      let remaining = selected.filter((document) => document.id !== action.id);
      if (remaining.length === 0 && action.keepSchemaFallback) {
        remaining = [stableDocument(action.connectionId, "schema")];
      }
      const documents = [
        ...state.documents.filter(
          (document) => document.connectionId !== action.connectionId,
        ),
        ...remaining,
      ];
      return {
        documents,
        activeDocumentId:
          state.activeDocumentId === action.id
            ? (remaining[Math.min(index, Math.max(0, remaining.length - 1))]?.id ??
              null)
            : state.activeDocumentId,
      };
    }
    case "updateDraft":
      return {
        ...state,
        documents: state.documents.map((document) =>
          document.id === action.id &&
          (document.kind === "sql" || document.kind === "documents")
            ? { ...document, draft: action.draft }
            : document,
        ),
      };
    case "updateTitle":
      return {
        ...state,
        documents: state.documents.map((document) =>
          document.id === action.id && document.kind === "sql"
            ? { ...document, title: action.title }
            : document,
        ),
      };
    case "persist":
      return {
        ...state,
        documents: state.documents.map((document) =>
          document.id === action.id && document.kind === "sql"
            ? {
                ...document,
                draft: action.document.content,
                title: action.document.title,
                revision: action.document.localRevision,
                recovered: false,
              }
            : document,
        ),
      };
  }
}
