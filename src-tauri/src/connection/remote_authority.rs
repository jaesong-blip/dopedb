//! Object-safe remote authority contract injected into the connection pool runtime.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use uuid::Uuid;
use zeroize::Zeroizing;

use super::cloud_sql_proxy::CloudSqlProxyConfig;
use super::ProviderLocalTarget;
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
    pub(crate) cloud_sql_proxy: Option<CloudSqlProxyConfig>,
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
        access: super::ConnectionAccess,
    ) -> RemoteAuthorityFuture<'a, RemoteConnectionAuthority>;

    fn issue_managed_lease<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        profile: &'a ConnectionProfile,
        access: super::ConnectionAccess,
    ) -> RemoteAuthorityFuture<'a, ManagedConnectionLease>;

    fn release_managed_lease<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        connection_id: ConnectionId,
        lease_id: Uuid,
    ) -> RemoteAuthorityFuture<'a, ()>;

    /// Fetch the short-lived, secret-free target for a locally held provider
    /// credential. This is deliberately separate from managed credential leases.
    fn provider_local_target<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        connection_id: ConnectionId,
    ) -> RemoteAuthorityFuture<'a, ProviderLocalTarget>;
}
