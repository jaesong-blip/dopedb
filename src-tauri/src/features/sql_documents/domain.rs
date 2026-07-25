//! SQL document domain values and invariants.
//!
//! This module has no knowledge of Tauri, SQLx, the local store, or connection
//! authorization. It defines only the data and rules that every adapter must preserve.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, SqlDocumentId};

const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SqlDialect {
    PostgreSql,
    MySql,
    Sqlite,
    MongoDb,
}

impl SqlDialect {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::PostgreSql => "postgresql",
            Self::MySql => "mysql",
            Self::Sqlite => "sqlite",
            Self::MongoDb => "mongodb",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SqlDocumentSyncStatus {
    Local,
    Dirty,
    Synced,
    Conflict,
}

impl SqlDocumentSyncStatus {
    pub(crate) fn parse(value: &str) -> AppResult<Self> {
        match value {
            "local" => Ok(Self::Local),
            "dirty" => Ok(Self::Dirty),
            "synced" => Ok(Self::Synced),
            "conflict" => Ok(Self::Conflict),
            _ => Err(AppError::Config(
                "stored SQL document sync status is invalid".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SqlDocument {
    pub(crate) id: SqlDocumentId,
    pub(crate) connection_id: ConnectionId,
    pub(crate) title: String,
    pub(crate) dialect: String,
    pub(crate) content: String,
    pub(crate) local_revision: i64,
    pub(crate) remote_id: Option<String>,
    pub(crate) remote_revision: Option<i64>,
    pub(crate) dirty: bool,
    pub(crate) sync_status: SqlDocumentSyncStatus,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

impl SqlDocument {
    pub(crate) fn create(
        id: SqlDocumentId,
        connection_id: ConnectionId,
        dialect: SqlDialect,
        title: String,
        content: String,
        now: String,
    ) -> Self {
        Self {
            id,
            connection_id,
            title,
            dialect: dialect.as_str().into(),
            content,
            local_revision: 1,
            remote_id: None,
            remote_revision: None,
            dirty: true,
            sync_status: SqlDocumentSyncStatus::Local,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

pub(crate) fn normalize_title(title: &str) -> AppResult<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Config(
            "SQL document title must not be empty".into(),
        ));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::Config(format!(
            "SQL document title exceeds {MAX_TITLE_CHARS} characters"
        )));
    }
    Ok(title.to_owned())
}

pub(crate) fn validate_content(content: &str) -> AppResult<()> {
    if content.len() > MAX_DOCUMENT_BYTES {
        return Err(AppError::Config(format!(
            "SQL document exceeds the {} MiB local limit",
            MAX_DOCUMENT_BYTES / 1024 / 1024
        )));
    }
    Ok(())
}

pub(crate) fn content_hash(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_is_stable_and_content_sensitive() {
        assert_eq!(content_hash("SELECT 1"), content_hash("SELECT 1"));
        assert_ne!(content_hash("SELECT 1"), content_hash("SELECT 2"));
        assert_eq!(content_hash("SELECT 1").len(), 64);
    }

    #[test]
    fn title_and_document_bounds_are_enforced() {
        assert!(normalize_title(" query ").is_ok());
        assert!(normalize_title(" ").is_err());
        assert!(normalize_title(&"x".repeat(MAX_TITLE_CHARS + 1)).is_err());
        assert!(validate_content(&"x".repeat(MAX_DOCUMENT_BYTES + 1)).is_err());
    }

    #[test]
    fn sync_status_rejects_unknown_persisted_values() {
        assert_eq!(
            SqlDocumentSyncStatus::parse("dirty").unwrap(),
            SqlDocumentSyncStatus::Dirty
        );
        assert!(SqlDocumentSyncStatus::parse("maybe").is_err());
    }
}
