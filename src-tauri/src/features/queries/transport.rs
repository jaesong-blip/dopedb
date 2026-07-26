//! Tauri transport for desktop SQL query use cases.

use tauri::State;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;

use super::{
    DesktopPreviewIntent, DesktopSqlInspectionError, DesktopSqlInspectionReceipt,
    DesktopSqlInspectionRequest, DesktopSqlProposalReceipt, DesktopSqlProposalRequest,
    DesktopSqlRunError, DesktopSqlRunReceipt,
};

/// Atomically classifies and read-only explains a single SQL statement.
///
/// Tauri performs the sole raw UUID conversion. The feature owns the intent so
/// clients cannot turn a casual Explain into an impact preview by crafting wire
/// data.
#[tauri::command]
pub(crate) async fn inspect_sql(
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
) -> AppResult<DesktopSqlInspectionReceipt> {
    state
        .services
        .queries
        .inspect_desktop_sql(DesktopSqlInspectionRequest {
            connection_id: id.into(),
            sql,
            intent: DesktopPreviewIntent::ReadOnlyExplain,
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
