//! Read-only Agent use cases composed from explicit platform ports.

use crate::error::AppResult;
use crate::kernel::identity::RetiredChatThreadId;

use super::domain::{
    AgentCliInfo, AgentUsage, RetiredChatArchiveMessage, RetiredChatArchiveThread,
};
use super::ports::{AgentCliProbePort, AgentUsagePort, RetiredChatArchivePort};

#[derive(Clone)]
pub(crate) struct AgentsUseCases<C, U, A> {
    cli_probe: C,
    usage: U,
    archive: A,
}

impl<C, U, A> AgentsUseCases<C, U, A>
where
    C: AgentCliProbePort,
    U: AgentUsagePort,
    A: RetiredChatArchivePort,
{
    pub(crate) fn new(cli_probe: C, usage: U, archive: A) -> Self {
        Self {
            cli_probe,
            usage,
            archive,
        }
    }

    /// Detect only the installed CLI's own status; provider credentials never cross this port.
    pub(crate) async fn detect_clis(&self) -> Vec<AgentCliInfo> {
        self.cli_probe.detect().await
    }

    /// Report remaining provider quota; credentials stay inside the adapter.
    pub(crate) async fn usage(&self) -> Vec<AgentUsage> {
        self.usage.fetch().await
    }

    /// List retired in-app chat threads without exposing any write operation.
    pub(crate) async fn list_retired_archive_threads(
        &self,
    ) -> AppResult<Vec<RetiredChatArchiveThread>> {
        self.archive.list_threads().await
    }

    /// Read one retired thread's immutable message history, oldest first.
    pub(crate) async fn retired_archive_messages(
        &self,
        thread_id: RetiredChatThreadId,
    ) -> AppResult<Vec<RetiredChatArchiveMessage>> {
        self.archive.list_messages(thread_id).await
    }
}
