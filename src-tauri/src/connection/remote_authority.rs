//! Object-safe remote authority contract injected into the connection pool runtime.

use std::future::Future;
use std::pin::Pin;
#[cfg(test)]
use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;
use zeroize::Zeroizing;

#[cfg(test)]
use crate::error::AppError;
use crate::error::AppResult;
use crate::kernel::identity::{AccountId, ConnectionId, WorkspaceId};
use crate::model::ConnectionProfile;

pub(crate) type RemoteAuthorityFuture<'a, T> =
    Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RemoteConnectionAuthority {
    pub(crate) revision: i64,
}

pub(crate) struct ManagedConnectionLease {
    pub(crate) lease_id: Uuid,
    pub(crate) profile: ConnectionProfile,
    pub(crate) secret: Zeroizing<String>,
    pub(crate) valid_for: Duration,
}

/// Hosted authority required by shared connections.
///
/// The pool runtime owns no HTTP or session-storage implementation. Production
/// injects the workspace control-plane adapter at the composition root, while tests
/// use a fail-closed authority for local-only profiles.
pub(crate) trait RemoteConnectionAuthorityPort: Send + Sync {
    fn authorize<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        connection_id: ConnectionId,
        write: bool,
    ) -> RemoteAuthorityFuture<'a, RemoteConnectionAuthority>;

    fn issue_managed_lease<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        profile: &'a ConnectionProfile,
        write: bool,
    ) -> RemoteAuthorityFuture<'a, ManagedConnectionLease>;

    fn release_managed_lease<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        connection_id: ConnectionId,
        lease_id: Uuid,
    ) -> RemoteAuthorityFuture<'a, ()>;
}

#[cfg(test)]
struct ClosedRemoteConnectionAuthority;

#[cfg(test)]
impl RemoteConnectionAuthorityPort for ClosedRemoteConnectionAuthority {
    fn authorize<'a>(
        &'a self,
        _account_id: &'a AccountId,
        _workspace_id: WorkspaceId,
        _connection_id: ConnectionId,
        _write: bool,
    ) -> RemoteAuthorityFuture<'a, RemoteConnectionAuthority> {
        Box::pin(async {
            Err(AppError::Blocked {
                reason: "remote workspace authority is unavailable in this test".into(),
            })
        })
    }

    fn issue_managed_lease<'a>(
        &'a self,
        _account_id: &'a AccountId,
        _workspace_id: WorkspaceId,
        _profile: &'a ConnectionProfile,
        _write: bool,
    ) -> RemoteAuthorityFuture<'a, ManagedConnectionLease> {
        Box::pin(async {
            Err(AppError::Blocked {
                reason: "managed workspace credentials are unavailable in this test".into(),
            })
        })
    }

    fn release_managed_lease<'a>(
        &'a self,
        _account_id: &'a AccountId,
        _workspace_id: WorkspaceId,
        _connection_id: ConnectionId,
        _lease_id: Uuid,
    ) -> RemoteAuthorityFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
pub(super) fn closed_authority() -> Arc<dyn RemoteConnectionAuthorityPort> {
    Arc::new(ClosedRemoteConnectionAuthority)
}
