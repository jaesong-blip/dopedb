// SQL document domain contract. Branded ids prevent a workspace, connection, and
// document string from being passed to the wrong feature command by accident.

import type { SqlResolveMode } from "../queries/resolveMode";

declare const connectionIdBrand: unique symbol;
declare const sqlDocumentIdBrand: unique symbol;

export type ConnectionId = string & { readonly [connectionIdBrand]: true };
export type SqlDocumentId = string & { readonly [sqlDocumentIdBrand]: true };

export function connectionId(value: string): ConnectionId {
  return value as ConnectionId;
}

export function sqlDocumentId(value: string): SqlDocumentId {
  return value as SqlDocumentId;
}

export interface SqlDocument {
  id: SqlDocumentId;
  connectionId: ConnectionId;
  title: string;
  dialect: string;
  selectedDatabase: string;
  selectedSchema: string | null;
  resolveMode: SqlResolveMode;
  content: string;
  localRevision: number;
  remoteId: string | null;
  remoteRevision: number | null;
  dirty: boolean;
  syncStatus: "local" | "dirty" | "synced" | "conflict";
  createdAt: string;
  updatedAt: string;
}

export interface SqlDocumentRevision {
  documentId: SqlDocumentId;
  localRevision: number;
  content: string;
  createdAt: string;
}

export interface SqlDocumentRevisionSummary {
  documentId: SqlDocumentId;
  localRevision: number;
  contentPreview: string;
  contentTruncated: boolean;
  createdAt: string;
}

export interface SqlDocumentRevisionPage {
  items: SqlDocumentRevisionSummary[];
  nextCursor: number | null;
}

export interface SqlDocumentRevisionPageRequest {
  connectionId: ConnectionId;
  id: SqlDocumentId;
  cursor: number | null;
  search: string | null;
}

export interface CreateSqlDocumentRequest {
  connectionId: ConnectionId;
  title?: string | null;
  selectedDatabase?: string | null;
  selectedSchema?: string | null;
  resolveMode?: SqlResolveMode | null;
  content?: string | null;
}

export interface SaveSqlDocumentRequest {
  id: SqlDocumentId;
  connectionId: ConnectionId;
  title: string;
  selectedDatabase: string;
  selectedSchema: string | null;
  resolveMode: SqlResolveMode;
  content: string;
  expectedRevision: number;
}

export interface SaveSqlDocumentOutcome {
  saved: boolean;
  document: SqlDocument;
  expectedRevision: number;
  attemptedContentHash: string;
}

export interface SqlDocumentConflict {
  current: SqlDocument;
  localTitle: string;
  localSelectedDatabase: string;
  localSelectedSchema: string | null;
  localResolveMode: SqlResolveMode;
  localContent: string;
}

export function sqlDocumentConflict(
  current: SqlDocument,
  local: Omit<SaveSqlDocumentRequest, "id" | "connectionId" | "expectedRevision">,
): SqlDocumentConflict {
  return {
    current,
    localTitle: local.title,
    localSelectedDatabase: local.selectedDatabase,
    localSelectedSchema: local.selectedSchema,
    localResolveMode: local.resolveMode,
    localContent: local.content,
  };
}

export function retrySqlDocumentConflict(
  conflict: SqlDocumentConflict,
): Omit<SaveSqlDocumentRequest, "id" | "connectionId"> {
  return {
    expectedRevision: conflict.current.localRevision,
    title: conflict.localTitle,
    selectedDatabase: conflict.localSelectedDatabase,
    selectedSchema: conflict.localSelectedSchema,
    resolveMode: conflict.localResolveMode,
    content: conflict.localContent,
  };
}

export function sqlRecoveryKey(id: SqlDocumentId | string): string {
  return `dopedb.sqlRecovery.${id}`;
}
