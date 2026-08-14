//! Exact local access authority shared across feature boundaries.
//!
//! These values describe which workspace/account selection and connection
//! revision a task was authorized against. They contain no persistence or
//! runtime handles, so application ports can name them without depending on
//! the SQLite `Store` that happens to materialize them.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::ConnectionProfile;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceKind {
    Personal,
    Team,
}

/// Stable, non-secret identity for local execution artifacts. Team resources
/// are partitioned by the exact Better Auth account; Personal resources remain
/// account-free even while an account is selected in the switcher.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum AccountScope {
    Personal,
    WorkspaceUser(String),
}

impl AccountScope {
    pub(crate) fn storage_key(&self) -> &str {
        match self {
            Self::Personal => "personal",
            Self::WorkspaceUser(user_id) => user_id,
        }
    }
}

/// One atomically observed workspace/account selection. `generation` changes
/// for every committed selection, including A → B → A, so a late task
/// cannot mistake a newly re-selected scope for its original authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActiveResourceScope {
    pub(crate) workspace_id: Uuid,
    pub(crate) workspace_kind: WorkspaceKind,
    pub(crate) selected_account_id: Option<String>,
    pub(crate) account_scope: AccountScope,
    pub(crate) generation: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CatalogCachePolicy {
    Persistent,
    EphemeralOnly,
}

/// A connection resolved together with the exact active scope and every piece
/// of local credential material that can change its meaning.
#[derive(Clone)]
pub(crate) struct PinnedConnection {
    pub(crate) scope: ActiveResourceScope,
    pub(crate) connection_id: Uuid,
    pub(crate) connection_revision: i64,
    pub(crate) binding_revision: i64,
    pub(crate) binding_updated_at: String,
    pub(crate) profile: ConnectionProfile,
    pub(crate) requires_remote_rbac: bool,
    pub(crate) catalog_cache_policy: CatalogCachePolicy,
}
