//! Scope-pinned catalog and DDL adapter.

use std::collections::HashMap;
use std::sync::Arc;

use dopedb_protocol::catalog::CatalogSnapshot;
use tokio::sync::{Mutex, OwnedMutexGuard};

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
    loads: CatalogLoadCoordinator,
}

/// Serializes cache misses and refreshes per connection. The legacy and canonical
/// catalog projections share one persisted snapshot, so concurrent live scans only
/// duplicate target-database work and can exhaust a small read pool.
#[derive(Clone, Default)]
struct CatalogLoadCoordinator {
    locks: Arc<Mutex<HashMap<ConnectionId, Arc<Mutex<()>>>>>,
}

impl CatalogLoadCoordinator {
    async fn acquire(&self, connection_id: ConnectionId) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(connection_id)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }
}

impl ScopedCatalogGateway {
    pub(crate) fn new(store: Store, connections: ConnectionManager) -> Self {
        Self {
            store,
            connections,
            loads: CatalogLoadCoordinator::default(),
        }
    }
}

impl CatalogGatewayPort for ScopedCatalogGateway {
    async fn load(
        &self,
        connection_id: ConnectionId,
        policy: CatalogReadPolicy,
    ) -> AppResult<Catalog> {
        let _load = self.loads.acquire(connection_id).await;
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
        let _load = self.loads.acquire(connection_id).await;
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn same_connection_catalog_loads_are_serialized() {
        let coordinator = CatalogLoadCoordinator::default();
        let connection_id = ConnectionId::from(uuid::Uuid::new_v4());
        let first = coordinator.acquire(connection_id).await;
        let waiting_coordinator = coordinator.clone();
        let waiting = tokio::spawn(async move {
            let _guard = waiting_coordinator.acquire(connection_id).await;
        });

        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(first);
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("the next catalog load should continue after the first")
            .unwrap();
    }

    #[tokio::test]
    async fn different_connections_can_load_catalogs_concurrently() {
        let coordinator = CatalogLoadCoordinator::default();
        let first_id = ConnectionId::from(uuid::Uuid::new_v4());
        let second_id = ConnectionId::from(uuid::Uuid::new_v4());
        let _first = coordinator.acquire(first_id).await;

        tokio::time::timeout(Duration::from_secs(1), coordinator.acquire(second_id))
            .await
            .expect("different connections must not block each other");
    }
}
