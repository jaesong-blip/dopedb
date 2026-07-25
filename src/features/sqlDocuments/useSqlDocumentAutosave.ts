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

export type DocumentSaveState =
  | "saved"
  | "dirty"
  | "saving"
  | "error"
  | "conflict";

export interface DocumentConflict {
  current: SqlDocument;
  localTitle: string;
  localContent: string;
}

interface SqlDocumentAutosaveOptions {
  gateway: SqlDocumentGateway;
  connectionId: ConnectionId;
  documentId: SqlDocumentId | null;
  revision: number;
  title: string;
  content: string;
  recovered: boolean;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
  onPersisted: (document: SqlDocument) => void;
}

export function useSqlDocumentAutosave({
  gateway,
  connectionId,
  documentId,
  revision,
  title,
  content,
  recovered,
  onTitleChange,
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
    onContentChange,
    onPersisted,
  });
  callbacks.current = {
    onTitleChange,
    onContentChange,
    onPersisted,
  };
  const persistedBaseline = useRef<{
    revision: number;
    title: string | null;
    content: string | null;
  }>({
    revision,
    title: recovered ? null : title,
    content: recovered ? null : content,
  });

  const persist = useCallback(
    async (
      expectedRevision: number,
      nextTitle: string,
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
          content: nextContent,
          expectedRevision,
        });
        if (sequence !== saveSequence.current) return;
        if (!outcome.saved) {
          setConflict({
            current: outcome.document,
            localTitle: nextTitle,
            localContent: nextContent,
          });
          setSaveState("conflict");
          return;
        }
        persistedBaseline.current = {
          revision: outcome.document.localRevision,
          title: outcome.document.title,
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
      baseline.content !== content;
    if (!dirty) {
      setSaveState("saved");
      return;
    }
    setSaveState("dirty");
    localStorage.setItem(
      sqlRecoveryKey(documentId),
      JSON.stringify({ revision, title, draft: content }),
    );
    if (!title.trim()) return;
    const timer = window.setTimeout(() => {
      void persist(revision, title, content);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    conflict,
    content,
    documentId,
    persist,
    recovered,
    revision,
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
      content: current.content,
    };
    localStorage.removeItem(sqlRecoveryKey(documentId));
    callbacks.current.onTitleChange(current.title);
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
