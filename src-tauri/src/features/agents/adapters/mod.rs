//! Concrete desktop adapters for Agent CLI discovery and retired archive reads.

mod archive;
mod cli_probe;

pub(crate) use archive::SqliteRetiredChatArchive;
pub(crate) use cli_probe::ProcessAgentCliProbe;
