mod hosted;
pub(super) mod local;
mod sqlite;
mod sqlite_store;

pub(crate) use hosted::HostedKnowledgeAuthority;
pub(crate) use sqlite::SqliteKnowledgeRepository;
