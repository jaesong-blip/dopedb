//! Agent CLI readiness, subscription quota, and read-only retired chat archive slice.

pub(crate) mod adapters;
mod application;
pub(crate) mod domain;
mod ports;
pub(crate) mod transport;

use crate::store::Store;

use adapters::{HttpAgentUsage, ProcessAgentCliProbe, SqliteRetiredChatArchive};
pub(crate) use application::AgentsUseCases;
pub(crate) use domain::{AgentProvider, RetiredChatArchiveMessage, RetiredChatArchiveThread};

pub(crate) type AgentsFeature =
    AgentsUseCases<ProcessAgentCliProbe, HttpAgentUsage, SqliteRetiredChatArchive>;

pub(crate) fn compose(store: Store) -> AgentsFeature {
    AgentsUseCases::new(
        ProcessAgentCliProbe,
        HttpAgentUsage::new(),
        SqliteRetiredChatArchive::new(store),
    )
}
