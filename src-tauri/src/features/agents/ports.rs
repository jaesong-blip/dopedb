//! Ports for credential-free local CLI discovery and retired archive reads.

use std::future::Future;

use crate::error::AppResult;
use crate::kernel::identity::RetiredChatThreadId;

use super::domain::{AgentCliInfo, RetiredChatArchiveMessage, RetiredChatArchiveThread};

pub(crate) trait AgentCliProbePort: Clone + Send + Sync + 'static {
    fn detect(&self) -> impl Future<Output = Vec<AgentCliInfo>> + Send;
}

pub(crate) trait RetiredChatArchivePort: Clone + Send + Sync + 'static {
    fn list_threads(&self)
        -> impl Future<Output = AppResult<Vec<RetiredChatArchiveThread>>> + Send;

    fn list_messages(
        &self,
        thread_id: RetiredChatThreadId,
    ) -> impl Future<Output = AppResult<Vec<RetiredChatArchiveMessage>>> + Send;
}
