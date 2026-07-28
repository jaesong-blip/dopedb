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
