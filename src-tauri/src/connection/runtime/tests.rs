use std::collections::HashMap;

use sqlx::sqlite::SqlitePoolOptions;

use crate::connection::pool::{DbPool, LiveConnection};
use crate::features::workspaces::WorkspaceKind;
use crate::model::{Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode};
use crate::store::{ActiveResourceScope, CatalogCachePolicy};

use super::*;

fn pin(credential_mode: WorkspaceCredentialMode) -> PinnedConnection {
    PinnedConnection {
        scope: ActiveResourceScope {
            workspace_id: Uuid::from_u128(1),
            workspace_kind: WorkspaceKind::Team,
            selected_account_id: Some("account-a".into()),
            account_scope: AccountScope::WorkspaceUser("account-a".into()),
            generation: 7,
        },
        connection_id: Uuid::from_u128(2),
        connection_revision: 3,
        binding_revision: 4,
        binding_updated_at: "2026-07-24T00:00:00Z".into(),
        profile: ConnectionProfile {
            id: Uuid::from_u128(2),
            name: "app".into(),
            engine: Engine::Postgres,
            provider: Provider::Neon,
            driver_id: None,
            host: "db.example".into(),
            port: 5432,
            database: "app".into(),
            username: "member".into(),
            sslmode: "verify-full".into(),
            extra_params: HashMap::new(),
            readonly_default: true,
            allow_writes: true,
            secret_ref: None,
            env: None,
            schema_group: None,
            workspace_access: WorkspaceConnectionAccess::Write,
            credential_mode,
        },
        requires_remote_rbac: true,
        catalog_cache_policy: CatalogCachePolicy::Persistent,
    }
}

#[test]
fn managed_read_and_write_leases_never_share_a_cache_key() {
    let pin = pin(WorkspaceCredentialMode::Managed);

    assert_ne!(
        ConnectionCacheKey::new(&pin, ConnectionAccess::Read),
        ConnectionCacheKey::new(&pin, ConnectionAccess::Write)
    );
}

#[test]
fn local_material_reuses_the_outer_cache_for_read_and_write() {
    let pin = pin(WorkspaceCredentialMode::MemberLocal);

    assert_eq!(
        ConnectionCacheKey::new(&pin, ConnectionAccess::Read),
        ConnectionCacheKey::new(&pin, ConnectionAccess::Write)
    );
}

#[tokio::test]
async fn expiry_keeps_the_single_flight_slot_for_the_next_generation() {
    let store_pool = SqlitePoolOptions::new()
        .connect_lazy("sqlite::memory:")
        .unwrap();
    let manager = ConnectionManager::new(Store::from_pool_for_test(store_pool));
    let key = ConnectionCacheKey::new(
        &pin(WorkspaceCredentialMode::MemberLocal),
        ConnectionAccess::Read,
    );
    let slot = manager
        .inner
        .slots
        .entry(key.clone())
        .or_insert_with(|| Arc::new(Mutex::new(ConnectionSlot::default())))
        .clone();

    let first_pool = SqlitePoolOptions::new()
        .connect_lazy("sqlite::memory:")
        .unwrap();
    let first_entry = Arc::new(CacheEntry {
        live: Live::Sql(LiveConnection {
            read_pool: DbPool::Sqlite(first_pool.clone()),
            write_pool: DbPool::Sqlite(first_pool),
            skip_fk_metadata: false,
        }),
        generation: 1,
        retire_at: Some(Instant::now()),
        managed_lease: StdMutex::new(None),
    });
    slot.lock().await.entry = Some(first_entry);
    schedule_expiry(Arc::clone(&slot), 1, Duration::ZERO);

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if slot.lock().await.entry.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let second_pool = SqlitePoolOptions::new()
        .connect_lazy("sqlite::memory:")
        .unwrap();
    slot.lock().await.entry = Some(Arc::new(CacheEntry {
        live: Live::Sql(LiveConnection {
            read_pool: DbPool::Sqlite(second_pool.clone()),
            write_pool: DbPool::Sqlite(second_pool),
            skip_fk_metadata: false,
        }),
        generation: 2,
        retire_at: None,
        managed_lease: StdMutex::new(None),
    }));
    tokio::task::yield_now().await;

    let mapped = manager.inner.slots.get(&key).unwrap().clone();
    assert!(Arc::ptr_eq(&mapped, &slot));
    assert_eq!(
        mapped
            .lock()
            .await
            .entry
            .as_ref()
            .map(|entry| entry.generation),
        Some(2)
    );
}
