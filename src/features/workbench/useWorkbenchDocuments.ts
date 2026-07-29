// Single writer for workbench document state. It coordinates connection changes,
// persisted SQL restoration, tab commands, and optimistic save projections.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import {
  connectionId,
  type SqlDocument,
} from "../sqlDocuments/domain";
import type { SqlDocumentGateway } from "../sqlDocuments/ports";
import {
  persistedQueryDocument,
  queryDocument,
  stableDocument,
  type WorkbenchDocument,
} from "./domain";
import {
  emptyWorkbenchState,
  workbenchReducer,
} from "./state";

interface UseWorkbenchDocumentsOptions {
  selectedConnectionId: string | null;
  supportsSql: boolean;
  restoredDocumentKind: WorkbenchDocument["kind"];
  sqlDocuments: SqlDocumentGateway;
  onRestoreError?: (error: unknown) => void;
}

interface OpenQueryOptions {
  connectionId: string;
  supportsSql: boolean;
  title?: string;
  content?: string;
}

export function useWorkbenchDocuments({
  selectedConnectionId,
  supportsSql,
  restoredDocumentKind,
  sqlDocuments,
  onRestoreError,
}: UseWorkbenchDocumentsOptions) {
  const [state, dispatch] = useReducer(workbenchReducer, emptyWorkbenchState);
  const loadToken = useRef(0);
  const pendingInitial = useRef<WorkbenchDocument | null>(null);
  const restoreError = useRef(onRestoreError);
  restoreError.current = onRestoreError;

  useEffect(() => {
    const token = ++loadToken.current;
    if (!selectedConnectionId) {
      pendingInitial.current = null;
      dispatch({ type: "reset" });
      return;
    }

    const preferred = supportsSql
      ? restoredDocumentKind === "documents"
        ? "schema"
        : restoredDocumentKind
      : restoredDocumentKind === "sql"
        ? "documents"
        : restoredDocumentKind;
    const queued = pendingInitial.current;
    pendingInitial.current = null;
    const initial =
      queued?.connectionId === selectedConnectionId
        ? queued
        : preferred === "sql"
          ? stableDocument(selectedConnectionId, "schema")
          : preferred === "documents"
            ? queryDocument(selectedConnectionId, "documents")
            : stableDocument(
                selectedConnectionId,
                preferred === "activity" ? "activity" : "schema",
              );
    dispatch({ type: "initialize", document: initial });

    if (!supportsSql) return;
    void sqlDocuments
      .list(connectionId(selectedConnectionId))
      .then(async (stored) => {
        if (token !== loadToken.current) return;
        let restored = stored;
        if (preferred === "sql" && restored.length === 0) {
          restored = [
            await sqlDocuments.create({
              connectionId: connectionId(selectedConnectionId),
              title: "Untitled query",
              content: "SELECT 1;",
            }),
          ];
        }
        if (token !== loadToken.current) return;
        dispatch({
          type: "restoreSql",
          connectionId: selectedConnectionId,
          documents: restored,
          activateFirst: preferred === "sql",
        });
      })
      .catch((error) => {
        if (token === loadToken.current) restoreError.current?.(error);
      });
  }, [
    restoredDocumentKind,
    selectedConnectionId,
    sqlDocuments,
    supportsSql,
  ]);

  const selectedDocuments = useMemo(
    () =>
      state.documents.filter(
        (document) => document.connectionId === selectedConnectionId,
      ),
    [selectedConnectionId, state.documents],
  );
  const activeDocument =
    selectedDocuments.find(
      (document) => document.id === state.activeDocumentId,
    ) ?? null;

  const reset = useCallback(() => {
    loadToken.current += 1;
    pendingInitial.current = null;
    dispatch({ type: "reset" });
  }, []);

  const prime = useCallback((document: WorkbenchDocument) => {
    loadToken.current += 1;
    pendingInitial.current = document;
    dispatch({ type: "initialize", document });
  }, []);

  const activate = useCallback((document: WorkbenchDocument) => {
    dispatch({ type: "activate", document });
  }, []);

  const activateId = useCallback((id: string) => {
    dispatch({ type: "activateId", id });
  }, []);

  const close = useCallback(
    (id: string, connection: string, keepSchemaFallback: boolean) => {
      dispatch({
        type: "close",
        id,
        connectionId: connection,
        keepSchemaFallback,
      });
    },
    [],
  );

  const updateDraft = useCallback((id: string, draft: string) => {
    dispatch({ type: "updateDraft", id, draft });
  }, []);

  const updateTitle = useCallback((id: string, title: string) => {
    dispatch({ type: "updateTitle", id, title });
  }, []);

  const updateSelectedSchema = useCallback(
    (id: string, selectedSchema: string | null) => {
      dispatch({ type: "updateSelectedSchema", id, selectedSchema });
    },
    [],
  );

  const applyPersisted = useCallback((id: string, document: SqlDocument) => {
    dispatch({ type: "persist", id, document });
  }, []);

  const openQuery = useCallback(
    async ({
      connectionId: rawConnectionId,
      supportsSql: canUseSql,
      title = "Untitled query",
      content = "SELECT 1;",
    }: OpenQueryOptions): Promise<WorkbenchDocument> => {
      if (!canUseSql) {
        return queryDocument(rawConnectionId, "documents", content);
      }
      const document = await sqlDocuments.create({
        connectionId: connectionId(rawConnectionId),
        title,
        content,
      });
      return persistedQueryDocument(document);
    },
    [sqlDocuments],
  );

  return {
    selectedDocuments,
    activeDocument,
    activeDocumentId: state.activeDocumentId,
    reset,
    prime,
    activate,
    activateId,
    close,
    updateDraft,
    updateTitle,
    updateSelectedSchema,
    applyPersisted,
    openQuery,
  };
}
