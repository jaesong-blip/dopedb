//! Thin Tauri transport for Terminal Dock use cases.

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::kernel::identity::TerminalSessionId;
use crate::state::AppState;

use super::{
    TerminalCreateRequest, TerminalFocusReceipt, TerminalOutputChunk, TerminalSessionSummary,
    TerminalSize,
};

#[tauri::command]
pub async fn terminal_create(
    request: TerminalCreateRequest,
    on_output: Channel<TerminalOutputChunk>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<TerminalSessionSummary> {
    state.terminals.create(request, on_output, app).await
}

#[tauri::command]
pub fn terminal_list(state: State<'_, AppState>) -> AppResult<Vec<TerminalSessionSummary>> {
    state.terminals.list()
}

#[tauri::command]
pub async fn terminal_focus(
    id: TerminalSessionId,
    after_sequence: Option<u64>,
    on_output: Channel<TerminalOutputChunk>,
    state: State<'_, AppState>,
) -> AppResult<TerminalFocusReceipt> {
    state.terminals.focus(id, after_sequence, on_output).await
}

#[tauri::command]
pub async fn terminal_write(
    id: TerminalSessionId,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.terminals.write(id, bytes).await
}

#[tauri::command]
pub async fn terminal_resize(
    id: TerminalSessionId,
    size: TerminalSize,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.terminals.resize(id, size).await
}

#[tauri::command]
pub async fn terminal_kill(
    id: TerminalSessionId,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<TerminalSessionSummary> {
    state.terminals.kill(id, app).await
}

#[tauri::command]
pub async fn terminal_close(
    id: TerminalSessionId,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<()> {
    state.terminals.close(id, app).await
}

#[tauri::command]
pub async fn terminal_restart(
    id: TerminalSessionId,
    on_output: Channel<TerminalOutputChunk>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<TerminalSessionSummary> {
    state.terminals.restart(id, on_output, app).await
}

#[tauri::command]
pub async fn terminal_rename(
    id: TerminalSessionId,
    name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<TerminalSessionSummary> {
    state.terminals.rename(id, name, app).await
}

#[tauri::command]
pub async fn terminal_shutdown_all(state: State<'_, AppState>, app: AppHandle) -> AppResult<()> {
    let terminals = state.terminals.clone();
    tokio::task::spawn_blocking(move || {
        terminals.shutdown_all(&app, std::time::Duration::from_secs(2));
    })
    .await
    .map_err(|_| {
        crate::error::AppError::Config("the Terminal shutdown worker stopped unexpectedly".into())
    })?;
    Ok(())
}
