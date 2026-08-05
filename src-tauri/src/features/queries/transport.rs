//! Tauri transport for desktop SQL query use cases.

use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;

use super::{
    DesktopPreviewIntent, DesktopSqlInspectionError, DesktopSqlInspectionReceipt,
    DesktopSqlInspectionRequest, DesktopSqlProposalReceipt, DesktopSqlProposalRequest,
    DesktopSqlResultExportFormat, DesktopSqlResultExportProgress, DesktopSqlResultExportReceipt,
    DesktopSqlRunError, DesktopSqlRunReceipt, DesktopSqlStreamBatch, DesktopSqlStreamReady,
    DesktopSqlStreamReceipt, DesktopSqlStreamSinkError,
};

#[tauri::command]
pub(crate) async fn list_query_service_sessions(
    state: State<'_, AppState>,
    expected_workspace_id: Uuid,
    expected_account_scope: String,
) -> AppResult<Vec<serde_json::Value>> {
    state
        .services
        .queries
        .list_query_service_sessions(expected_workspace_id, &expected_account_scope)
        .await
}

#[tauri::command]
pub(crate) async fn save_query_service_session(
    state: State<'_, AppState>,
    expected_workspace_id: Uuid,
    expected_account_scope: String,
    session: serde_json::Value,
) -> AppResult<()> {
    state
        .services
        .queries
        .save_query_service_session(expected_workspace_id, &expected_account_scope, session)
        .await
}

#[tauri::command]
pub(crate) async fn get_manual_transaction(
    state: State<'_, AppState>,
    id: Uuid,
) -> AppResult<Option<super::ManualTransactionStatus>> {
    Ok(state
        .services
        .queries
        .manual_transactions()
        .status(id)
        .await)
}

#[tauri::command]
pub(crate) async fn begin_manual_transaction(
    state: State<'_, AppState>,
    id: Uuid,
    database: Option<String>,
) -> AppResult<super::ManualTransactionStatus> {
    state
        .services
        .queries
        .manual_transactions()
        .begin(id, database)
        .await
}

#[tauri::command]
pub(crate) async fn commit_manual_transaction(
    state: State<'_, AppState>,
    id: Uuid,
    transaction_id: Uuid,
) -> AppResult<super::ManualTransactionStatus> {
    state
        .services
        .queries
        .manual_transactions()
        .commit(id, transaction_id)
        .await
}

#[tauri::command]
pub(crate) async fn rollback_manual_transaction(
    state: State<'_, AppState>,
    id: Uuid,
    transaction_id: Uuid,
) -> AppResult<super::ManualTransactionStatus> {
    state
        .services
        .queries
        .manual_transactions()
        .rollback(id, transaction_id)
        .await
}

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
    database: Option<String>,
    namespace: Option<String>,
) -> AppResult<DesktopSqlInspectionReceipt> {
    state
        .services
        .queries
        .inspect_desktop_sql(DesktopSqlInspectionRequest {
            connection_id: id.into(),
            sql,
            database,
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
    database: Option<String>,
    namespace: Option<String>,
    origin: Option<String>,
) -> AppResult<DesktopSqlProposalReceipt> {
    state
        .services
        .queries
        .propose_desktop_sql(DesktopSqlProposalRequest {
            connection_id: id.into(),
            sql,
            database,
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
// Keep the individual fields flat: they are the versioned Tauri wire contract
// consumed by the desktop adapter, not an internal application function.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn run_sql_read_stream(
    state: State<'_, AppState>,
    webview: tauri::WebviewWindow,
    id: Uuid,
    sql: String,
    database: Option<String>,
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
                database,
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

/// Reads one immutable completed-result page after revalidating workspace,
/// account, connection revision, renderer, and the bearer capability.
#[tauri::command]
pub(crate) async fn read_sql_result_page(
    state: State<'_, AppState>,
    webview: tauri::WebviewWindow,
    operation_id: Uuid,
    sequence: u64,
    capability: String,
) -> AppResult<DesktopSqlStreamBatch> {
    state
        .services
        .queries
        .read_desktop_sql_result_page(operation_id.into(), sequence, &capability, webview.label())
        .await
}

/// Picks a native destination and writes an immutable result without exposing
/// either row payloads or filesystem paths to the renderer.
#[tauri::command]
pub(crate) async fn export_sql_result(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    export_id: Uuid,
    operation_id: Uuid,
    capability: String,
    format: DesktopSqlResultExportFormat,
    suggested_name: String,
    on_progress: Channel<DesktopSqlResultExportProgress>,
) -> AppResult<Option<DesktopSqlResultExportReceipt>> {
    use tauri_plugin_dialog::DialogExt;

    let extension = match format {
        DesktopSqlResultExportFormat::Csv => "csv",
        DesktopSqlResultExportFormat::Json => "json",
    };
    let suggested_name = safe_result_export_name(&suggested_name, extension)?;
    let destination = app
        .dialog()
        .file()
        .set_file_name(suggested_name)
        .add_filter(extension.to_ascii_uppercase(), &[extension])
        .blocking_save_file()
        .and_then(|path| path.into_path().ok());
    let Some(destination) = destination else {
        return Ok(None);
    };
    state
        .services
        .queries
        .export_desktop_sql_result(
            export_id,
            operation_id.into(),
            capability,
            webview.label().to_string(),
            format,
            destination,
            move |progress| {
                on_progress.send(progress).map_err(|_| {
                    crate::error::AppError::Safety(
                        "SQL result export progress receiver disconnected".into(),
                    )
                })
            },
        )
        .await
        .map(Some)
}

fn safe_result_export_name(value: &str, extension: &str) -> AppResult<String> {
    let filename = std::path::Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| crate::error::AppError::Blocked {
            reason: "SQL result export name is invalid".into(),
        })?;
    if filename.is_empty()
        || filename.len() > 240
        || filename.chars().any(char::is_control)
        || filename == "."
        || filename == ".."
    {
        return Err(crate::error::AppError::Blocked {
            reason: "SQL result export name is invalid".into(),
        });
    }
    let suffix = format!(".{extension}");
    Ok(if filename.to_ascii_lowercase().ends_with(&suffix) {
        filename.to_string()
    } else {
        format!("{filename}{suffix}")
    })
}

#[tauri::command]
pub(crate) fn cancel_sql_result_export(
    state: State<'_, AppState>,
    webview: tauri::WebviewWindow,
    export_id: Uuid,
    operation_id: Uuid,
    capability: String,
) -> bool {
    state.services.queries.cancel_desktop_sql_result_export(
        export_id,
        operation_id.into(),
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
