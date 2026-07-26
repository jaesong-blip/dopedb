//! Tauri transport for desktop SQL query use cases.

use tauri::State;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;

use super::{
    DesktopSqlClassificationReceipt, DesktopSqlClassificationRequest, DesktopSqlInspectionError,
    DesktopSqlPreviewReceipt, DesktopSqlPreviewRequest, DesktopSqlProposalReceipt,
    DesktopSqlProposalRequest, DesktopSqlRunError, DesktopSqlRunReceipt,
};

/// Classifies SQL using the connection selected by a typed transport identity.
#[tauri::command]
pub(crate) async fn classify_sql(
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
) -> AppResult<DesktopSqlClassificationReceipt> {
    state
        .services
        .queries
        .classify_desktop_sql(DesktopSqlClassificationRequest {
            connection_id: id.into(),
            sql,
        })
        .await
        .map_err(DesktopSqlInspectionError::into_error)
}

/// Previews the impact of one SQL statement without granting write execution.
#[tauri::command]
pub(crate) async fn preview_sql(
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
) -> AppResult<DesktopSqlPreviewReceipt> {
    state
        .services
        .queries
        .preview_desktop_sql(DesktopSqlPreviewRequest {
            connection_id: id.into(),
            sql,
        })
        .await
        .map_err(DesktopSqlInspectionError::into_error)
}

/// Persists an immutable, single-use desktop SQL proposal.
#[tauri::command]
pub(crate) async fn propose_sql(
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
    origin: Option<String>,
) -> AppResult<DesktopSqlProposalReceipt> {
    state
        .services
        .queries
        .propose_desktop_sql(DesktopSqlProposalRequest {
            connection_id: id.into(),
            sql,
            origin,
        })
        .await
        .map_err(DesktopSqlInspectionError::into_error)
}

/// Executes a durable desktop SQL proposal by typed operation identity.
#[tauri::command]
pub(crate) async fn run_sql(
    state: State<'_, AppState>,
    operation_id: Uuid,
) -> AppResult<DesktopSqlRunReceipt> {
    state
        .services
        .queries
        .run_desktop_sql(operation_id.into())
        .await
        .map_err(DesktopSqlRunError::into_error)
}
