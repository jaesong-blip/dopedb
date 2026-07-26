//! Characterization tests for Agent CLI ordering and immutable retired archive reads.

use chrono::Utc;
use uuid::Uuid;

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, RetiredChatMessageId, RetiredChatThreadId};

use super::application::AgentsUseCases;
use super::domain::{
    AgentCliInfo, AgentProvider, RetiredChatArchiveMessage, RetiredChatArchiveThread,
};
use super::ports::{AgentCliProbePort, RetiredChatArchivePort};

#[derive(Clone)]
struct StaticCliProbe(Vec<AgentCliInfo>);

impl AgentCliProbePort for StaticCliProbe {
    async fn detect(&self) -> Vec<AgentCliInfo> {
        self.0.clone()
    }
}

#[derive(Clone)]
struct StaticArchive {
    threads: Vec<RetiredChatArchiveThread>,
    messages: Vec<RetiredChatArchiveMessage>,
}

impl RetiredChatArchivePort for StaticArchive {
    async fn list_threads(&self) -> AppResult<Vec<RetiredChatArchiveThread>> {
        Ok(self.threads.clone())
    }

    async fn list_messages(
        &self,
        _thread_id: RetiredChatThreadId,
    ) -> AppResult<Vec<RetiredChatArchiveMessage>> {
        Ok(self.messages.clone())
    }
}

fn cli(id: AgentProvider) -> AgentCliInfo {
    AgentCliInfo {
        id,
        name: format!("{id:?}"),
        installed: true,
        authenticated: true,
        auth_method: None,
        note: "local status only".into(),
    }
}

#[tokio::test]
async fn preserves_cli_probe_order_for_terminal_profile_readiness() {
    let agents = AgentsUseCases::new(
        StaticCliProbe(vec![cli(AgentProvider::Claude), cli(AgentProvider::Codex)]),
        StaticArchive {
            threads: vec![],
            messages: vec![],
        },
    );

    let ids = agents
        .detect_clis()
        .await
        .into_iter()
        .map(|status| status.id)
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![AgentProvider::Claude, AgentProvider::Codex]);
}

#[tokio::test]
async fn exposes_retired_chat_as_read_only_thread_and_message_projections() {
    let thread_id = RetiredChatThreadId::from(Uuid::new_v4());
    let now = Utc::now();
    let thread = RetiredChatArchiveThread {
        id: thread_id,
        provider: AgentProvider::Codex,
        connection_id: Some(ConnectionId::from(Uuid::new_v4())),
        title: "Archived conversation".into(),
        cli_session_id: Some("legacy-session".into()),
        model: Some("legacy-model".into()),
        effort: Some("high".into()),
        created_at: now,
        updated_at: now,
    };
    let message = RetiredChatArchiveMessage {
        id: RetiredChatMessageId::from(Uuid::new_v4()),
        thread_id,
        role: "assistant".into(),
        text: "Preserved response".into(),
        error: None,
        created_at: now,
    };
    let agents = AgentsUseCases::new(
        StaticCliProbe(vec![]),
        StaticArchive {
            threads: vec![thread],
            messages: vec![message],
        },
    );

    let threads = agents.list_retired_archive_threads().await.unwrap();
    let messages = agents.retired_archive_messages(thread_id).await.unwrap();

    assert_eq!(threads[0].id, thread_id);
    assert_eq!(threads[0].title, "Archived conversation");
    assert_eq!(messages[0].thread_id, thread_id);
    assert_eq!(messages[0].text, "Preserved response");
}
