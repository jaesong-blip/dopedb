//! Concrete connection adapters for SQLite, live pool authority, drivers, and keychain.

use std::sync::Arc;

use uuid::Uuid;
use zeroize::Zeroizing;

use crate::connection::{
    self, ensure_terminal_pin, ConnectionAccess, ConnectionContext, ConnectionManager,
    ConnectionMutation, ConnectionOperationScope,
};
use crate::driver;
use crate::error::AppResult;
use crate::kernel::identity::ConnectionId;
use crate::kernel::TerminalAuthority;
use crate::model::ConnectionProfile;
use crate::store::Store;

use super::domain::DriverDescriptor;
use super::ports::{
    AdHocConnectionPort, AuthorizedConnectionPort, ConnectionCredentialVault,
    ConnectionMutationPort, ConnectionPermission, ConnectionRepositoryPort, ConnectionRuntimePort,
    DriverRegistryPort, ScopeMutationPort,
};

#[derive(Clone)]
pub(crate) struct SqliteConnectionRepository {
    store: Store,
}

impl SqliteConnectionRepository {
    pub(crate) fn new(store: Store) -> Self {
        Self { store }
    }
}

impl ConnectionRepositoryPort for SqliteConnectionRepository {
    async fn list(&self) -> AppResult<Vec<ConnectionProfile>> {
        self.store.list_connections().await
    }

    async fn ensure_write_scope(&self, id: ConnectionId) -> AppResult<()> {
        self.store.ensure_connection_write_scope(id.into()).await
    }

    async fn upsert(&self, profile: &ConnectionProfile) -> AppResult<ConnectionProfile> {
        self.store.upsert_connection(profile).await
    }

    async fn clear_schema_cache(&self, id: ConnectionId) -> AppResult<()> {
        self.store.clear_schema_cache(id.into()).await
    }

    async fn set_schema_group(
        &self,
        ids: &[ConnectionId],
        schema_group: Option<String>,
    ) -> AppResult<()> {
        let ids = ids.iter().copied().map(Uuid::from).collect::<Vec<_>>();
        self.store
            .set_connections_schema_group(&ids, schema_group)
            .await
    }

    async fn delete(&self, id: ConnectionId) -> AppResult<()> {
        self.store.delete_connection(id.into()).await
    }

    async fn get(&self, id: ConnectionId) -> AppResult<ConnectionProfile> {
        self.store.get_connection(id.into()).await
    }
}

pub(crate) struct RuntimeScopeMutation {
    inner: ConnectionMutation,
}

pub(crate) struct RuntimeScopeRead {
    _inner: ConnectionOperationScope,
}

impl ScopeMutationPort for RuntimeScopeMutation {
    async fn retire_connection(self, id: ConnectionId) {
        self.inner.retire_connection(id.into()).await;
    }

    async fn retire_connections(self, ids: &[ConnectionId]) {
        let ids = ids.iter().copied().map(Uuid::from).collect::<Vec<_>>();
        self.inner.retire_connections(&ids).await;
    }
}

pub(crate) struct RuntimeConnectionMutation {
    inner: ConnectionMutation,
}

impl ConnectionMutationPort for RuntimeConnectionMutation {
    fn profile(&self) -> &ConnectionProfile {
        &self.inner.pin().profile
    }

    async fn retire_connection(self, id: ConnectionId) {
        self.inner.retire_connection(id.into()).await;
    }
}

pub(crate) struct RuntimeAuthorizedConnection {
    inner: ConnectionContext,
}

impl AuthorizedConnectionPort for RuntimeAuthorizedConnection {
    fn profile(&self) -> &ConnectionProfile {
        &self.inner.pin().profile
    }

    async fn test_fresh(self) -> AppResult<()> {
        self.inner.test_fresh().await
    }
}

#[derive(Clone)]
pub(crate) struct RuntimeConnectionAuthority {
    connections: ConnectionManager,
}

impl RuntimeConnectionAuthority {
    pub(crate) fn new(connections: ConnectionManager) -> Self {
        Self { connections }
    }
}

impl ConnectionRuntimePort for RuntimeConnectionAuthority {
    type ScopeRead = RuntimeScopeRead;
    type ScopeMutation = RuntimeScopeMutation;
    type ConnectionMutation = RuntimeConnectionMutation;
    type AuthorizedConnection = RuntimeAuthorizedConnection;

    async fn begin_scope_read(&self) -> Self::ScopeRead {
        RuntimeScopeRead {
            _inner: self.connections.begin_operation_scope().await,
        }
    }

    async fn begin_scope_mutation(&self) -> Self::ScopeMutation {
        RuntimeScopeMutation {
            inner: self.connections.begin_scope_mutation().await,
        }
    }

    async fn begin_connection_mutation(
        &self,
        id: ConnectionId,
        permission: ConnectionPermission,
    ) -> AppResult<Self::ConnectionMutation> {
        Ok(RuntimeConnectionMutation {
            inner: self
                .connections
                .begin_connection_mutation(id.into(), access(permission))
                .await?,
        })
    }

    async fn authorize(
        &self,
        id: ConnectionId,
        permission: ConnectionPermission,
    ) -> AppResult<Self::AuthorizedConnection> {
        Ok(RuntimeAuthorizedConnection {
            inner: self.connections.pin(id.into(), access(permission)).await?,
        })
    }

    async fn authorize_terminal(
        &self,
        authority: &TerminalAuthority,
        permission: ConnectionPermission,
    ) -> AppResult<Self::AuthorizedConnection> {
        let context = self
            .connections
            .pin(authority.connection_id.into(), access(permission))
            .await?;
        ensure_terminal_pin(authority, context.pin())?;
        Ok(RuntimeAuthorizedConnection { inner: context })
    }
}

const fn access(permission: ConnectionPermission) -> ConnectionAccess {
    match permission {
        ConnectionPermission::Read => ConnectionAccess::Read,
    }
}

#[derive(Clone, Copy)]
pub(crate) struct SystemDriverRegistry;

impl DriverRegistryPort for SystemDriverRegistry {
    fn list(&self) -> Vec<DriverDescriptor> {
        driver::list()
    }

    fn install(&self, id: &str) -> AppResult<DriverDescriptor> {
        driver::install(id)
    }

    fn validate(&self, profile: &ConnectionProfile) -> AppResult<()> {
        driver::validate(profile).map(|_| ())
    }
}

#[derive(Clone, Copy)]
pub(crate) struct SystemAdHocConnection;

/// An unsaved connection-form probe is only a reachability read, never a target
/// mutation capability.
pub(super) const AD_HOC_CONNECTION_TEST_ACCESS: ConnectionAccess = ConnectionAccess::Read;

impl AdHocConnectionPort for SystemAdHocConnection {
    async fn test(
        &self,
        profile: &ConnectionProfile,
        password: Zeroizing<String>,
    ) -> AppResult<()> {
        // A reachability probe only pings the target; it never needs a write
        // credential or a write-capable pool (including for MongoDB profiles).
        let live =
            connection::connect(profile, password.as_str(), AD_HOC_CONNECTION_TEST_ACCESS).await?;
        let result = live.test().await;
        live.close().await;
        result
    }
}

pub(crate) struct SystemConnectionCredentialVault;

impl ConnectionCredentialVault for SystemConnectionCredentialVault {
    fn fetch_profile(&self, profile: &ConnectionProfile) -> AppResult<Zeroizing<String>> {
        Ok(Zeroizing::new(connection::fetch_profile_secret(profile)?))
    }

    fn store(&self, id: &Uuid, secret: &str) -> AppResult<()> {
        connection::store_secret(id, secret)
    }

    fn delete(&self, id: &Uuid) -> AppResult<()> {
        connection::delete_secret(id)
    }
}

pub(crate) fn system_connection_credentials() -> Arc<dyn ConnectionCredentialVault> {
    Arc::new(SystemConnectionCredentialVault)
}
