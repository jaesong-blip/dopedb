//! Characterization tests for generation-aware cache retirement and leases.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use sqlx::sqlite::SqlitePoolOptions;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::connection::pool::{DbPool, LiveConnection};
use crate::connection::ProviderLocalResource;
use crate::model::WorkspaceCredentialMode;
use crate::store::{AccountScope, Store};

use super::*;

#[test]
fn provider_target_generation_and_fingerprint_create_distinct_read_cache_identity() {
    let mut pinned = pin(WorkspaceCredentialMode::MemberLocal);
    pinned.profile.allow_writes = false;
    pinned.profile.database = "app".into();
    let target = provider_target();
    let mut changed = target.clone();
    changed.integration_generation += 1;
    assert_ne!(
        ConnectionCacheKey::new(&pinned, ConnectionAccess::Read, Some(&target), None),
        ConnectionCacheKey::new(&pinned, ConnectionAccess::Read, Some(&changed), None),
    );
    let mut changed_resource = target.clone();
    changed_resource.resource = ProviderLocalResource::Neon {
        project: "project".into(),
        branch: "other-branch".into(),
        database: "app".into(),
        schemas: vec!["public".into()],
    };
    assert_ne!(
        ConnectionCacheKey::new(&pinned, ConnectionAccess::Read, Some(&target), None),
        ConnectionCacheKey::new(
            &pinned,
            ConnectionAccess::Read,
            Some(&changed_resource),
            None,
        ),
    );
}

#[test]
fn provider_local_binding_rotation_and_account_scope_create_distinct_cache_identity() {
    let mut pinned = pin(WorkspaceCredentialMode::MemberLocal);
    pinned.profile.allow_writes = false;
    let target = provider_target();
    let binding = provider_binding(&target, 1);
    let rotated = provider_binding(&target, 2);
    assert_ne!(
        ConnectionCacheKey::new(
            &pinned,
            ConnectionAccess::Read,
            Some(&target),
            Some(&binding),
        ),
        ConnectionCacheKey::new(
            &pinned,
            ConnectionAccess::Read,
            Some(&target),
            Some(&rotated),
        ),
    );
    pinned.scope.selected_account_id = Some("account-b".into());
    pinned.scope.account_scope = AccountScope::WorkspaceUser("account-b".into());
    assert_ne!(
        ConnectionCacheKey::new(
            &pin(WorkspaceCredentialMode::MemberLocal),
            ConnectionAccess::Read,
            Some(&target),
            Some(&binding),
        ),
        ConnectionCacheKey::new(
            &pinned,
            ConnectionAccess::Read,
            Some(&target),
            Some(&binding),
        ),
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
        None,
        None,
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
            has_writable_pool: true,
            skip_fk_metadata: false,
        }),
        generation: 1,
        retire_at: Some(Instant::now()),
        managed_lease: StdMutex::new(None),
        closed: AtomicBool::new(false),
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
            has_writable_pool: true,
            skip_fk_metadata: false,
        }),
        generation: 2,
        retire_at: None,
        managed_lease: StdMutex::new(None),
        closed: AtomicBool::new(false),
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

#[tokio::test]
async fn retired_entry_with_an_active_lease_closes_after_the_last_lease_drops() {
    let pool = SqlitePoolOptions::new()
        .connect_lazy("sqlite::memory:")
        .unwrap();
    let entry = Arc::new(CacheEntry {
        live: Live::Sql(LiveConnection {
            read_pool: DbPool::Sqlite(pool.clone()),
            write_pool: DbPool::Sqlite(pool.clone()),
            has_writable_pool: false,
            skip_fk_metadata: false,
        }),
        generation: 1,
        retire_at: None,
        managed_lease: StdMutex::new(None),
        closed: AtomicBool::new(false),
    });
    let active_lease = Arc::clone(&entry);

    retire_entries(vec![entry]).await;
    assert!(!pool.is_closed());

    drop(active_lease);
    tokio::time::timeout(Duration::from_secs(1), async {
        while !pool.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropping the last lease must close its retired pool");
}
