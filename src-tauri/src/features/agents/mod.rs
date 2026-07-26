//! Agent CLI readiness and read-only retired chat archive vertical slice.

pub(crate) mod adapters;
mod application;
#[cfg(test)]
mod application_tests;
pub(crate) mod domain;
mod ports;
pub(crate) mod transport;

use crate::store::Store;

use adapters::{ProcessAgentCliProbe, SqliteRetiredChatArchive};
pub(crate) use application::AgentsUseCases;
pub(crate) use domain::{AgentProvider, RetiredChatArchiveMessage, RetiredChatArchiveThread};

pub(crate) type AgentsFeature = AgentsUseCases<ProcessAgentCliProbe, SqliteRetiredChatArchive>;

pub(crate) fn compose(store: Store) -> AgentsFeature {
    AgentsUseCases::new(ProcessAgentCliProbe, SqliteRetiredChatArchive::new(store))
}
