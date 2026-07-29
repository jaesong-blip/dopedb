//! Tauri transport for desktop SQL query use cases.

use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;

use super::{
    DesktopPreviewIntent, DesktopSqlInspectionError, DesktopSqlInspectionReceipt,
    DesktopSqlInspectionRequest, DesktopSqlProposalReceipt, DesktopSqlProposalRequest,
    DesktopSqlRunError, DesktopSqlRunReceipt, DesktopSqlStreamBatch, DesktopSqlStreamReady,
    DesktopSqlStreamReceipt, DesktopSqlStreamSinkError,
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
    namespace: Option<String>,
) -> AppResult<DesktopSqlInspectionReceipt> {
    state
        .services
        .queries
        .inspect_desktop_sql(DesktopSqlInspectionRequest {
            connection_id: id.into(),
            sql,
            namespace,
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
    namespace: Option<String>,
    origin: Option<String>,
) -> AppResult<DesktopSqlProposalReceipt> {
    state
        .services
        .queries
        .propose_desktop_sql(DesktopSqlProposalRequest {
            connection_id: id.into(),
            sql,
            namespace,
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

/// Runs an immutable read proposal and emits bounded result pages through Tauri.
#[tauri::command]
pub(crate) async fn run_sql_stream(
    state: State<'_, AppState>,
    webview: tauri::WebviewWindow,
    operation_id: Uuid,
    capability: String,
    on_rows: Channel<DesktopSqlStreamReady>,
) -> AppResult<DesktopSqlStreamReceipt> {
    state
        .services
        .queries
        .reserve_desktop_sql_stream(
            operation_id.into(),
            webview.label().to_string(),
            capability.clone(),
        )
        .map_err(|error| crate::error::AppError::Safety(error.to_string()))?;
    state
        .services
        .queries
        .run_desktop_sql_stream(
            operation_id.into(),
            webview.label().to_string(),
            capability,
            move |batch| {
                on_rows
                    .send(batch)
                    .map_err(|_| DesktopSqlStreamSinkError::ReceiverDropped)
            },
        )
        .await
        .map_err(DesktopSqlRunError::into_error)
}

/// Atomically plans and streams an auto-run desktop read in one IPC request.
#[tauri::command]
pub(crate) async fn run_sql_read_stream(
    state: State<'_, AppState>,
    webview: tauri::WebviewWindow,
    id: Uuid,
    sql: String,
    namespace: Option<String>,
    origin: Option<String>,
    capability: String,
    on_rows: Channel<DesktopSqlStreamReady>,
) -> AppResult<DesktopSqlStreamReceipt> {
    state
        .services
        .queries
        .reserve_pending_desktop_sql_stream(webview.label().to_string(), capability.clone())
        .map_err(|error| crate::error::AppError::Safety(error.to_string()))?;
    let result = state
        .services
        .queries
        .run_desktop_sql_read_stream(
            DesktopSqlProposalRequest {
                connection_id: id.into(),
                sql,
                namespace,
                origin,
            },
            webview.label().to_string(),
            capability.clone(),
            move |batch| {
                on_rows
                    .send(batch)
                    .map_err(|_| DesktopSqlStreamSinkError::ReceiverDropped)
            },
        )
        .await;
    if result.is_err() {
        state
            .services
            .queries
            .forget_pending_desktop_sql_stream(&capability, webview.label());
    }
    result
}

/// Releases the exact next desktop result-stream credit after the frontend has
/// accepted its batch. Invalid, stale, foreign, or replayed ACKs return false
/// and never advance the database cursor.
#[tauri::command]
pub(crate) fn ack_sql_stream(
    state: State<'_, AppState>,
    webview: tauri::WebviewWindow,
    operation_id: Uuid,
    sequence: u64,
    capability: String,
) -> bool {
    state.services.queries.acknowledge_desktop_sql_stream(
        operation_id.into(),
        sequence,
        &capability,
        webview.label(),
    )
}

/// Pulls the one retained result page after the small Channel notification.
#[tauri::command]
pub(crate) fn pull_sql_stream_batch(
    state: State<'_, AppState>,
    webview: tauri::WebviewWindow,
    operation_id: Uuid,
    sequence: u64,
    capability: String,
) -> Option<DesktopSqlStreamBatch> {
    state.services.queries.pull_desktop_sql_stream(
        operation_id.into(),
        sequence,
        &capability,
        webview.label(),
    )
}

/// Stops a desktop result stream whose receiver or reducer can no longer
/// consume batches. The running operation records its ordinary cancellation.
#[tauri::command]
pub(crate) fn cancel_sql_stream(
    state: State<'_, AppState>,
    webview: tauri::WebviewWindow,
    operation_id: Option<Uuid>,
    capability: String,
) -> bool {
    match operation_id {
        Some(operation_id) => state.services.queries.cancel_desktop_sql_stream(
            operation_id.into(),
            &capability,
            webview.label(),
        ),
        None => state
            .services
            .queries
            .cancel_pending_desktop_sql_stream(&capability, webview.label()),
    }
}
