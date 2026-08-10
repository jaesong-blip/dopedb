//! ACP runtime, local CLI readiness, and read-only retired chat archive slice.

pub(crate) mod acp;
pub(crate) mod adapters;
mod application;
pub(crate) mod domain;
mod ports;
pub(crate) mod runtime;
pub(crate) mod transport;

use crate::store::Store;

use adapters::{ProcessAgentCliProbe, SqliteRetiredChatArchive};
pub(crate) use application::AgentsUseCases;
pub(crate) use domain::{AgentProvider, RetiredChatArchiveMessage, RetiredChatArchiveThread};

pub(crate) type AgentsFeature = AgentsUseCases<ProcessAgentCliProbe, SqliteRetiredChatArchive>;

pub(crate) fn compose(store: Store) -> AgentsFeature {
    AgentsUseCases::new(ProcessAgentCliProbe, SqliteRetiredChatArchive::new(store))
}

#[cfg(test)]
pub(crate) fn assert_agent_cli_probe_contract() {
    adapters::assert_agent_cli_probe_contract();
}
