// Tauri adapter for the SQL document feature. This is the only frontend file that
// knows the four SQL document command names.

import { invoke } from "@tauri-apps/api/core";
import type {
  CreateSqlDocumentRequest,
  SaveSqlDocumentOutcome,
  SaveSqlDocumentRequest,
  SqlDocument,
  SqlDocumentRevision,
} from "./domain";
import type { SqlDocumentGateway } from "./ports";

export const tauriSqlDocumentGateway: SqlDocumentGateway = {
  list(connectionId) {
    return invoke<SqlDocument[]>("list_sql_documents", { id: connectionId });
  },

  listRevisions(connectionId, id) {
    return invoke<SqlDocumentRevision[]>("list_sql_document_revisions", {
      connectionId,
      id,
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
