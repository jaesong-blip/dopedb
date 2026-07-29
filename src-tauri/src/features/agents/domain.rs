//! Agent CLI status, remaining subscription quota, and read-only retired-chat contracts.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::kernel::identity::{ConnectionId, RetiredChatMessageId, RetiredChatThreadId};

/// Subscription-backed Terminal providers whose local CLIs can be probed safely.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AgentProvider {
    Claude,
    Codex,
}

/// Non-secret local CLI availability and authentication status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCliInfo {
    pub(crate) id: AgentProvider,
    pub(crate) name: String,
    pub(crate) installed: bool,
    pub(crate) authenticated: bool,
    pub(crate) auth_method: Option<String>,
    pub(crate) note: String,
}

/// How much of one provider's subscription quota is still available.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsage {
    pub(crate) provider: AgentProvider,
    /// Remaining share of the short rolling window, 0..=100.
    pub(crate) session_percent_left: u8,
    /// Remaining share of the weekly window when the provider reports one.
    pub(crate) weekly_percent_left: Option<u8>,
    /// Per-model weekly caps the provider scopes separately from the account window.
    pub(crate) model_windows: Vec<AgentModelUsage>,
    /// When the short window refills, if the provider reports it.
    pub(crate) resets_at: Option<DateTime<Utc>>,
}

/// One model-scoped weekly cap, named as the provider displays it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentModelUsage {
    pub(crate) model: String,
    pub(crate) percent_left: u8,
}

/// A thread persisted by the retired in-app Agent chat; it has no mutation path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetiredChatArchiveThread {
    pub(crate) id: RetiredChatThreadId,
    pub(crate) provider: AgentProvider,
    pub(crate) connection_id: Option<ConnectionId>,
    pub(crate) title: String,
    pub(crate) cli_session_id: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

/// One immutable message row in a retired chat archive thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetiredChatArchiveMessage {
    pub(crate) id: RetiredChatMessageId,
    pub(crate) thread_id: RetiredChatThreadId,
    pub(crate) role: String,
    pub(crate) text: String,
    pub(crate) error: Option<String>,
    pub(crate) created_at: DateTime<Utc>,
}
