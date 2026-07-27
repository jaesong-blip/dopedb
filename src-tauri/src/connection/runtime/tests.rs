use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::Mutex as StdSyncMutex;
use std::time::Duration;

use sqlx::sqlite::SqlitePoolOptions;
use tokio::sync::Notify;
use tokio::time::Instant;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::connection::pool::{DbPool, LiveConnection};
use crate::connection::{
    closed_provider_local_port, ManagedConnectionLease, ProviderLocalBindingPin,
    ProviderLocalConnectionPort, ProviderLocalFuture, ProviderLocalPinRequest,
    ProviderLocalResolveRequest, ProviderLocalResource, ProviderLocalTarget, RemoteAuthorityFuture,
    RemoteConnectionAuthority, RemoteConnectionAuthorityPort,
};
use crate::features::workspaces::WorkspaceKind;
use crate::kernel::identity::{
    AccountId, ConnectionId, ProviderBindingId, ProviderIntegrationId, WorkspaceId,
};
use crate::model::{Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode};
use crate::store::{AccountScope, ActiveResourceScope, CatalogCachePolicy};

use super::*;

mod cache;
mod provider_fence;

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
    target_requests: StdSyncMutex<usize>,
}

struct RecordingProviderLocal;

impl ProviderLocalConnectionPort for RecordingProviderLocal {
    fn authorize_binding<'a>(
        &'a self,
        request: ProviderLocalPinRequest<'a>,
    ) -> ProviderLocalFuture<'a, ProviderLocalBindingPin> {
        let pin = ProviderLocalBindingPin {
            binding_id: ProviderBindingId::from(Uuid::from_u128(9)),
            binding_revision: 1,
            account_id: request.account_id.clone(),
            workspace_id: request.workspace_id,
            integration_id: request.authority.integration_id,
            integration_generation: request.authority.integration_generation,
            provider: request.authority.provider,
            resource_fingerprint: request.authority.resource_fingerprint.clone(),
        };
        Box::pin(async move { Ok(pin) })
    }

    fn resolve<'a>(
        &'a self,
        _request: ProviderLocalResolveRequest<'a>,
    ) -> ProviderLocalFuture<'a, crate::connection::ResolvedProviderLocalConnection> {
        Box::pin(async { unreachable!("resolver is not exercised by this authority test") })
    }
}

/// Deterministic cache-handoff fake: binding authorization is secret-free while
/// `resolve` represents the only credential-reading provider operation.
struct CacheProviderLocal {
    binding_calls: AtomicUsize,
    resolve_calls: AtomicUsize,
    reject_after_first_binding: AtomicBool,
    binding_revision: AtomicI64,
    cache_hit_race: StdSyncMutex<Option<Arc<CacheHitRace>>>,
}

/// Coordinates the precise interleaving where caller A holds an old cache Arc
/// while caller B observes the binding revoke and detaches that generation.
struct CacheHitRace {
    a_reauthorization_started: Notify,
    resume_a_with_old_authorization: Notify,
    enabled_calls: AtomicUsize,
}

impl CacheProviderLocal {
    fn new() -> Self {
        Self {
            binding_calls: AtomicUsize::new(0),
            resolve_calls: AtomicUsize::new(0),
            reject_after_first_binding: AtomicBool::new(false),
            binding_revision: AtomicI64::new(1),
            cache_hit_race: StdSyncMutex::new(None),
        }
    }

    fn begin_cache_hit_race(&self) -> Arc<CacheHitRace> {
        let race = Arc::new(CacheHitRace {
            a_reauthorization_started: Notify::new(),
            resume_a_with_old_authorization: Notify::new(),
            enabled_calls: AtomicUsize::new(0),
        });
        *self.cache_hit_race.lock().unwrap() = Some(Arc::clone(&race));
        race
    }
}

impl ProviderLocalConnectionPort for CacheProviderLocal {
    fn authorize_binding<'a>(
        &'a self,
        request: ProviderLocalPinRequest<'a>,
    ) -> ProviderLocalFuture<'a, ProviderLocalBindingPin> {
        let call = self.binding_calls.fetch_add(1, Ordering::SeqCst);
        let race = self.cache_hit_race.lock().unwrap().clone();
        if call > 0 && self.reject_after_first_binding.load(Ordering::SeqCst) {
            return Box::pin(async {
                Err(crate::error::AppError::Blocked {
                    reason: "provider-local binding was revoked".into(),
                })
            });
        }
        let pin = ProviderLocalBindingPin {
            binding_id: ProviderBindingId::from(Uuid::from_u128(9)),
            binding_revision: self.binding_revision.load(Ordering::SeqCst),
            account_id: request.account_id.clone(),
            workspace_id: request.workspace_id,
            integration_id: request.authority.integration_id,
            integration_generation: request.authority.integration_generation,
            provider: request.authority.provider,
            resource_fingerprint: request.authority.resource_fingerprint.clone(),
        };
        Box::pin(async move {
            if let Some(race) = race {
                match race.enabled_calls.fetch_add(1, Ordering::SeqCst) {
                    // Caller A must continue with the authorization that was valid
                    // before B detached the cache generation.
                    0 => {
                        race.a_reauthorization_started.notify_waiters();
                        race.resume_a_with_old_authorization.notified().await;
                    }
                    // Caller B observes the revoke and its connection path detaches
                    // the exact cached entry before the test resumes A.
                    1 => {
                        return Err(crate::error::AppError::Blocked {
                            reason: "provider-local binding was revoked".into(),
                        });
                    }
                    _ => {}
                }
            }
            Ok(pin)
        })
    }

    fn resolve<'a>(
        &'a self,
        _request: ProviderLocalResolveRequest<'a>,
    ) -> ProviderLocalFuture<'a, crate::connection::ResolvedProviderLocalConnection> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Err(crate::error::AppError::Blocked {
                reason: "test resolver must not open a cache hit".into(),
            })
        })
    }
}

struct CacheAuthority {
    authorize_calls: AtomicUsize,
}

impl CacheAuthority {
    fn new() -> Self {
        Self {
            authorize_calls: AtomicUsize::new(0),
        }
    }
}

impl RemoteConnectionAuthorityPort for CacheAuthority {
    fn authorize<'a>(
        &'a self,
        _account_id: &'a AccountId,
        _workspace_id: WorkspaceId,
        _connection_id: ConnectionId,
        _write: bool,
    ) -> RemoteAuthorityFuture<'a, RemoteConnectionAuthority> {
        self.authorize_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(RemoteConnectionAuthority { revision: 3 }) })
    }

    fn issue_managed_lease<'a>(
        &'a self,
        _account_id: &'a AccountId,
        _workspace_id: WorkspaceId,
        _profile: &'a ConnectionProfile,
        _write: bool,
    ) -> RemoteAuthorityFuture<'a, ManagedConnectionLease> {
        Box::pin(async { unreachable!("managed paths do not use provider-local target") })
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

    fn provider_local_target<'a>(
        &'a self,
        _account_id: &'a AccountId,
        _workspace_id: WorkspaceId,
        _connection_id: ConnectionId,
    ) -> RemoteAuthorityFuture<'a, ProviderLocalTarget> {
        Box::pin(async { Ok(provider_target()) })
    }
}

impl RecordingManagedAuthority {
    fn requested_writes(&self) -> Vec<bool> {
        self.requested_writes.lock().unwrap().clone()
    }

    fn authorized_writes(&self) -> Vec<bool> {
        self.authorized_writes.lock().unwrap().clone()
    }

    fn target_requests(&self) -> usize {
        *self.target_requests.lock().unwrap()
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

    fn provider_local_target<'a>(
        &'a self,
        _account_id: &'a AccountId,
        _workspace_id: WorkspaceId,
        _connection_id: ConnectionId,
    ) -> RemoteAuthorityFuture<'a, ProviderLocalTarget> {
        *self.target_requests.lock().unwrap() += 1;
        Box::pin(async { Ok(provider_target()) })
    }
}

fn provider_target() -> ProviderLocalTarget {
    ProviderLocalTarget {
        connection_id: ConnectionId::from(Uuid::from_u128(2)),
        connection_revision: 3,
        integration_id: ProviderIntegrationId::from(Uuid::from_u128(3)),
        integration_generation: 4,
        provider: Provider::Neon,
        resource_fingerprint: "a".repeat(64),
        resource: ProviderLocalResource::Neon {
            project: "project".into(),
            branch: "branch".into(),
            database: "app".into(),
            schemas: vec!["public".into()],
        },
        expires_at: chrono::Utc::now() + chrono::Duration::seconds(90),
    }
}

fn provider_binding(target: &ProviderLocalTarget, revision: i64) -> ProviderLocalBindingPin {
    ProviderLocalBindingPin {
        binding_id: ProviderBindingId::from(Uuid::from_u128(9)),
        binding_revision: revision,
        account_id: AccountId::new("account-a").unwrap(),
        workspace_id: WorkspaceId::from(Uuid::from_u128(1)),
        integration_id: target.integration_id,
        integration_generation: target.integration_generation,
        provider: target.provider,
        resource_fingerprint: target.resource_fingerprint.clone(),
    }
}

async fn cached_provider_fixture(
    authority: Arc<CacheAuthority>,
    local: Arc<CacheProviderLocal>,
) -> (
    ConnectionManager,
    PinnedConnection,
    ConnectionAuthorization,
    sqlx::SqlitePool,
) {
    let store_pool = SqlitePoolOptions::new()
        .connect_lazy("sqlite::memory:")
        .expect("test store pool");
    let manager = ConnectionManager::with_authorities(
        Store::from_pool_for_test(store_pool),
        authority,
        local,
    );
    manager.trust_pins_for_test();
    let mut pinned = pin(WorkspaceCredentialMode::MemberLocal);
    pinned.profile.allow_writes = false;
    let authorization = authorize_pin(
        manager.inner.remote_authority.as_ref(),
        manager.inner.provider_local.as_ref(),
        &pinned,
        ConnectionAccess::Read,
    )
    .await
    .expect("initial provider-local authorization");
    let key = ConnectionCacheKey::new(
        &pinned,
        ConnectionAccess::Read,
        authorization.provider_local_target.as_ref(),
        authorization.provider_local_pin.as_ref(),
    );
    let slot = manager
        .inner
        .slots
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(ConnectionSlot::default())))
        .clone();
    let pool = SqlitePoolOptions::new()
        .connect_lazy("sqlite::memory:")
        .expect("cached live pool");
    slot.lock().await.entry = Some(Arc::new(CacheEntry {
        live: Live::Sql(LiveConnection {
            read_pool: DbPool::Sqlite(pool.clone()),
            write_pool: DbPool::Sqlite(pool.clone()),
            has_writable_pool: false,
            skip_fk_metadata: false,
        }),
        generation: 1,
        // Match the authority safety window so this is a genuine cache hit,
        // rather than the expiry-shortening branch that correctly reopens.
        retire_at: Some(Instant::now() + Duration::from_secs(60)),
        managed_lease: StdSyncMutex::new(None),
        closed: AtomicBool::new(false),
    }));
    (manager, pinned, authorization, pool)
}

async fn cached_provider_context(
    authority: Arc<CacheAuthority>,
    local: Arc<CacheProviderLocal>,
) -> (ConnectionContext, sqlx::SqlitePool) {
    let (manager, pin, authorization, pool) = cached_provider_fixture(authority, local).await;
    let scope_guard = Arc::clone(&manager.inner.scope_gate).read_owned().await;
    let provider_binding_fence_epoch = manager.provider_binding_fence_epoch();
    (
        ConnectionContext {
            manager,
            pin,
            access: ConnectionAccess::Read,
            authorization,
            provider_binding_fence_epoch,
            scope_guard: Some(scope_guard),
        },
        pool,
    )
}

async fn cached_provider_context_from_authorization(
    manager: ConnectionManager,
    pin: PinnedConnection,
    authorization: ConnectionAuthorization,
) -> ConnectionContext {
    let scope_guard = Arc::clone(&manager.inner.scope_gate).read_owned().await;
    let provider_binding_fence_epoch = manager.provider_binding_fence_epoch();
    ConnectionContext {
        manager,
        pin,
        access: ConnectionAccess::Read,
        authorization,
        provider_binding_fence_epoch,
        scope_guard: Some(scope_guard),
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
        ConnectionCacheKey::new(&pin, ConnectionAccess::Read, None, None),
        ConnectionCacheKey::new(&pin, ConnectionAccess::Write, None, None)
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
            ConnectionCacheKey::new(&pin, ConnectionAccess::Read, None, None),
            ConnectionCacheKey::new(&pin, ConnectionAccess::Write, None, None),
        );
    }
}

#[tokio::test]
async fn shared_member_local_write_is_denied_before_remote_authority_or_target_access() {
    let authority = RecordingManagedAuthority {
        authorized_writes: StdSyncMutex::new(Vec::new()),
        requested_writes: StdSyncMutex::new(Vec::new()),
        target_requests: StdSyncMutex::new(0),
    };
    let result = authorize_pin(
        &authority,
        &RecordingProviderLocal,
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
    assert_eq!(authority.target_requests(), 0);
}

#[tokio::test]
async fn provider_member_local_read_requires_target_after_generic_authorization() {
    let authority = RecordingManagedAuthority {
        authorized_writes: StdSyncMutex::new(Vec::new()),
        requested_writes: StdSyncMutex::new(Vec::new()),
        target_requests: StdSyncMutex::new(0),
    };
    let mut pinned = pin(WorkspaceCredentialMode::MemberLocal);
    pinned.profile.database = "app".into();
    pinned.profile.allow_writes = false;
    let authorization = authorize_pin(
        &authority,
        &RecordingProviderLocal,
        &pinned,
        ConnectionAccess::Read,
    )
    .await
    .expect("read target after read authorization");
    assert_eq!(authority.authorized_writes(), vec![false]);
    assert_eq!(authority.target_requests(), 1);
    let target = authorization
        .provider_local_target
        .expect("provider target was retained");
    assert_eq!(target.integration_generation, 4);
    assert_eq!(target.resource_fingerprint, "a".repeat(64));
}

#[tokio::test]
async fn generic_member_local_read_does_not_request_provider_target() {
    let authority = RecordingManagedAuthority {
        authorized_writes: StdSyncMutex::new(Vec::new()),
        requested_writes: StdSyncMutex::new(Vec::new()),
        target_requests: StdSyncMutex::new(0),
    };
    let mut pinned = pin(WorkspaceCredentialMode::MemberLocal);
    pinned.profile.provider = Provider::Generic;
    let closed = closed_provider_local_port();
    let authorization = authorize_pin(&authority, closed.as_ref(), &pinned, ConnectionAccess::Read)
        .await
        .expect("generic shared read");
    assert!(authorization.provider_local_target.is_none());
    assert_eq!(authority.target_requests(), 0);
}

#[tokio::test]
async fn provider_local_resolver_failure_never_falls_back_to_member_local_profile_secret() {
    let authority = Arc::new(RecordingManagedAuthority {
        authorized_writes: StdSyncMutex::new(Vec::new()),
        requested_writes: StdSyncMutex::new(Vec::new()),
        target_requests: StdSyncMutex::new(0),
    });
    let mut profile = pin(WorkspaceCredentialMode::MemberLocal).profile;
    profile.database = "app".into();
    profile.allow_writes = false;
    profile.secret_ref = Some(Uuid::new_v4().to_string());
    let authorization = ConnectionAuthorization {
        user_id: Some("account-a".into()),
        workspace_id: Some(Uuid::from_u128(1)),
        provider_local_target: Some(provider_target()),
        provider_local_pin: None,
    };
    let result = connect_authorized(
        authority,
        closed_provider_local_port(),
        &profile,
        &authorization,
        ConnectionAccess::Read,
    )
    .await;
    assert!(matches!(
        result,
        Err(crate::error::AppError::Blocked { .. })
    ));
}

#[tokio::test]
async fn provider_local_cache_hit_reauthorizes_without_secret_resolution() {
    let authority = Arc::new(CacheAuthority::new());
    let local = Arc::new(CacheProviderLocal::new());
    let (context, _pool) =
        cached_provider_context(Arc::clone(&authority), Arc::clone(&local)).await;

    let lease = context
        .connect()
        .await
        .expect("the valid cached provider-local pool is handed off");
    assert_eq!(authority.authorize_calls.load(Ordering::SeqCst), 2);
    assert_eq!(local.binding_calls.load(Ordering::SeqCst), 2);
    assert_eq!(local.resolve_calls.load(Ordering::SeqCst), 0);
    drop(lease);
}

#[tokio::test]
async fn provider_local_revocation_detaches_and_closes_the_cached_pool_before_error() {
    let authority = Arc::new(CacheAuthority::new());
    let local = Arc::new(CacheProviderLocal::new());
    local
        .reject_after_first_binding
        .store(true, Ordering::SeqCst);
    let (context, pool) = cached_provider_context(Arc::clone(&authority), Arc::clone(&local)).await;

    assert!(matches!(
        context.connect().await,
        Err(crate::error::AppError::Blocked { .. })
    ));
    assert_eq!(authority.authorize_calls.load(Ordering::SeqCst), 2);
    assert_eq!(local.binding_calls.load(Ordering::SeqCst), 2);
    assert_eq!(local.resolve_calls.load(Ordering::SeqCst), 0);
    assert!(
        pool.is_closed(),
        "revocation must retire the exact cached pool"
    );
}

#[tokio::test]
async fn provider_local_rotated_binding_retires_cache_and_attempts_a_new_open() {
    let authority = Arc::new(CacheAuthority::new());
    let local = Arc::new(CacheProviderLocal::new());
    let (context, pool) = cached_provider_context(Arc::clone(&authority), Arc::clone(&local)).await;
    local.binding_revision.store(2, Ordering::SeqCst);

    assert!(matches!(
        context.connect().await,
        Err(crate::error::AppError::Blocked { .. })
    ));
    assert_eq!(authority.authorize_calls.load(Ordering::SeqCst), 2);
    assert_eq!(local.binding_calls.load(Ordering::SeqCst), 2);
    assert_eq!(local.resolve_calls.load(Ordering::SeqCst), 1);
    assert!(pool.is_closed(), "rotated binding must retire the old pool");
}

#[tokio::test]
async fn cache_handoff_never_returns_an_arc_detached_by_a_concurrent_provider_revocation() {
    let authority = Arc::new(CacheAuthority::new());
    let local = Arc::new(CacheProviderLocal::new());
    let (manager, pinned, authorization_a, pool) =
        cached_provider_fixture(Arc::clone(&authority), Arc::clone(&local)).await;
    let old_target = provider_target();
    let old_key = ConnectionCacheKey::new(
        &pinned,
        ConnectionAccess::Read,
        Some(&old_target),
        Some(&provider_binding(&old_target, 1)),
    );
    let manager_for_assertion = manager.clone();

    // Build B's context before enabling the race so both callers begin with the
    // same old-valid remote/local authority snapshot. The two cache reauth calls
    // below are the only operations coordinated by the fake.
    let authorization_b = authorize_pin(
        manager.inner.remote_authority.as_ref(),
        manager.inner.provider_local.as_ref(),
        &pinned,
        ConnectionAccess::Read,
    )
    .await
    .expect("second caller starts with the old valid authority");
    let context_a = cached_provider_context_from_authorization(
        manager.clone(),
        pinned.clone(),
        authorization_a,
    )
    .await;
    let context_b =
        cached_provider_context_from_authorization(manager, pinned, authorization_b).await;
    let race = local.begin_cache_hit_race();

    // Register before spawning A so the fake cannot notify before this waiter
    // exists. A clones the cache entry then pauses inside secret-free binding
    // reauthorization; B revokes and detaches exactly that slot.
    let a_started = race.a_reauthorization_started.notified();
    let caller_a = tokio::spawn(async move { context_a.connect().await });
    a_started.await;

    let caller_b = tokio::spawn(async move { context_b.connect().await });
    assert!(matches!(
        caller_b.await.expect("caller B task joins"),
        Err(crate::error::AppError::Blocked { .. })
    ));
    assert!(
        manager_for_assertion.inner.slots.get(&old_key).is_none(),
        "B must remove the exact old cache slot before A resumes"
    );
    assert_eq!(local.resolve_calls.load(Ordering::SeqCst), 0);
    assert!(
        !pool.is_closed(),
        "A still owns the old Arc until the final hand-off check rejects it"
    );

    // B has detached the slot. A's old authorization now succeeds, but the
    // final Arc/generation check must reject the detached entry and attempt a
    // new open instead of returning the old Live. The resolver fails by design,
    // proving no old cache lease escaped.
    race.resume_a_with_old_authorization.notify_waiters();
    assert!(matches!(
        caller_a.await.expect("caller A task joins"),
        Err(crate::error::AppError::Blocked { .. })
    ));
    assert_eq!(local.resolve_calls.load(Ordering::SeqCst), 1);
    tokio::time::timeout(Duration::from_secs(1), async {
        while !pool.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the detached pool closes after caller A releases its final Arc");
}

#[test]
fn gcp_provider_local_resolution_requires_verified_ca_material() {
    let mut original = pin(WorkspaceCredentialMode::MemberLocal).profile;
    original.provider = Provider::GcpCloudSql;
    original.database = "app".into();
    original.allow_writes = false;
    original.secret_ref = Some(Uuid::new_v4().to_string());
    let target = ProviderLocalTarget {
        connection_id: ConnectionId::from(original.id),
        connection_revision: 3,
        integration_id: ProviderIntegrationId::from(Uuid::from_u128(3)),
        integration_generation: 4,
        provider: Provider::GcpCloudSql,
        resource_fingerprint: "a".repeat(64),
        resource: ProviderLocalResource::GcpCloudSql {
            project: "project".into(),
            instance: "instance".into(),
            database: "app".into(),
            engine: Engine::Postgres,
            network_mode: crate::connection::GcpCloudSqlNetworkMode::PrivateServicesAccess,
        },
        expires_at: chrono::Utc::now() + chrono::Duration::seconds(90),
    };
    let mut resolved = original.clone();
    resolved.host = "10.0.0.4".into();
    resolved.username = "member".into();
    resolved.sslmode = "verify-ca".into();
    resolved.extra_params.insert(
        "sslrootcert_pem".into(),
        "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----".into(),
    );
    assert!(
        authority::validate_resolved_provider_local_profile(&original, &target, &resolved).is_ok()
    );
    resolved.extra_params.clear();
    assert!(
        authority::validate_resolved_provider_local_profile(&original, &target, &resolved).is_err()
    );
}

#[test]
fn provider_local_resolver_cannot_substitute_a_database_username() {
    let mut original = pin(WorkspaceCredentialMode::MemberLocal).profile;
    original.provider = Provider::GcpCloudSql;
    original.database = "app".into();
    original.allow_writes = false;
    original.secret_ref = Some(Uuid::new_v4().to_string());
    let target = ProviderLocalTarget {
        connection_id: ConnectionId::from(original.id),
        connection_revision: 3,
        integration_id: ProviderIntegrationId::from(Uuid::from_u128(3)),
        integration_generation: 4,
        provider: Provider::GcpCloudSql,
        resource_fingerprint: "a".repeat(64),
        resource: ProviderLocalResource::GcpCloudSql {
            project: "project".into(),
            instance: "instance".into(),
            database: "app".into(),
            engine: Engine::Postgres,
            network_mode: crate::connection::GcpCloudSqlNetworkMode::PrivateServicesAccess,
        },
        expires_at: chrono::Utc::now() + chrono::Duration::seconds(90),
    };
    let mut resolved = original.clone();
    resolved.host = "10.0.0.4".into();
    resolved.sslmode = "verify-ca".into();
    resolved.extra_params.insert(
        "sslrootcert_pem".into(),
        "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----".into(),
    );
    resolved.username = "owner-or-iam-admin".into();
    assert!(
        authority::validate_resolved_provider_local_profile(&original, &target, &resolved).is_err()
    );
}

#[tokio::test]
async fn managed_read_requests_read_lease_and_write_opens_a_separate_writable_live() {
    let (profile, path) = managed_sqlite_profile().await;
    let authority = Arc::new(RecordingManagedAuthority {
        authorized_writes: StdSyncMutex::new(Vec::new()),
        requested_writes: StdSyncMutex::new(Vec::new()),
        target_requests: StdSyncMutex::new(0),
    });
    let authorization = ConnectionAuthorization {
        user_id: Some("account-a".into()),
        workspace_id: Some(Uuid::from_u128(1)),
        provider_local_target: None,
        provider_local_pin: None,
    };

    let read = connect_authorized(
        authority.clone(),
        closed_provider_local_port(),
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
        closed_provider_local_port(),
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
