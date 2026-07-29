//! Concrete desktop adapters for CLI discovery, quota reads, and retired archives.

mod archive;
mod cli_probe;
mod usage;

pub(crate) use archive::SqliteRetiredChatArchive;
pub(crate) use cli_probe::ProcessAgentCliProbe;
pub(crate) use usage::HttpAgentUsage;
