// Autosave state machine for one persisted SQL document. It owns debounce, local
// recovery, optimistic revision conflicts, and stale async response suppression.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { errMessage } from "../../ipc/types";
import type {
  ConnectionId,
  SqlDocument,
  SqlDocumentId,
} from "./domain";
import { sqlRecoveryKey } from "./domain";
import type { SqlDocumentGateway } from "./ports";
import type { SqlResolveMode } from "../queries/resolveMode";

export type DocumentSaveState =
  | "saved"
  | "dirty"
  | "saving"
  | "error"
  | "conflict";

export interface DocumentConflict {
  current: SqlDocument;
  localTitle: string;
  localSelectedSchema: string | null;
  localResolveMode: SqlResolveMode;
  localContent: string;
}

interface SqlDocumentAutosaveOptions {
  gateway: SqlDocumentGateway;
  connectionId: ConnectionId;
  documentId: SqlDocumentId | null;
  revision: number;
  title: string;
  selectedSchema: string | null;
  resolveMode: SqlResolveMode;
  content: string;
  recovered: boolean;
  onTitleChange: (title: string) => void;
  onSelectedSchemaChange: (selectedSchema: string | null) => void;
  onResolveModeChange: (resolveMode: SqlResolveMode) => void;
  onContentChange: (content: string) => void;
  onPersisted: (document: SqlDocument) => void;
}

export function useSqlDocumentAutosave({
  gateway,
  connectionId,
  documentId,
  revision,
  title,
  selectedSchema,
  resolveMode,
  content,
  recovered,
  onTitleChange,
  onSelectedSchemaChange,
  onResolveModeChange,
  onContentChange,
  onPersisted,
}: SqlDocumentAutosaveOptions) {
  const [saveState, setSaveState] = useState<DocumentSaveState>(
    recovered ? "dirty" : "saved",
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DocumentConflict | null>(null);
  const saveSequence = useRef(0);
  const callbacks = useRef({
    onTitleChange,
    onSelectedSchemaChange,
    onResolveModeChange,
    onContentChange,
    onPersisted,
  });
  callbacks.current = {
    onTitleChange,
    onSelectedSchemaChange,
    onResolveModeChange,
    onContentChange,
    onPersisted,
  };
  const persistedBaseline = useRef<{
    revision: number;
    title: string | null;
    selectedSchema: string | null | undefined;
    resolveMode: SqlResolveMode | undefined;
    content: string | null;
  }>({
    revision,
    title: recovered ? null : title,
    selectedSchema: recovered ? undefined : selectedSchema,
    resolveMode: recovered ? undefined : resolveMode,
    content: recovered ? null : content,
  });

  const persist = useCallback(
    async (
      expectedRevision: number,
      nextTitle: string,
      nextSelectedSchema: string | null,
      nextResolveMode: SqlResolveMode,
      nextContent: string,
    ) => {
      if (!documentId) return;
      const sequence = ++saveSequence.current;
      setSaveState("saving");
      setSaveError(null);
      try {
        const outcome = await gateway.save({
          id: documentId,
          connectionId,
          title: nextTitle,
          selectedSchema: nextSelectedSchema,
          resolveMode: nextResolveMode,
          content: nextContent,
          expectedRevision,
        });
        if (sequence !== saveSequence.current) return;
        if (!outcome.saved) {
          setConflict({
            current: outcome.document,
            localTitle: nextTitle,
            localSelectedSchema: nextSelectedSchema,
            localResolveMode: nextResolveMode,
            localContent: nextContent,
          });
          setSaveState("conflict");
          return;
        }
        persistedBaseline.current = {
          revision: outcome.document.localRevision,
          title: outcome.document.title,
          selectedSchema: outcome.document.selectedSchema,
          resolveMode: outcome.document.resolveMode,
          content: outcome.document.content,
        };
        localStorage.removeItem(sqlRecoveryKey(documentId));
        setConflict(null);
        setSaveState("saved");
        callbacks.current.onPersisted(outcome.document);
      } catch (error) {
        if (sequence !== saveSequence.current) return;
        setSaveError(errMessage(error));
        setSaveState("error");
      }
    },
    [connectionId, documentId, gateway],
  );

  useEffect(() => {
    if (!documentId || conflict) return;
    const baseline = persistedBaseline.current;
    const dirty =
      recovered ||
      baseline.revision !== revision ||
      baseline.title !== title ||
      baseline.selectedSchema !== selectedSchema ||
      baseline.resolveMode !== resolveMode ||
      baseline.content !== content;
    if (!dirty) {
      setSaveState("saved");
      return;
    }
    setSaveState("dirty");
    localStorage.setItem(
      sqlRecoveryKey(documentId),
      JSON.stringify({
        revision,
        title,
        selectedSchema,
        resolveMode,
        draft: content,
      }),
    );
    if (!title.trim()) return;
    const timer = window.setTimeout(() => {
      void persist(revision, title, selectedSchema, resolveMode, content);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    conflict,
    content,
    documentId,
    persist,
    recovered,
    revision,
    resolveMode,
    selectedSchema,
    title,
  ]);

  useEffect(
    () => () => {
      saveSequence.current += 1;
    },
    [],
  );

  const useSavedVersion = useCallback(() => {
    if (!documentId || !conflict) return;
    const current = conflict.current;
    saveSequence.current += 1;
    persistedBaseline.current = {
      revision: current.localRevision,
      title: current.title,
      selectedSchema: current.selectedSchema,
      resolveMode: current.resolveMode,
      content: current.content,
    };
    localStorage.removeItem(sqlRecoveryKey(documentId));
    callbacks.current.onTitleChange(current.title);
    callbacks.current.onSelectedSchemaChange(current.selectedSchema);
    callbacks.current.onResolveModeChange(current.resolveMode);
    callbacks.current.onContentChange(current.content);
    callbacks.current.onPersisted(current);
    setConflict(null);
    setSaveState("saved");
  }, [conflict, documentId]);

  const keepLocalVersion = useCallback(() => {
    if (!conflict) return;
    void persist(
      conflict.current.localRevision,
      conflict.localTitle,
      conflict.localSelectedSchema,
      conflict.localResolveMode,
      conflict.localContent,
    );
  }, [conflict, persist]);

  const reportError = useCallback((error: unknown) => {
    setSaveError(errMessage(error));
    setSaveState("error");
  }, []);

  return {
    saveState,
    saveError,
    conflict,
    useSavedVersion,
    keepLocalVersion,
    reportError,
  };
}
