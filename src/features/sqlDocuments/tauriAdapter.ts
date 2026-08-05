// Tauri adapter for the SQL document feature. This is the only frontend file that
// knows the four SQL document command names.

import { invoke } from "@tauri-apps/api/core";
import type {
  CreateSqlDocumentRequest,
  SaveSqlDocumentOutcome,
  SaveSqlDocumentRequest,
  SqlDocument,
  SqlDocumentRevision,
  SqlDocumentRevisionPage,
  SqlDocumentRevisionPageRequest,
} from "./domain";
import type { SqlDocumentGateway } from "./ports";

export const tauriSqlDocumentGateway: SqlDocumentGateway = {
  list(connectionId) {
    return invoke<SqlDocument[]>("list_sql_documents", { id: connectionId });
  },

  listRevisionPage(request: SqlDocumentRevisionPageRequest) {
    return invoke<SqlDocumentRevisionPage>("list_sql_document_revision_page", {
      request,
    });
  },

  getRevision(connectionId, id, localRevision) {
    return invoke<SqlDocumentRevision>("get_sql_document_revision", {
      connectionId,
      id,
      localRevision,
    });
  },

  create(request: CreateSqlDocumentRequest) {
    return invoke<SqlDocument>("create_sql_document", { request });
  },

  save(request: SaveSqlDocumentRequest) {
    return invoke<SaveSqlDocumentOutcome>("save_sql_document", { request });
  },

  delete(connectionId, id, expectedRevision) {
    return invoke<void>("delete_sql_document", {
      connectionId,
      id,
      expectedRevision,
    });
  },
};
