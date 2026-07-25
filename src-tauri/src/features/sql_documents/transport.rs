//! Tauri transport adapter for SQL document use cases.

use tauri::State;

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, SqlDocumentId};
use crate::state::AppState;

use super::{
    CreateSqlDocumentRequest, SaveSqlDocumentOutcome, SaveSqlDocumentRequest, SqlDocument,
};

#[tauri::command]
pub async fn list_sql_documents(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<Vec<SqlDocument>> {
    state.services.sql_documents.list(id).await
}

#[tauri::command]
pub async fn create_sql_document(
    state: State<'_, AppState>,
    request: CreateSqlDocumentRequest,
) -> AppResult<SqlDocument> {
    state.services.sql_documents.create(request).await
}

#[tauri::command]
pub async fn save_sql_document(
    state: State<'_, AppState>,
    request: SaveSqlDocumentRequest,
) -> AppResult<SaveSqlDocumentOutcome> {
    state.services.sql_documents.save(request).await
}

#[tauri::command]
pub async fn delete_sql_document(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    id: SqlDocumentId,
    expected_revision: i64,
) -> AppResult<()> {
    state
        .services
        .sql_documents
        .delete(connection_id, id, expected_revision)
        .await
}
