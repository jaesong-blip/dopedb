//! Scoped SQLite reads for conversations left by the retired in-app Agent chat.
//! This module intentionally exposes no mutation operation.

use sqlx::Row;

use crate::error::{AppError, AppResult};
use crate::features::agents::{AgentProvider, RetiredChatArchiveMessage, RetiredChatArchiveThread};
use crate::kernel::identity::{ConnectionId, RetiredChatMessageId, RetiredChatThreadId};

use super::{parse_uuid, parse_uuid_opt, Store};

impl Store {
    pub(crate) async fn list_retired_chat_archive_threads(
        &self,
    ) -> AppResult<Vec<RetiredChatArchiveThread>> {
        let scope = self.active_resource_scope().await?;
        let rows = sqlx::query(
            "SELECT * FROM agent_chat_threads
             WHERE workspace_id = ?1 AND account_scope = ?2
             ORDER BY updated_at DESC",
        )
        .bind(scope.workspace_id.to_string())
        .bind(scope.account_scope.storage_key())
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_thread).collect()
    }

    pub(crate) async fn list_retired_chat_archive_messages(
        &self,
        thread_id: RetiredChatThreadId,
    ) -> AppResult<Vec<RetiredChatArchiveMessage>> {
        let scope = self.active_resource_scope().await?;
        let rows = sqlx::query(
            "SELECT m.* FROM agent_chat_messages m
             JOIN agent_chat_threads t ON t.id = m.thread_id
             WHERE m.thread_id = ?1 AND t.workspace_id = ?2 AND t.account_scope = ?3
             ORDER BY m.created_at ASC",
        )
        .bind(thread_id.to_string())
        .bind(scope.workspace_id.to_string())
        .bind(scope.account_scope.storage_key())
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_message).collect()
    }
}

fn row_to_thread(row: &sqlx::sqlite::SqliteRow) -> AppResult<RetiredChatArchiveThread> {
    Ok(RetiredChatArchiveThread {
        id: RetiredChatThreadId::from(parse_uuid(row.try_get("id")?)?),
        provider: parse_agent_provider(row.try_get("provider")?)?,
        connection_id: parse_uuid_opt(row.try_get("connection_id")?)?.map(ConnectionId::from),
        title: row.try_get("title")?,
        cli_session_id: row.try_get("cli_session_id")?,
        model: row.try_get("model")?,
        effort: row.try_get("effort")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_message(row: &sqlx::sqlite::SqliteRow) -> AppResult<RetiredChatArchiveMessage> {
    Ok(RetiredChatArchiveMessage {
        id: RetiredChatMessageId::from(parse_uuid(row.try_get("id")?)?),
        thread_id: RetiredChatThreadId::from(parse_uuid(row.try_get("thread_id")?)?),
        role: row.try_get("role")?,
        text: row.try_get("text")?,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
    })
}

fn parse_agent_provider(value: String) -> AppResult<AgentProvider> {
    match value.as_str() {
        "claude" => Ok(AgentProvider::Claude),
        "codex" => Ok(AgentProvider::Codex),
        other => Err(AppError::Config(format!(
            "unknown agent provider '{other}'"
        ))),
    }
}
