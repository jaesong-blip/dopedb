//! Ports for local CLI discovery, provider quota reads, and retired archive reads.

use std::future::Future;

use crate::error::AppResult;
use crate::kernel::identity::RetiredChatThreadId;

use super::domain::{
    AgentCliInfo, AgentUsage, RetiredChatArchiveMessage, RetiredChatArchiveThread,
};

pub(crate) trait AgentCliProbePort: Clone + Send + Sync + 'static {
    fn detect(&self) -> impl Future<Output = Vec<AgentCliInfo>> + Send;
}

pub(crate) trait AgentUsagePort: Clone + Send + Sync + 'static {
    /// Only providers whose quota could be read are returned; failures are omitted.
    fn fetch(&self) -> impl Future<Output = Vec<AgentUsage>> + Send;
}

pub(crate) trait RetiredChatArchivePort: Clone + Send + Sync + 'static {
    fn list_threads(&self)
        -> impl Future<Output = AppResult<Vec<RetiredChatArchiveThread>>> + Send;

    fn list_messages(
        &self,
        thread_id: RetiredChatThreadId,
    ) -> impl Future<Output = AppResult<Vec<RetiredChatArchiveMessage>>> + Send;
}
