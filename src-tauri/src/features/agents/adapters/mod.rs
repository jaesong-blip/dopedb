//! Concrete desktop adapters for CLI discovery and retired archives.

mod archive;
mod cli_probe;

pub(crate) use archive::SqliteRetiredChatArchive;
pub(crate) use cli_probe::ProcessAgentCliProbe;
