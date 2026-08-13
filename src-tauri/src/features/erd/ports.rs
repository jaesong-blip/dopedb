//! Platform contracts required by ERD persistence use cases.

use std::future::Future;

use crate::error::AppResult;
use crate::kernel::identity::{AccountScopeId, ConnectionId, ErdLayoutId, WorkspaceConnectionId};

use super::domain::{ErdLayout, ErdLayoutPayload};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ErdAuthority {
    pub(crate) resource: WorkspaceConnectionId,
    pub(crate) account_scope: AccountScopeId,
}

pub(crate) trait ErdAuthorityGuard {
    fn authority(&self) -> &ErdAuthority;
}

pub(crate) trait ErdAuthorityPort: Clone + Send + Sync + 'static {
    type Guard: ErdAuthorityGuard + Send;

    fn authorize(
        &self,
        connection_id: ConnectionId,
    ) -> impl Future<Output = AppResult<Self::Guard>> + Send;
}

#[derive(Debug, Clone)]
pub(crate) enum SaveErdLayoutCommand {
    Create {
        id: ErdLayoutId,
        payload: ErdLayoutPayload,
        now: String,
    },
    Update {
        id: ErdLayoutId,
        payload: ErdLayoutPayload,
        expected_revision: i64,
        updated_at: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SaveErdRepositoryOutcome {
    Saved(ErdLayout),
    Conflict(ErdLayout),
}

pub(crate) trait ErdRepositoryPort: Clone + Send + Sync + 'static {
    fn list(
        &self,
        authority: &ErdAuthority,
    ) -> impl Future<Output = AppResult<Vec<ErdLayout>>> + Send;

    fn save(
        &self,
        authority: &ErdAuthority,
        command: SaveErdLayoutCommand,
    ) -> impl Future<Output = AppResult<SaveErdRepositoryOutcome>> + Send;
}

pub(crate) trait ErdGeneratorPort: Clone + Send + Sync + 'static {
    fn next_id(&self) -> ErdLayoutId;
    fn now(&self) -> String;
}
