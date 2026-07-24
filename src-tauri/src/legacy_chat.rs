//! Read-only wire models for conversations created by the retired in-app Agent chat.
//! The underlying tables remain so upgrades never destroy a user's history.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agent_cli::AgentProvider;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: Uuid,
    pub provider: AgentProvider,
    pub connection_id: Option<Uuid>,
    pub title: String,
    pub cli_session_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRecord {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub role: String,
    pub text: String,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}
