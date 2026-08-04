//! Tauri transport for ACP sessions, CLI probes, and read-only retired archives.

use tauri::State;

use crate::error::AppResult;
use crate::kernel::identity::{AcpSessionId, ConnectionId, RetiredChatThreadId};
use crate::state::AppState;

use super::domain::{
    AcpPromptContext, AcpSessionFocus, AcpSessionSummary, AgentCliInfo, AgentProvider,
    RetiredChatArchiveMessage, RetiredChatArchiveThread,
};

/// Start one connection-pinned session through an official ACP registry adapter.
#[tauri::command]
pub async fn start_agent_acp_session(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: ConnectionId,
    provider: AgentProvider,
) -> AppResult<AcpSessionFocus> {
    state.agents_acp.start(connection_id, provider, app).await
}

/// Resume persisted history through the official adapter's ACP session/load path.
#[tauri::command]
pub async fn resume_agent_acp_session(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: AcpSessionId,
) -> AppResult<AcpSessionFocus> {
    state.agents_acp.resume(id, app).await
}

/// List workspace-scoped ACP conversations, including persisted closed history.
#[tauri::command]
pub async fn list_agent_acp_sessions(
    state: State<'_, AppState>,
) -> AppResult<Vec<AcpSessionSummary>> {
    state.agents_acp.list().await
}

/// Replay a bounded ACP event stream when switching conversations.
#[tauri::command]
pub async fn focus_agent_acp_session(
    state: State<'_, AppState>,
    id: AcpSessionId,
    after_sequence: Option<u64>,
) -> AppResult<AcpSessionFocus> {
    state.agents_acp.focus(id, after_sequence).await
}

/// Submit a prompt plus bounded editor context to the pinned ACP session.
#[tauri::command]
pub fn prompt_agent_acp_session(
    state: State<'_, AppState>,
    id: AcpSessionId,
    prompt: String,
    context: AcpPromptContext,
) -> AppResult<()> {
    state.agents_acp.prompt(id, prompt, context)
}

/// Cancel only the active ACP turn.
#[tauri::command]
pub async fn cancel_agent_acp_session(
    state: State<'_, AppState>,
    id: AcpSessionId,
) -> AppResult<()> {
    state.agents_acp.cancel(id).await
}

/// Resolve an actual ACP permission request with one offered option or cancel it.
#[tauri::command]
pub fn respond_agent_acp_permission(
    state: State<'_, AppState>,
    id: AcpSessionId,
    request_id: String,
    option_id: Option<String>,
) -> AppResult<()> {
    state
        .agents_acp
        .respond_permission(id, &request_id, option_id)
}

/// Close one ACP process and immediately revoke its connection capability.
#[tauri::command]
pub fn close_agent_acp_session(state: State<'_, AppState>, id: AcpSessionId) -> AppResult<()> {
    state.agents_acp.close(id)
}

/// Change one option that the active ACP adapter actually advertised.
#[tauri::command]
pub async fn set_agent_acp_config_option(
    state: State<'_, AppState>,
    id: AcpSessionId,
    config_id: String,
    value: String,
) -> AppResult<()> {
    state
        .agents_acp
        .set_config_option(id, config_id, value)
        .await
}

/// Claude Code / Codex CLI status for connection-pinned Terminal profiles.
#[tauri::command]
pub async fn detect_agent_clis(state: State<'_, AppState>) -> AppResult<Vec<AgentCliInfo>> {
    let agents = state.services.agents.clone();
    Ok(agents.detect_clis().await)
}

/// List the read-only archive left by the retired in-app Agent chat.
#[tauri::command]
pub async fn list_retired_chat_archive_threads(
    state: State<'_, AppState>,
) -> AppResult<Vec<RetiredChatArchiveThread>> {
    state.services.agents.list_retired_archive_threads().await
}

/// Read one archived thread's messages, oldest first, without any mutation path.
#[tauri::command]
pub async fn get_retired_chat_archive_messages(
    state: State<'_, AppState>,
    thread_id: RetiredChatThreadId,
) -> AppResult<Vec<RetiredChatArchiveMessage>> {
    state
        .services
        .agents
        .retired_archive_messages(thread_id)
        .await
}
