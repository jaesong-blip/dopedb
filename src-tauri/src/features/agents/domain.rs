//! ACP conversation, local CLI status, and read-only retired-chat contracts.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::kernel::identity::{
    AcpSessionId, ConnectionId, RetiredChatMessageId, RetiredChatThreadId,
};

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
    pub(crate) detection_error: Option<String>,
    pub(crate) note: String,
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

/// Lifecycle of one ACP conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AcpSessionLifecycle {
    Starting,
    Ready,
    Running,
    WaitingPermission,
    Failed,
    Closed,
}

/// Stable projection used by the Agent panel and its session switcher.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpSessionSummary {
    pub(crate) id: AcpSessionId,
    pub(crate) connection_id: ConnectionId,
    pub(crate) provider: AgentProvider,
    pub(crate) title: String,
    pub(crate) lifecycle: AcpSessionLifecycle,
    pub(crate) acp_session_id: Option<String>,
    #[serde(default)]
    pub(crate) knowledge_grant_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub(crate) project_environment_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub(crate) environment_revision: Option<u64>,
    #[serde(default)]
    pub(crate) knowledge_sources: Vec<crate::features::knowledge::domain::KnowledgeSessionSource>,
    #[serde(default)]
    pub(crate) graph_revision_ids: Vec<uuid::Uuid>,
    #[serde(default)]
    pub(crate) environment_connections:
        Vec<crate::features::knowledge::domain::KnowledgeSessionConnection>,
    pub(crate) error: Option<String>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

/// One option supplied by the ACP agent for an actual permission request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpPermissionOption {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
}

/// A bounded, replayable event from one ACP conversation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpSessionEvent {
    pub(crate) session_id: AcpSessionId,
    pub(crate) sequence: u64,
    pub(crate) created_at: DateTime<Utc>,
    #[serde(flatten)]
    pub(crate) payload: AcpSessionEventPayload,
}

/// Event payloads deliberately preserve ACP updates instead of translating them
/// into a provider-specific chat transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum AcpSessionEventPayload {
    UserMessage {
        text: String,
        attachments: Vec<String>,
    },
    SessionUpdate {
        update: serde_json::Value,
    },
    SessionConfiguration {
        #[serde(rename = "configOptions", alias = "config_options")]
        config_options: Vec<serde_json::Value>,
    },
    PermissionRequest {
        #[serde(rename = "requestId", alias = "request_id")]
        request_id: String,
        #[serde(rename = "toolCall", alias = "tool_call")]
        tool_call: serde_json::Value,
        options: Vec<AcpPermissionOption>,
    },
    PermissionResponse {
        #[serde(rename = "requestId", alias = "request_id")]
        request_id: String,
        #[serde(rename = "optionId", alias = "option_id")]
        option_id: Option<String>,
    },
    TurnEnd {
        #[serde(rename = "stopReason", alias = "stop_reason")]
        stop_reason: String,
    },
    Status {
        lifecycle: AcpSessionLifecycle,
    },
    Error {
        message: String,
    },
}

/// Initial focus response and later replay when switching ACP sessions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpSessionFocus {
    pub(crate) session: AcpSessionSummary,
    pub(crate) events: Vec<AcpSessionEvent>,
    pub(crate) replay_truncated: bool,
}

/// Event emitted whenever an ACP session summary or stream changes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpSessionChanged {
    pub(crate) session: AcpSessionSummary,
    pub(crate) event: Option<AcpSessionEvent>,
}

/// The currently selected database resource. Row values are untrusted context,
/// bounded again by the Rust runtime before becoming ACP content blocks.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpTableContext {
    pub(crate) database: Option<String>,
    pub(crate) schema: Option<String>,
    pub(crate) table: String,
    pub(crate) column: Option<String>,
    pub(crate) row_index: Option<u64>,
    pub(crate) row: Option<serde_json::Value>,
}

/// Optional editor context supplied by the frontend. The connection identity is
/// never accepted here; it comes from the backend-pinned ACP session.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpPromptContext {
    pub(crate) database: Option<String>,
    pub(crate) document_name: Option<String>,
    pub(crate) document_text: Option<String>,
    pub(crate) table: Option<AcpTableContext>,
}

#[cfg(test)]
pub(crate) fn assert_agent_event_wire_contract() {
    let configuration = serde_json::to_value(AcpSessionEventPayload::SessionConfiguration {
        config_options: vec![],
    })
    .expect("serialize ACP session configuration");
    assert_eq!(configuration["configOptions"], serde_json::json!([]));
    assert!(configuration.get("config_options").is_none());

    let request = serde_json::to_value(AcpSessionEventPayload::PermissionRequest {
        request_id: "permission-1".into(),
        tool_call: serde_json::json!({ "title": "query" }),
        options: vec![],
    })
    .expect("serialize ACP permission request");
    assert_eq!(request["requestId"], "permission-1");
    assert_eq!(request["toolCall"]["title"], "query");
    assert!(request.get("request_id").is_none());
    assert!(request.get("tool_call").is_none());

    let response = serde_json::to_value(AcpSessionEventPayload::PermissionResponse {
        request_id: "permission-1".into(),
        option_id: Some("allow".into()),
    })
    .expect("serialize ACP permission response");
    assert_eq!(response["requestId"], "permission-1");
    assert_eq!(response["optionId"], "allow");

    let turn_end = serde_json::to_value(AcpSessionEventPayload::TurnEnd {
        stop_reason: "cancelled".into(),
    })
    .expect("serialize ACP turn end");
    assert_eq!(turn_end["stopReason"], "cancelled");
    assert!(turn_end.get("stop_reason").is_none());

    let legacy_turn_end: AcpSessionEventPayload = serde_json::from_value(serde_json::json!({
        "type": "turnEnd",
        "stop_reason": "end_turn"
    }))
    .expect("read a pre-camelCase ACP event");
    assert!(matches!(
        legacy_turn_end,
        AcpSessionEventPayload::TurnEnd { stop_reason } if stop_reason == "end_turn"
    ));
}
