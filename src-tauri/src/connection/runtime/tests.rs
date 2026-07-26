use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex as StdSyncMutex;
use std::time::Duration;

use sqlx::sqlite::SqlitePoolOptions;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::connection::pool::{DbPool, LiveConnection};
use crate::connection::{
    ManagedConnectionLease, RemoteAuthorityFuture, RemoteConnectionAuthority,
    RemoteConnectionAuthorityPort,
};
use crate::features::workspaces::WorkspaceKind;
use crate::kernel::identity::{AccountId, ConnectionId, WorkspaceId};
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

struct RecordingManagedAuthority {
    authorized_writes: StdSyncMutex<Vec<bool>>,
    requested_writes: StdSyncMutex<Vec<bool>>,
}

impl RecordingManagedAuthority {
    fn requested_writes(&self) -> Vec<bool> {
        self.requested_writes.lock().unwrap().clone()
    }

    fn authorized_writes(&self) -> Vec<bool> {
        self.authorized_writes.lock().unwrap().clone()
    }
}

impl RemoteConnectionAuthorityPort for RecordingManagedAuthority {
    fn authorize<'a>(
        &'a self,
        _account_id: &'a AccountId,
        _workspace_id: WorkspaceId,
        _connection_id: ConnectionId,
        write: bool,
    ) -> RemoteAuthorityFuture<'a, RemoteConnectionAuthority> {
        self.authorized_writes.lock().unwrap().push(write);
        Box::pin(async { Ok(RemoteConnectionAuthority { revision: 3 }) })
    }

    fn issue_managed_lease<'a>(
        &'a self,
        _account_id: &'a AccountId,
        _workspace_id: WorkspaceId,
        profile: &'a ConnectionProfile,
        write: bool,
    ) -> RemoteAuthorityFuture<'a, ManagedConnectionLease> {
        self.requested_writes.lock().unwrap().push(write);
        let lease = ManagedConnectionLease {
            lease_id: Uuid::new_v4(),
            profile: profile.clone(),
            secret: Zeroizing::new(String::new()),
            valid_for: Duration::from_secs(60),
        };
        Box::pin(async move { Ok(lease) })
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

async fn managed_sqlite_profile() -> (ConnectionProfile, std::path::PathBuf) {
    let path =
        std::env::temp_dir().join(format!("dopedb-managed-access-{}.sqlite", Uuid::new_v4()));
    let pool = SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::query("CREATE TABLE managed_access_test (value TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let mut profile = pin(WorkspaceCredentialMode::Managed).profile;
    profile.engine = Engine::Sqlite;
    profile.database = path.to_string_lossy().into_owned();
    profile.provider = Provider::Generic;
    profile.port = 0;
    (profile, path)
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
fn local_and_member_local_read_and_write_never_share_a_cache_key() {
    for credential_mode in [
        WorkspaceCredentialMode::Local,
        WorkspaceCredentialMode::MemberLocal,
    ] {
        let pin = pin(credential_mode);
        assert_ne!(
            ConnectionCacheKey::new(&pin, ConnectionAccess::Read),
            ConnectionCacheKey::new(&pin, ConnectionAccess::Write),
        );
    }
}

#[tokio::test]
async fn shared_member_local_write_is_denied_before_remote_authority_or_target_access() {
    let authority = RecordingManagedAuthority {
        authorized_writes: StdSyncMutex::new(Vec::new()),
        requested_writes: StdSyncMutex::new(Vec::new()),
    };
    let result = authorize_pin(
        &authority,
        &pin(WorkspaceCredentialMode::MemberLocal),
        ConnectionAccess::Write,
    )
    .await;

    assert!(matches!(
        result,
        Err(crate::error::AppError::Blocked { .. })
    ));
    assert!(authority.authorized_writes().is_empty());
    assert!(authority.requested_writes().is_empty());
}

#[tokio::test]
async fn managed_read_requests_read_lease_and_write_opens_a_separate_writable_live() {
    let (profile, path) = managed_sqlite_profile().await;
    let authority = Arc::new(RecordingManagedAuthority {
        authorized_writes: StdSyncMutex::new(Vec::new()),
        requested_writes: StdSyncMutex::new(Vec::new()),
    });
    let authorization = ConnectionAuthorization {
        user_id: Some("account-a".into()),
        workspace_id: Some(Uuid::from_u128(1)),
    };

    let read = connect_authorized(
        authority.clone(),
        &profile,
        &authorization,
        ConnectionAccess::Read,
    )
    .await
    .unwrap();
    assert!(!read.live.sql().unwrap().has_writable_pool());
    retire_opened(read).await;

    let write = connect_authorized(
        authority.clone(),
        &profile,
        &authorization,
        ConnectionAccess::Write,
    )
    .await
    .unwrap();
    assert!(write.live.sql().unwrap().has_writable_pool());
    retire_opened(write).await;

    assert_eq!(authority.requested_writes(), vec![false, true]);
    std::fs::remove_file(path).unwrap();
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
