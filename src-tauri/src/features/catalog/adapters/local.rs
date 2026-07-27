//! Scope-pinned catalog and DDL adapter.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use dopedb_protocol::catalog::CatalogSnapshot;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::connection::{ensure_terminal_pin, ConnectionAccess, ConnectionManager};
use crate::error::AppResult;
use crate::introspect::{self, CatalogReadMode};
use crate::kernel::identity::ConnectionId;
use crate::kernel::TerminalAuthority;
use crate::store::Store;

use super::super::domain::{Catalog, CatalogOverview, CatalogReadPolicy};
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

/// Serializes cache misses and refreshes per connection. The bounded and full
/// catalog projections share one persisted snapshot, so concurrent live scans only
/// duplicate target-database work and can exhaust a small read pool.
#[derive(Clone, Default)]
struct CatalogLoadCoordinator {
    locks: Arc<Mutex<HashMap<ConnectionId, Weak<Mutex<()>>>>>,
}

impl CatalogLoadCoordinator {
    async fn acquire(&self, connection_id: ConnectionId) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(&connection_id).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(connection_id, Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }

    #[cfg(test)]
    async fn tracked_lock_count(&self) -> usize {
        self.locks.lock().await.len()
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
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let _load = self.loads.acquire(connection_id).await;
        introspect::load_catalog_in_context(&self.store, context, policy.into()).await
    }

    async fn load_snapshot(
        &self,
        connection_id: ConnectionId,
        policy: CatalogReadPolicy,
    ) -> AppResult<CatalogSnapshot> {
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let _load = self.loads.acquire(connection_id).await;
        introspect::load_catalog_snapshot_in_context(&self.store, context, policy.into()).await
    }

    async fn load_overview(&self, connection_id: ConnectionId) -> AppResult<CatalogOverview> {
        // An overview deliberately has no Store path. It may be displayed while the
        // detailed catalog is still deferred, so persisting it as a CatalogSnapshot
        // would let a partial shape poison full-catalog consumers.
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let lease = context.connect().await?;
        introspect::overview(lease.live()).await
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
        let _load = self.loads.acquire(authority.connection_id).await;
        introspect::load_catalog_snapshot_in_context(&self.store, authority_context, policy.into())
            .await
    }

    async fn table_ddl(
        &self,
        connection_id: ConnectionId,
        schema: Option<&str>,
        table: &str,
    ) -> AppResult<String> {
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let _load = self.loads.acquire(connection_id).await;
        let lease = context.connect().await?;
        introspect::table_ddl(lease.live(), schema, table).await
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::sync::RwLock;

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

    #[tokio::test]
    async fn inactive_connection_locks_are_pruned_on_the_next_load() {
        let coordinator = CatalogLoadCoordinator::default();
        let first_id = ConnectionId::from(uuid::Uuid::new_v4());
        let second_id = ConnectionId::from(uuid::Uuid::new_v4());
        drop(coordinator.acquire(first_id).await);

        let _second = coordinator.acquire(second_id).await;

        assert_eq!(coordinator.tracked_lock_count().await, 1);
    }

    #[tokio::test]
    async fn retained_scope_guard_can_wait_for_catalog_serialization_ahead_of_a_writer() {
        let coordinator = CatalogLoadCoordinator::default();
        let connection_id = ConnectionId::from(uuid::Uuid::new_v4());
        let scope_gate = Arc::new(RwLock::new(()));
        let first_catalog_load = coordinator.acquire(connection_id).await;

        // `load_terminal_snapshot` validates and retains this guard before it waits
        // for the catalog coordinator. If it re-pinned after waiting, a queued writer
        // could block that nested read and deadlock the terminal request.
        let retained_scope = Arc::clone(&scope_gate).read_owned().await;
        let waiting_coordinator = coordinator.clone();
        let waiting = tokio::spawn(async move {
            let _scope = retained_scope;
            let _catalog = waiting_coordinator.acquire(connection_id).await;
        });

        tokio::task::yield_now().await;
        let writer_scope = Arc::clone(&scope_gate);
        let writer = tokio::spawn(async move {
            let _writer = writer_scope.write_owned().await;
        });

        drop(first_catalog_load);
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("retained scope must let the catalog request finish before a writer")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), writer)
            .await
            .expect("writer must continue after the retained scope is released")
            .unwrap();
    }
}
