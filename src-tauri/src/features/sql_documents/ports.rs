//! Ports required by the SQL document use cases.
//!
//! The application layer depends on these capabilities instead of concrete connection,
//! clock, UUID, or SQLite implementations.

use std::future::Future;

use crate::error::AppResult;
use crate::kernel::identity::{AccountScopeId, ConnectionId, SqlDocumentId, WorkspaceConnectionId};

use super::domain::{SqlDialect, SqlDocument, SqlDocumentRevision};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SqlDocumentAuthority {
    pub(crate) resource: WorkspaceConnectionId,
    pub(crate) account_scope: AccountScopeId,
    pub(crate) dialect: SqlDialect,
}

pub(crate) trait SqlDocumentAuthorityGuard {
    fn authority(&self) -> &SqlDocumentAuthority;
}

pub(crate) trait SqlDocumentAuthorityPort: Clone + Send + Sync + 'static {
    type Guard: SqlDocumentAuthorityGuard + Send;

    fn authorize(
        &self,
        connection_id: ConnectionId,
    ) -> impl Future<Output = AppResult<Self::Guard>> + Send;
}

#[derive(Debug, Clone)]
pub(crate) struct SaveDocumentCommand {
    pub(crate) id: SqlDocumentId,
    pub(crate) title: String,
    pub(crate) content: String,
    pub(crate) expected_revision: i64,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SaveRepositoryOutcome {
    Saved(SqlDocument),
    Conflict(SqlDocument),
}

pub(crate) trait SqlDocumentRepositoryPort: Clone + Send + Sync + 'static {
    fn list(
        &self,
        authority: &SqlDocumentAuthority,
    ) -> impl Future<Output = AppResult<Vec<SqlDocument>>> + Send;

    fn list_revisions(
        &self,
        authority: &SqlDocumentAuthority,
        id: SqlDocumentId,
    ) -> impl Future<Output = AppResult<Vec<SqlDocumentRevision>>> + Send;

    fn create(
        &self,
        authority: &SqlDocumentAuthority,
        document: &SqlDocument,
    ) -> impl Future<Output = AppResult<()>> + Send;

    fn save(
        &self,
        authority: &SqlDocumentAuthority,
        command: SaveDocumentCommand,
    ) -> impl Future<Output = AppResult<SaveRepositoryOutcome>> + Send;

    fn delete(
        &self,
        authority: &SqlDocumentAuthority,
        id: SqlDocumentId,
        expected_revision: i64,
        deleted_at: String,
    ) -> impl Future<Output = AppResult<bool>> + Send;
}

pub(crate) trait SqlDocumentGeneratorPort: Clone + Send + Sync + 'static {
    fn next_id(&self) -> SqlDocumentId;
    fn now(&self) -> String;
}
