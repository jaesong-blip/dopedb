//! Thin Tauri transport for the explicit advanced Shell surface.

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::kernel::identity::TerminalSessionId;
use crate::state::AppState;

use super::{TerminalCreateRequest, TerminalOutputChunk, TerminalSessionSummary, TerminalSize};

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
pub async fn terminal_close(
    id: TerminalSessionId,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<()> {
    state.terminals.close(id, app).await
}
