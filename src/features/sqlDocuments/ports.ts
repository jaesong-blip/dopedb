// Application-facing SQL document port. UI state depends on this contract rather
// than importing Tauri invoke calls directly.

import type {
  ConnectionId,
  CreateSqlDocumentRequest,
  SaveSqlDocumentOutcome,
  SaveSqlDocumentRequest,
  SqlDocument,
  SqlDocumentId,
  SqlDocumentRevision,
  SqlDocumentRevisionPage,
  SqlDocumentRevisionPageRequest,
} from "./domain";

export interface SqlDocumentGateway {
  list(connectionId: ConnectionId): Promise<SqlDocument[]>;
  listRevisionPage(
    request: SqlDocumentRevisionPageRequest,
  ): Promise<SqlDocumentRevisionPage>;
  getRevision(
    connectionId: ConnectionId,
    id: SqlDocumentId,
    localRevision: number,
  ): Promise<SqlDocumentRevision>;
  create(request: CreateSqlDocumentRequest): Promise<SqlDocument>;
  save(request: SaveSqlDocumentRequest): Promise<SaveSqlDocumentOutcome>;
  delete(
    connectionId: ConnectionId,
    id: SqlDocumentId,
    expectedRevision: number,
  ): Promise<void>;
}
