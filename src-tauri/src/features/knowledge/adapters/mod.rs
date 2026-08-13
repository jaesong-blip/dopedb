mod hosted;
pub(crate) mod local;
mod sqlite;

pub(crate) use hosted::HostedKnowledgeAuthority;
pub(crate) use sqlite::SqliteKnowledgeRepository;
