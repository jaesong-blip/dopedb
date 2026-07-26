//! Serializable Terminal Dock contracts and immutable session metadata.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::kernel::identity::{ConnectionId, TerminalSessionId, WorkspaceId};
use crate::model::Engine;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalProfile {
    Shell,
    Codex,
    Claude,
}

impl TerminalProfile {
    pub(super) const fn default_name(self) -> &'static str {
        match self {
            Self::Shell => "Shell",
            Self::Codex => "Codex",
            Self::Claude => "Claude",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalLifecycle {
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
}

impl TerminalLifecycle {
    pub(super) const fn is_terminal(self) -> bool {
        matches!(self, Self::Exited | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalDatabasePolicy {
    ReadOnly,
    ApprovalRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub pixel_width: u16,
    #[serde(default)]
    pub pixel_height: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            cols: 100,
            rows: 30,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

impl TerminalSize {
    pub(super) fn validate(self) -> Result<Self, &'static str> {
        if !(10..=1_000).contains(&self.cols)
            || !(2..=500).contains(&self.rows)
            || self.pixel_width > 32_000
            || self.pixel_height > 32_000
        {
            return Err("terminal dimensions are outside the supported bounds");
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalCreateRequest {
    pub connection_id: ConnectionId,
    pub profile: TerminalProfile,
    #[serde(default)]
    pub size: TerminalSize,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConnectionPin {
    pub workspace_id: WorkspaceId,
    pub account_scope: String,
    pub scope_generation: i64,
    pub connection_id: ConnectionId,
    pub connection_revision: i64,
    pub connection_name: String,
    pub database: String,
    pub environment: Option<String>,
    pub engine: Engine,
    pub policy: TerminalDatabasePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub success: bool,
    pub code: Option<u32>,
    pub signal: Option<String>,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSummary {
    pub id: TerminalSessionId,
    pub name: String,
    pub profile: TerminalProfile,
    pub lifecycle: TerminalLifecycle,
    pub size: TerminalSize,
    pub connection: TerminalConnectionPin,
    pub created_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    pub exit: Option<TerminalExit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    pub session_id: TerminalSessionId,
    pub sequence: u64,
    pub bytes: Vec<u8>,
    pub replay: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFocusReceipt {
    pub session: TerminalSessionSummary,
    pub replay_from: Option<u64>,
    pub replay_through: u64,
    pub replay_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStateEvent {
    pub session: TerminalSessionSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: TerminalSessionId,
    pub exit: TerminalExit,
}
