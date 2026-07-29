// SQL document domain contract. Branded ids prevent a workspace, connection, and
// document string from being passed to the wrong feature command by accident.

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
  selectedSchema: string | null;
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

export interface CreateSqlDocumentRequest {
  connectionId: ConnectionId;
  title?: string | null;
  selectedSchema?: string | null;
  content?: string | null;
}

export interface SaveSqlDocumentRequest {
  id: SqlDocumentId;
  connectionId: ConnectionId;
  title: string;
  selectedSchema: string | null;
  content: string;
  expectedRevision: number;
}

export interface SaveSqlDocumentOutcome {
  saved: boolean;
  document: SqlDocument;
  expectedRevision: number;
  attemptedContentHash: string;
}

export function sqlRecoveryKey(id: SqlDocumentId | string): string {
  return `dopedb.sqlRecovery.${id}`;
}
