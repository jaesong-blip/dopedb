//! Scope-pinned authorization, single-flight pool creation, and managed-lease
//! retirement shared by UI, introspection, and agent transports.
//!
//! A connection UUID alone is never a cache identity. Every entry is keyed by the
//! exact workspace/account selection plus connection and binding revisions. A
//! `ConnectionLease` retains the scope read gate for the operation lifetime so the
//! current adapters cannot switch scope and then write history/cache into a different
//! account while their scoped-write APIs are being extracted.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use dashmap::DashMap;
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use tokio::time::Instant;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::workspaces::{Workspace, WorkspaceAuthUser, WorkspaceRole};
use crate::kernel::identity::{
    AccountId, ConnectionId, DashboardId, ProviderBindingId, WorkspaceId,
};
use crate::model::{ConnectionProfile, Engine, WorkspaceCredentialMode};
use crate::store::{PinnedConnection, PinnedDashboard, Store};

use super::remote_authority::RemoteConnectionAuthorityPort;
use super::Live;
use super::{ProviderLocalBindingPin, ProviderLocalConnectionPort, ProviderLocalTarget};

mod authority;
mod cache;
use authority::{
    authorize_pin, connect_authorized, opened_provider_target_expiry_shrank,
    provider_target_expiry_shrank, retire_opened, scope_changed, ConnectionAuthorization,
    OpenedLive,
};
use cache::{
    cache_entry_expired, retire_entries, schedule_expiry, CacheEntry, ConnectionCacheKey,
    ConnectionSlot,
};

const MANAGED_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TARGET_DATABASE_BYTES: usize = 255;

fn resolve_target_database(
    profile: &ConnectionProfile,
    requested: Option<&str>,
    authorization: &ConnectionAuthorization,
) -> AppResult<String> {
    let database = requested.unwrap_or(&profile.database);
    if database.is_empty()
        || database.len() > MAX_TARGET_DATABASE_BYTES
        || database.chars().any(char::is_control)
    {
        return Err(AppError::Config(
            "target database name is empty or invalid".into(),
        ));
    }
    if profile.engine == Engine::Sqlite && database != profile.database {
        return Err(AppError::Blocked {
            reason: "SQLite connections are bound to one database file".into(),
        });
    }
    if database != profile.database
        && (profile.credential_mode == WorkspaceCredentialMode::Managed
            || authorization.provider_local_target.is_some())
    {
        return Err(AppError::Blocked {
            reason: "this credential authority is bound to the connection's configured database"
                .into(),
        });
    }
    Ok(database.to_owned())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ConnectionAccess {
    Read,
    Write,
}

#[derive(Clone)]
pub(super) struct ManagedLeaseHandle {
    authority: Arc<dyn RemoteConnectionAuthorityPort>,
    account_id: AccountId,
    workspace_id: WorkspaceId,
    connection_id: ConnectionId,
    lease_id: Uuid,
}

impl ManagedLeaseHandle {
    pub(super) async fn release(self) {
        if let Err(error) = self
            .authority
            .release_managed_lease(
                &self.account_id,
                self.workspace_id,
                self.connection_id,
                self.lease_id,
            )
            .await
        {
            tracing::warn!(
                connection_id = %self.connection_id,
                %error,
                "managed database access release deferred until provider expiry"
            );
        }
    }
}

pub(super) async fn release_managed_bounded(lease: ManagedLeaseHandle) {
    let connection_id = lease.connection_id;
    if tokio::time::timeout(MANAGED_RELEASE_TIMEOUT, lease.release())
        .await
        .is_err()
    {
        tracing::warn!(
            %connection_id,
            "managed database access release timed out; provider expiry remains authoritative"
        );
    }
}

struct ConnectionManagerInner {
    store: Store,
    remote_authority: Arc<dyn RemoteConnectionAuthorityPort>,
    provider_local: Arc<dyn ProviderLocalConnectionPort>,
    scope_gate: Arc<RwLock<()>>,
    session_gate: Arc<RwLock<()>>,
    session_revocation_ports: StdMutex<Vec<Weak<dyn ConnectionSessionRevocationPort>>>,
    profile_mutation_gates: DashMap<Uuid, Arc<Mutex<()>>>,
    slots: DashMap<ConnectionCacheKey, Arc<Mutex<ConnectionSlot>>>,
    next_generation: AtomicU64,
    provider_binding_fence_epoch: AtomicU64,
}

/// Process-local owner of every database pool. Clones share the same slots and scope
/// gate, including the instances used by the local broker.
#[derive(Clone)]
pub(crate) struct ConnectionManager {
    inner: Arc<ConnectionManagerInner>,
}

/// An online-authorized connection identity without a database pool. Catalog
/// cache-first reads use this so RBAC is checked before a cache hit without opening
/// an unnecessary target connection.
pub(crate) struct ConnectionContext {
    manager: ConnectionManager,
    pin: PinnedConnection,
    access: ConnectionAccess,
    authorization: ConnectionAuthorization,
    provider_binding_fence_epoch: u64,
    scope_guard: Option<OwnedRwLockReadGuard<()>>,
}

/// A pool and its exact local authority snapshot. This type is intentionally not
/// Clone: adapters retain one lease for the complete operation.
pub(crate) struct ConnectionLease {
    pin: PinnedConnection,
    target_database: String,
    entry: Arc<CacheEntry>,
    _scope_guard: OwnedRwLockReadGuard<()>,
}

/// Local operation boundary used before a database pool is needed. It freezes the
/// active workspace/account while commands classify input, evaluate gates, and write
/// scoped artifacts, without issuing an unnecessary remote authorization request.
pub(crate) struct ConnectionOperationScope {
    manager: ConnectionManager,
    _scope_guard: OwnedRwLockReadGuard<()>,
    _profile_mutation_guard: Option<OwnedMutexGuard<()>>,
    _session_mutation_guard: Option<OwnedRwLockWriteGuard<()>>,
}

/// Admission fence for a long-lived connection session. Scope mutations take the
/// matching writer gate, revoke registered sessions, and only then wait for the
/// ordinary connection scope writer.
pub(crate) struct ConnectionSessionAdmission {
    operation_scope: ConnectionOperationScope,
    admission_guard: OwnedRwLockReadGuard<()>,
}

/// A newly connected long-lived session whose admission fence remains held until
/// the owner has published it in its revocation registry.
pub(crate) struct ConnectionSessionLeaseStart {
    lease: ConnectionLease,
    _admission_guard: OwnedRwLockReadGuard<()>,
}

/// Runtime callback used to end long-lived sessions before connection/workspace
/// authority changes. Implementations must always release their connection leases,
/// closing a poisoned physical connection when rollback cannot be acknowledged.
pub(crate) trait ConnectionSessionRevocationPort: Send + Sync + 'static {
    fn revoke<'a>(
        &'a self,
        connection_id: Option<Uuid>,
        reason: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

/// Exclusive keychain/material mutation boundary. Existing operations drain before
/// this is created, and no new scope pins can begin until it is released.
pub(crate) struct ConnectionMutation {
    manager: ConnectionManager,
    pin: Option<PinnedConnection>,
    scope_guard: Option<OwnedRwLockWriteGuard<()>>,
    _session_mutation_guard: Option<OwnedRwLockWriteGuard<()>>,
}

impl ConnectionLease {
    pub(crate) fn live(&self) -> &Live {
        &self.entry.live
    }

    pub(crate) fn pin(&self) -> &PinnedConnection {
        &self.pin
    }

    pub(crate) fn target_database(&self) -> &str {
        &self.target_database
    }
}

impl ConnectionSessionLeaseStart {
    pub(crate) fn live(&self) -> &Live {
        self.lease.live()
    }

    pub(crate) fn target_database(&self) -> &str {
        self.lease.target_database()
    }

    pub(crate) fn into_lease(self) -> ConnectionLease {
        self.lease
    }
}

impl ConnectionSessionAdmission {
    pub(crate) async fn pin_connection(&self, id: Uuid) -> AppResult<PinnedConnection> {
        self.operation_scope.pin_connection(id).await
    }

    pub(crate) async fn connect_to_database(
        self,
        pin: PinnedConnection,
        access: ConnectionAccess,
        database: Option<String>,
    ) -> AppResult<ConnectionSessionLeaseStart> {
        let Self {
            operation_scope,
            admission_guard,
        } = self;
        let lease = operation_scope
            .connect_to_database(pin, access, database)
            .await?;
        Ok(ConnectionSessionLeaseStart {
            lease,
            _admission_guard: admission_guard,
        })
    }
}

impl ConnectionOperationScope {
    pub(crate) async fn pin_connection(&self, id: Uuid) -> AppResult<PinnedConnection> {
        self.manager.inner.store.pin_connection_for_read(id).await
    }

    /// Pin connection metadata for local inspection without granting target-database
    /// execution. Read/Write authorization still happens if the scope is connected.
    pub(crate) async fn pin_connection_for_view(&self, id: Uuid) -> AppResult<PinnedConnection> {
        self.manager.inner.store.pin_connection_for_view(id).await
    }

    pub(crate) async fn pin_dashboard_connection(&self, id: Uuid) -> AppResult<PinnedConnection> {
        self.pin_connection_for_view(id).await
    }

    pub(crate) async fn pin_dashboard(&self, id: DashboardId) -> AppResult<PinnedDashboard> {
        self.manager.inner.store.pin_dashboard_for_view(id).await
    }

    /// Upgrade this operation boundary into a live connection without reacquiring
    /// the writer-preferred scope lock. Re-entering `ConnectionManager::pin` while
    /// this scope owns a read guard can deadlock behind a queued mutation.
    pub(crate) async fn connect(
        self,
        pin: PinnedConnection,
        access: ConnectionAccess,
    ) -> AppResult<ConnectionLease> {
        self.connect_to_database(pin, access, None).await
    }

    pub(crate) async fn connect_to_database(
        self,
        pin: PinnedConnection,
        access: ConnectionAccess,
        database: Option<String>,
    ) -> AppResult<ConnectionLease> {
        let authorization = authorize_pin(
            self.manager.inner.remote_authority.as_ref(),
            self.manager.inner.provider_local.as_ref(),
            &pin,
            access,
        )
        .await?;
        if !self.manager.pin_is_current(&pin).await? {
            return Err(scope_changed());
        }
        let provider_binding_fence_epoch = self.manager.provider_binding_fence_epoch();
        let Self {
            manager,
            _scope_guard,
            _profile_mutation_guard: _,
            _session_mutation_guard: _,
        } = self;
        ConnectionContext {
            manager,
            pin,
            access,
            authorization,
            provider_binding_fence_epoch,
            scope_guard: Some(_scope_guard),
        }
        .connect_to_database(database)
        .await
    }

    /// Publish a connection-local profile change without draining unrelated
    /// database reads. The scope guard keeps the workspace/account fixed while
    /// the caller persists the new generation and detaches old pools. Reads
    /// that already hold the previous generation may finish; later admissions
    /// fail the generation check or open against the replacement profile.
    pub(crate) async fn retire_connection(self, connection_id: Uuid) {
        let keys = self
            .manager
            .inner
            .slots
            .iter()
            .filter(|entry| entry.key().connection_id == connection_id)
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        let retired = self.manager.detach_keys(keys).await;
        drop(self);
        retire_entries(retired).await;
    }
}

impl ConnectionMutation {
    pub(crate) fn pin(&self) -> &PinnedConnection {
        self.pin
            .as_ref()
            .expect("connection mutation was created with an authority pin")
    }

    /// Publish a successful material change by detaching every cached pool for the
    /// resource before allowing new acquisitions.
    pub(crate) async fn retire_connection(self, connection_id: Uuid) {
        self.retire_connections(&[connection_id]).await;
    }

    /// Atomically publish a successful batch mutation while the exclusive scope
    /// gate keeps waiters from retaining a slot that is about to be detached.
    pub(crate) async fn retire_connections(mut self, connection_ids: &[Uuid]) {
        let keys = self
            .manager
            .inner
            .slots
            .iter()
            .filter(|entry| connection_ids.contains(&entry.key().connection_id))
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        let retired = self.manager.detach_keys(keys).await;
        self.scope_guard.take();
        drop(self);
        retire_entries(retired).await;
    }
}

impl ConnectionContext {
    pub(crate) fn pin(&self) -> &PinnedConnection {
        &self.pin
    }

    pub(crate) async fn connect(self) -> AppResult<ConnectionLease> {
        self.connect_to_database(None).await
    }

    /// Open the same authorized server identity against one selected database.
    ///
    /// The durable profile, workspace/account pin, credential binding, and RBAC
    /// generation remain authoritative. Only the target database varies, and it is
    /// part of the pool cache identity so a lease can never receive a pool opened for
    /// another database.
    pub(crate) async fn connect_to_database(
        mut self,
        database: Option<String>,
    ) -> AppResult<ConnectionLease> {
        let target_database =
            resolve_target_database(&self.pin.profile, database.as_deref(), &self.authorization)?;
        let mut target_profile = self.pin.profile.clone();
        target_profile.database.clone_from(&target_database);
        'reopen: loop {
            if self.provider_binding_fence_epoch != self.manager.provider_binding_fence_epoch() {
                self.authorization = authorize_pin(
                    self.manager.inner.remote_authority.as_ref(),
                    self.manager.inner.provider_local.as_ref(),
                    &self.pin,
                    self.access,
                )
                .await?;
                self.provider_binding_fence_epoch = self.manager.provider_binding_fence_epoch();
                // A fence may have raced the reauthorization. Restart rather
                // than hand an old binding identity to cache admission.
                if self.provider_binding_fence_epoch != self.manager.provider_binding_fence_epoch()
                {
                    continue;
                }
            }
            let key = ConnectionCacheKey::new(
                &self.pin,
                self.access,
                self.authorization.provider_local_target.as_ref(),
                self.authorization.provider_local_pin.as_ref(),
                &target_database,
            );
            let slot = self
                .manager
                .inner
                .slots
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(ConnectionSlot::default())))
                .clone();

            loop {
                let mut state = slot.lock().await;
                if let Some(entry) = state.entry.as_ref() {
                    let is_expired = cache_entry_expired(entry);
                    if !is_expired {
                        let entry = Arc::clone(entry);
                        drop(state);
                        // `pin` authorized before potentially waiting on this slot. A
                        // revoke can occur while another task opens the pool, so authorize
                        // again at the exact cache-use boundary.
                        if self.pin.requires_remote_rbac {
                            let refreshed = match authorize_pin(
                                self.manager.inner.remote_authority.as_ref(),
                                self.manager.inner.provider_local.as_ref(),
                                &self.pin,
                                self.access,
                            )
                            .await
                            {
                                Ok(refreshed) => refreshed,
                                Err(error) => {
                                    // A provider-local revocation or pin failure is a cache
                                    // revocation, not merely a failed request. Detach before
                                    // returning so no later caller can receive this pool.
                                    drop(entry);
                                    let retired = self.manager.detach_keys(vec![key.clone()]).await;
                                    retire_entries(retired).await;
                                    return Err(error);
                                }
                            };
                            if ConnectionCacheKey::new(
                                &self.pin,
                                self.access,
                                refreshed.provider_local_target.as_ref(),
                                refreshed.provider_local_pin.as_ref(),
                                &target_database,
                            ) != key
                            {
                                drop(entry);
                                let retired = self.manager.detach_keys(vec![key.clone()]).await;
                                retire_entries(retired).await;
                                self.authorization = refreshed;
                                continue 'reopen;
                            }
                            if provider_target_expiry_shrank(
                                &entry,
                                refreshed.provider_local_target.as_ref(),
                            )? {
                                let retired = {
                                    let mut state = slot.lock().await;
                                    if state
                                        .entry
                                        .as_ref()
                                        .is_some_and(|current| Arc::ptr_eq(current, &entry))
                                    {
                                        state.entry.take()
                                    } else {
                                        None
                                    }
                                };
                                drop(entry);
                                if let Some(retired) = retired {
                                    retire_entries(vec![retired]).await;
                                }
                                self.authorization = refreshed;
                                continue 'reopen;
                            }
                            self.authorization = refreshed;
                            self.provider_binding_fence_epoch =
                                self.manager.provider_binding_fence_epoch();
                        }
                        if !self.manager.pin_is_current(&self.pin).await? {
                            return Err(scope_changed());
                        }
                        if self.provider_binding_fence_epoch
                            != self.manager.provider_binding_fence_epoch()
                        {
                            drop(entry);
                            continue 'reopen;
                        }
                        // Online authorization can outlive the retirement timer. Check
                        // again at the exact hand-off boundary and detach only this
                        // generation; never return a lease whose safety margin elapsed.
                        if cache_entry_expired(&entry) {
                            let retired = {
                                let mut state = slot.lock().await;
                                if state
                                    .entry
                                    .as_ref()
                                    .is_some_and(|current| Arc::ptr_eq(current, &entry))
                                {
                                    state.entry.take()
                                } else {
                                    None
                                }
                            };
                            drop(entry);
                            if let Some(retired) = retired {
                                retire_entries(vec![retired]).await;
                            }
                            continue;
                        }
                        // A cache hit releases the slot while it reauthorizes. Another
                        // caller can revoke or rotate this exact generation during that
                        // await, detach it, and leave us holding the last Arc. Reacquire
                        // the original slot at the final linearization point: only the
                        // still-mapped Arc with the same immutable generation may escape
                        // as a lease. This also prevents an ABA replacement under `key`.
                        let entry_generation = entry.generation;
                        let is_current_handoff = {
                            let state = slot.lock().await;
                            state.entry.as_ref().is_some_and(|current| {
                                Arc::ptr_eq(current, &entry)
                                    && current.generation == entry_generation
                                    && !cache_entry_expired(current)
                                    && self.provider_binding_fence_epoch
                                        == self.manager.provider_binding_fence_epoch()
                            })
                        };
                        if !is_current_handoff {
                            drop(entry);
                            continue 'reopen;
                        }
                        return Ok(ConnectionLease {
                            pin: self.pin,
                            target_database,
                            entry,
                            _scope_guard: self
                                .scope_guard
                                .take()
                                .expect("connection context owns one scope guard"),
                        });
                    }
                }

                let expired = state.entry.take();
                if expired.is_some() {
                    drop(state);
                    retire_entries(expired.into_iter().collect()).await;
                    continue;
                }

                let opened = connect_authorized(
                    Arc::clone(&self.manager.inner.remote_authority),
                    Arc::clone(&self.manager.inner.provider_local),
                    &target_profile,
                    &self.authorization,
                    self.access,
                )
                .await;
                let opened = match opened {
                    Ok(opened) => opened,
                    Err(error) => {
                        drop(state);
                        return Err(error);
                    }
                };
                if self.pin.requires_remote_rbac {
                    let reauthorized = match authorize_pin(
                        self.manager.inner.remote_authority.as_ref(),
                        self.manager.inner.provider_local.as_ref(),
                        &self.pin,
                        self.access,
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(error) => {
                            drop(state);
                            retire_opened(opened).await;
                            return Err(error);
                        }
                    };
                    if ConnectionCacheKey::new(
                        &self.pin,
                        self.access,
                        reauthorized.provider_local_target.as_ref(),
                        reauthorized.provider_local_pin.as_ref(),
                        &target_database,
                    ) != key
                    {
                        drop(state);
                        retire_opened(opened).await;
                        self.authorization = reauthorized;
                        continue 'reopen;
                    }
                    if opened_provider_target_expiry_shrank(
                        &opened,
                        reauthorized.provider_local_target.as_ref(),
                    )? {
                        drop(state);
                        retire_opened(opened).await;
                        self.authorization = reauthorized;
                        continue 'reopen;
                    }
                    self.authorization = reauthorized;
                    self.provider_binding_fence_epoch = self.manager.provider_binding_fence_epoch();
                }
                match self.manager.pin_is_current(&self.pin).await {
                    Ok(true) => {}
                    Ok(false) => {
                        drop(state);
                        retire_opened(opened).await;
                        return Err(scope_changed());
                    }
                    Err(error) => {
                        drop(state);
                        retire_opened(opened).await;
                        return Err(error);
                    }
                }

                let generation = self
                    .manager
                    .inner
                    .next_generation
                    .fetch_add(1, Ordering::Relaxed);
                if self.provider_binding_fence_epoch != self.manager.provider_binding_fence_epoch()
                {
                    drop(state);
                    retire_opened(opened).await;
                    continue 'reopen;
                }
                if opened
                    .retire_at
                    .is_some_and(|retire_at| retire_at <= Instant::now())
                {
                    drop(state);
                    retire_opened(opened).await;
                    return Err(AppError::Network(
                        "managed database access expired while opening the connection".into(),
                    ));
                }
                let OpenedLive {
                    live,
                    retire_at,
                    managed_lease,
                    ssh_tunnel,
                } = opened;
                let entry = Arc::new(CacheEntry {
                    live,
                    generation,
                    retire_at,
                    managed_lease: StdMutex::new(managed_lease),
                    ssh_tunnel: StdMutex::new(ssh_tunnel),
                    closed: AtomicBool::new(false),
                });
                state.entry = Some(Arc::clone(&entry));
                drop(state);
                if let Some(retire_at) = retire_at {
                    schedule_expiry(
                        slot,
                        generation,
                        retire_at.saturating_duration_since(Instant::now()),
                    );
                }
                return Ok(ConnectionLease {
                    pin: self.pin,
                    target_database,
                    entry,
                    _scope_guard: self
                        .scope_guard
                        .take()
                        .expect("connection context owns one scope guard"),
                });
            }
        }
    }

    /// Open and close an uncached pool while retaining the exact scope pin for the
    /// complete reachability check. Connection-form tests intentionally do not warm
    /// the shared pool cache.
    pub(crate) async fn test_fresh(self) -> AppResult<()> {
        let opened = connect_authorized(
            Arc::clone(&self.manager.inner.remote_authority),
            Arc::clone(&self.manager.inner.provider_local),
            &self.pin.profile,
            &self.authorization,
            self.access,
        )
        .await?;
        if self.pin.requires_remote_rbac {
            let refreshed = match authorize_pin(
                self.manager.inner.remote_authority.as_ref(),
                self.manager.inner.provider_local.as_ref(),
                &self.pin,
                self.access,
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    retire_opened(opened).await;
                    return Err(error);
                }
            };
            if ConnectionCacheKey::new(
                &self.pin,
                self.access,
                self.authorization.provider_local_target.as_ref(),
                self.authorization.provider_local_pin.as_ref(),
                &self.pin.profile.database,
            ) != ConnectionCacheKey::new(
                &self.pin,
                self.access,
                refreshed.provider_local_target.as_ref(),
                refreshed.provider_local_pin.as_ref(),
                &self.pin.profile.database,
            ) || opened_provider_target_expiry_shrank(
                &opened,
                refreshed.provider_local_target.as_ref(),
            )? {
                retire_opened(opened).await;
                return Err(scope_changed());
            }
        }
        let pin_is_current = match self.manager.pin_is_current(&self.pin).await {
            Ok(current) => current,
            Err(error) => {
                retire_opened(opened).await;
                return Err(error);
            }
        };
        if !pin_is_current
            || opened
                .retire_at
                .is_some_and(|retire_at| retire_at <= Instant::now())
        {
            retire_opened(opened).await;
            return Err(scope_changed());
        }
        let result = opened.live.test().await;
        retire_opened(opened).await;
        result
    }
}

impl ConnectionManager {
    pub(crate) fn with_authorities(
        store: Store,
        remote_authority: Arc<dyn RemoteConnectionAuthorityPort>,
        provider_local: Arc<dyn ProviderLocalConnectionPort>,
    ) -> Self {
        Self {
            inner: Arc::new(ConnectionManagerInner {
                store,
                remote_authority,
                provider_local,
                scope_gate: Arc::new(RwLock::new(())),
                session_gate: Arc::new(RwLock::new(())),
                session_revocation_ports: StdMutex::new(Vec::new()),
                profile_mutation_gates: DashMap::new(),
                slots: DashMap::new(),
                next_generation: AtomicU64::new(1),
                provider_binding_fence_epoch: AtomicU64::new(1),
            }),
        }
    }

    async fn pin_is_current(&self, pin: &PinnedConnection) -> AppResult<bool> {
        self.inner.store.is_pin_current(pin).await
    }

    fn provider_binding_fence_epoch(&self) -> u64 {
        self.inner
            .provider_binding_fence_epoch
            .load(Ordering::Acquire)
    }

    pub(crate) fn register_session_revocation_port(
        &self,
        port: Arc<dyn ConnectionSessionRevocationPort>,
    ) {
        self.inner
            .session_revocation_ports
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Arc::downgrade(&port));
    }

    async fn revoke_sessions(&self, connection_id: Option<Uuid>, reason: &'static str) {
        let ports = {
            let mut ports = self
                .inner
                .session_revocation_ports
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let live = ports.iter().filter_map(Weak::upgrade).collect::<Vec<_>>();
            ports.retain(|port| port.strong_count() > 0);
            live
        };
        for port in ports {
            port.revoke(connection_id, reason).await;
        }
    }

    /// Fence every live cache entry carrying this exact durable binding id.
    /// This deliberately does not wait on `scope_gate`: active leases hold a
    /// scope read guard, while revocation must close their pool immediately.
    pub(crate) async fn force_fence_provider_binding(&self, binding_id: ProviderBindingId) {
        let _session_gate = self.inner.session_gate.write().await;
        self.revoke_sessions(None, "provider credential binding revoked")
            .await;
        self.inner
            .provider_binding_fence_epoch
            .fetch_add(1, Ordering::AcqRel);
        let binding_id = Uuid::from(binding_id);
        let slots = self
            .inner
            .slots
            .iter()
            .filter(|entry| entry.key().provider_binding_id == Some(binding_id))
            .map(|entry| Arc::clone(entry.value()))
            .collect::<Vec<_>>();
        let mut entries = Vec::new();
        for slot in slots {
            if let Some(entry) = slot.lock().await.entry.take() {
                entries.push(entry);
            }
        }
        for entry in entries {
            entry.force_close_and_release().await;
        }
    }

    pub(crate) async fn pin(
        &self,
        id: Uuid,
        access: ConnectionAccess,
    ) -> AppResult<ConnectionContext> {
        let scope_guard = Arc::clone(&self.inner.scope_gate).read_owned().await;
        let pin = self.inner.store.pin_connection_for_read(id).await?;
        let authorization = authorize_pin(
            self.inner.remote_authority.as_ref(),
            self.inner.provider_local.as_ref(),
            &pin,
            access,
        )
        .await?;
        if !self.pin_is_current(&pin).await? {
            return Err(scope_changed());
        }
        Ok(ConnectionContext {
            manager: self.clone(),
            pin,
            access,
            authorization,
            provider_binding_fence_epoch: self.provider_binding_fence_epoch(),
            scope_guard: Some(scope_guard),
        })
    }

    pub(crate) async fn begin_operation_scope(&self) -> ConnectionOperationScope {
        ConnectionOperationScope {
            manager: self.clone(),
            _scope_guard: Arc::clone(&self.inner.scope_gate).read_owned().await,
            _profile_mutation_guard: None,
            _session_mutation_guard: None,
        }
    }

    pub(crate) async fn begin_profile_mutation(
        &self,
        connection_id: Uuid,
    ) -> ConnectionOperationScope {
        let session_mutation_guard = Arc::clone(&self.inner.session_gate).write_owned().await;
        self.revoke_sessions(Some(connection_id), "connection profile changed")
            .await;
        let scope_guard = Arc::clone(&self.inner.scope_gate).read_owned().await;
        let mutation_gate = Arc::clone(
            self.inner
                .profile_mutation_gates
                .entry(connection_id)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .value(),
        );
        ConnectionOperationScope {
            manager: self.clone(),
            _scope_guard: scope_guard,
            _profile_mutation_guard: Some(mutation_gate.lock_owned().await),
            _session_mutation_guard: Some(session_mutation_guard),
        }
    }

    pub(crate) async fn begin_session_admission(&self) -> ConnectionSessionAdmission {
        let admission_guard = Arc::clone(&self.inner.session_gate).read_owned().await;
        ConnectionSessionAdmission {
            operation_scope: self.begin_operation_scope().await,
            admission_guard,
        }
    }

    pub(crate) async fn begin_scope_mutation(&self) -> ConnectionMutation {
        let session_mutation_guard = Arc::clone(&self.inner.session_gate).write_owned().await;
        self.revoke_sessions(None, "connection scope changed").await;
        ConnectionMutation {
            manager: self.clone(),
            pin: None,
            scope_guard: Some(Arc::clone(&self.inner.scope_gate).write_owned().await),
            _session_mutation_guard: Some(session_mutation_guard),
        }
    }

    pub(crate) async fn begin_connection_mutation(
        &self,
        id: Uuid,
        access: ConnectionAccess,
    ) -> AppResult<ConnectionMutation> {
        let session_mutation_guard = Arc::clone(&self.inner.session_gate).write_owned().await;
        self.revoke_sessions(Some(id), "connection authority changed")
            .await;
        let scope_guard = Arc::clone(&self.inner.scope_gate).write_owned().await;
        let pin = self.inner.store.pin_connection_for_read(id).await?;
        authorize_pin(
            self.inner.remote_authority.as_ref(),
            self.inner.provider_local.as_ref(),
            &pin,
            access,
        )
        .await?;
        if !self.pin_is_current(&pin).await? {
            return Err(scope_changed());
        }
        Ok(ConnectionMutation {
            manager: self.clone(),
            pin: Some(pin),
            scope_guard: Some(scope_guard),
            _session_mutation_guard: Some(session_mutation_guard),
        })
    }

    pub(crate) async fn activate_workspace(
        &self,
        id: Uuid,
        account_user_id: Option<&str>,
    ) -> AppResult<Workspace> {
        let _session_gate = self.inner.session_gate.write().await;
        self.revoke_sessions(None, "workspace changed").await;
        let _gate = self.inner.scope_gate.write().await;
        let workspace = self
            .inner
            .store
            .activate_workspace(id, account_user_id)
            .await?;
        let retired = self.detach_all().await;
        drop(_gate);
        retire_entries(retired).await;
        Ok(workspace)
    }

    pub(crate) async fn activate_workspace_account(&self, user_id: &str) -> AppResult<Workspace> {
        let _session_gate = self.inner.session_gate.write().await;
        self.revoke_sessions(None, "workspace account changed")
            .await;
        let _gate = self.inner.scope_gate.write().await;
        let workspace = self.inner.store.activate_workspace_account(user_id).await?;
        let retired = self.detach_all().await;
        drop(_gate);
        retire_entries(retired).await;
        Ok(workspace)
    }

    pub(crate) async fn remove_workspace_account(&self, user_id: &str) -> AppResult<()> {
        let _session_gate = self.inner.session_gate.write().await;
        self.revoke_sessions(None, "workspace account removed")
            .await;
        let _gate = self.inner.scope_gate.write().await;
        self.inner.store.remove_workspace_account(user_id).await?;
        let retired = self.detach_all().await;
        drop(_gate);
        retire_entries(retired).await;
        Ok(())
    }

    pub(crate) async fn sync_account_workspaces(
        &self,
        user: &WorkspaceAuthUser,
        workspaces: &[(Uuid, String, WorkspaceRole)],
    ) -> AppResult<()> {
        let _session_gate = self.inner.session_gate.write().await;
        self.revoke_sessions(None, "workspace memberships changed")
            .await;
        let _gate = self.inner.scope_gate.write().await;
        self.inner
            .store
            .sync_account_workspaces(user, workspaces)
            .await?;
        let retired = self.detach_all().await;
        drop(_gate);
        retire_entries(retired).await;
        Ok(())
    }

    /// Reconcile control-plane connection templates while excluding concurrent
    /// scope-pinned operations. Any material or binding revision change gets a fresh
    /// pool on the next acquisition.
    pub(crate) async fn sync_remote_connections(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        connections: &[(ConnectionProfile, i64)],
    ) -> AppResult<Vec<Uuid>> {
        let _session_gate = self.inner.session_gate.write().await;
        self.revoke_sessions(None, "workspace connections changed")
            .await;
        let gate = self.inner.scope_gate.write().await;
        let removed_credential_ids = self
            .inner
            .store
            .sync_remote_connections(workspace_id, account_user_id, connections)
            .await?;
        let retired = self.detach_all().await;
        drop(gate);
        retire_entries(retired).await;
        Ok(removed_credential_ids)
    }

    async fn detach_all(&self) -> Vec<Arc<CacheEntry>> {
        let keys = self
            .inner
            .slots
            .iter()
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        self.detach_keys(keys).await
    }

    async fn detach_keys(&self, keys: Vec<ConnectionCacheKey>) -> Vec<Arc<CacheEntry>> {
        let mut retired = Vec::new();
        for key in keys {
            if let Some((_, slot)) = self.inner.slots.remove(&key) {
                if let Some(entry) = slot.lock().await.entry.take() {
                    retired.push(entry);
                }
            }
        }
        retired
    }
}

impl crate::features::providers::ports::ProviderBindingRevocationPort for ConnectionManager {
    fn force_fence<'a>(
        &'a self,
        binding_id: ProviderBindingId,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
        Box::pin(async move {
            self.force_fence_provider_binding(binding_id).await;
            Ok(())
        })
    }
}
