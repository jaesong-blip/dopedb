//! Scope-pinned catalog and DDL adapter.

use dopedb_protocol::catalog::CatalogSnapshot;

use crate::connection::{ensure_terminal_pin, ConnectionAccess, ConnectionManager};
use crate::error::AppResult;
use crate::introspect::{self, CatalogReadMode};
use crate::kernel::identity::ConnectionId;
use crate::kernel::TerminalAuthority;
use crate::store::Store;

use super::super::domain::{Catalog, CatalogReadPolicy};
use super::super::ports::CatalogGatewayPort;

impl From<CatalogReadPolicy> for CatalogReadMode {
    fn from(policy: CatalogReadPolicy) -> Self {
        match policy {
            CatalogReadPolicy::CacheFirst => Self::CacheFirst,
            CatalogReadPolicy::Refresh => Self::Refresh,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ScopedCatalogGateway {
    store: Store,
    connections: ConnectionManager,
}

impl ScopedCatalogGateway {
    pub(crate) fn new(store: Store, connections: ConnectionManager) -> Self {
        Self { store, connections }
    }
}

impl CatalogGatewayPort for ScopedCatalogGateway {
    async fn load(
        &self,
        connection_id: ConnectionId,
        policy: CatalogReadPolicy,
    ) -> AppResult<Catalog> {
        introspect::load_catalog(
            &self.store,
            &self.connections,
            connection_id.into(),
            policy.into(),
        )
        .await
    }

    async fn load_snapshot(
        &self,
        connection_id: ConnectionId,
        policy: CatalogReadPolicy,
    ) -> AppResult<CatalogSnapshot> {
        introspect::load_catalog_snapshot(
            &self.store,
            &self.connections,
            connection_id.into(),
            policy.into(),
        )
        .await
    }

    async fn load_terminal_snapshot(
        &self,
        authority: &TerminalAuthority,
        policy: CatalogReadPolicy,
    ) -> AppResult<CatalogSnapshot> {
        let authority_context = self
            .connections
            .pin(authority.connection_id.into(), ConnectionAccess::Read)
            .await?;
        ensure_terminal_pin(authority, authority_context.pin())?;
        self.load_snapshot(authority.connection_id, policy).await
    }

    async fn table_ddl(
        &self,
        connection_id: ConnectionId,
        schema: Option<&str>,
        table: &str,
    ) -> AppResult<String> {
        let lease = self
            .connections
            .acquire(connection_id.into(), ConnectionAccess::Read)
            .await?;
        introspect::table_ddl(lease.live(), schema, table).await
    }
}
