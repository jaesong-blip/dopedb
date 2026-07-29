//! Tauri transport for CLI probes, provider quota, and read-only retired archives.

use tauri::State;

use crate::error::AppResult;
use crate::kernel::identity::RetiredChatThreadId;
use crate::state::AppState;

use super::domain::{
    AgentCliInfo, AgentUsage, RetiredChatArchiveMessage, RetiredChatArchiveThread,
};

/// Claude Code / Codex CLI status for connection-pinned Terminal profiles.
#[tauri::command]
pub async fn detect_agent_clis(state: State<'_, AppState>) -> AppResult<Vec<AgentCliInfo>> {
    let agents = state.services.agents.clone();
    Ok(agents.detect_clis().await)
}

/// Remaining subscription quota for the signed-in Agent CLIs, for the status bar.
#[tauri::command]
pub async fn agent_usage(state: State<'_, AppState>) -> AppResult<Vec<AgentUsage>> {
    let agents = state.services.agents.clone();
    Ok(agents.usage().await)
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
