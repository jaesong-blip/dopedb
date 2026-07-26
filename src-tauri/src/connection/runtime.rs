//! Scope-pinned authorization, single-flight pool creation, and managed-lease
//! retirement shared by UI, introspection, and agent transports.
//!
//! A connection UUID alone is never a cache identity. Every entry is keyed by the
//! exact workspace/account selection plus connection and binding revisions. A
//! `ConnectionLease` retains the scope read gate for the operation lifetime so the
//! current adapters cannot switch scope and then write history/cache into a different
//! account while their scoped-write APIs are being extracted.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use dashmap::DashMap;
use futures::future::join_all;
use tokio::sync::{Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use tokio::time::Instant;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::features::workspaces::{Workspace, WorkspaceAuthUser, WorkspaceRole};
use crate::kernel::identity::{AccountId, ConnectionId, DashboardId, WorkspaceId};
use crate::kernel::sync::lock_unpoisoned;
use crate::model::{ConnectionProfile, WorkspaceCredentialMode};
use crate::store::{AccountScope, PinnedConnection, PinnedDashboard, Store};

#[cfg(test)]
use super::remote_authority::closed_authority;
use super::remote_authority::RemoteConnectionAuthorityPort;
use super::Live;

const MANAGED_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ConnectionAccess {
    Read,
    Write,
}

struct ConnectionAuthorization {
    user_id: Option<String>,
    workspace_id: Option<Uuid>,
}

struct OpenedLive {
    pub live: Live,
    retire_at: Option<Instant>,
    managed_lease: Option<ManagedLeaseHandle>,
}

#[derive(Clone)]
struct ManagedLeaseHandle {
    authority: Arc<dyn RemoteConnectionAuthorityPort>,
    account_id: AccountId,
    workspace_id: WorkspaceId,
    connection_id: ConnectionId,
    lease_id: Uuid,
}

impl ManagedLeaseHandle {
    async fn release(self) {
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

async fn release_managed_bounded(lease: ManagedLeaseHandle) {
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ConnectionCacheKey {
    workspace_id: Uuid,
    account_scope: AccountScope,
    scope_generation: i64,
    connection_id: Uuid,
    connection_revision: i64,
    binding_revision: i64,
    binding_updated_at: String,
    access: ConnectionAccess,
}

impl ConnectionCacheKey {
    fn new(pin: &PinnedConnection, access: ConnectionAccess) -> Self {
        Self {
            workspace_id: pin.scope.workspace_id,
            account_scope: pin.scope.account_scope.clone(),
            scope_generation: pin.scope.generation,
            connection_id: pin.connection_id,
            connection_revision: pin.connection_revision,
            binding_revision: pin.binding_revision,
            binding_updated_at: pin.binding_updated_at.clone(),
            // A read entry is constructed without a write-capable pool. It therefore
            // can never satisfy a later write request, even for local credentials.
            access,
        }
    }
}

struct CacheEntry {
    live: Live,
    generation: u64,
    retire_at: Option<Instant>,
    managed_lease: StdMutex<Option<ManagedLeaseHandle>>,
    closed: AtomicBool,
}

impl CacheEntry {
    fn take_managed_lease(&self) -> Option<ManagedLeaseHandle> {
        lock_unpoisoned(&self.managed_lease).take()
    }

    async fn close_once(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.live.close().await;
        }
    }
}

impl Drop for CacheEntry {
    fn drop(&mut self) {
        let should_close = !self.closed.swap(true, Ordering::AcqRel);
        let live = should_close.then(|| self.live.clone());
        let managed_lease = self.take_managed_lease();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            if let Some(live) = live {
                runtime.spawn(async move { live.close().await });
            }
            if let Some(managed_lease) = managed_lease {
                runtime.spawn(release_managed_bounded(managed_lease));
            }
        }
    }
}

#[derive(Default)]
struct ConnectionSlot {
    // Empty slots deliberately remain mapped. Removing a slot after releasing this
    // mutex can orphan a waiter that has already cloned the Arc and let a second slot
    // open a duplicate pool for the same authority key.
    entry: Option<Arc<CacheEntry>>,
}

struct ConnectionManagerInner {
    store: Store,
    remote_authority: Arc<dyn RemoteConnectionAuthorityPort>,
    scope_gate: Arc<RwLock<()>>,
    slots: DashMap<ConnectionCacheKey, Arc<Mutex<ConnectionSlot>>>,
    next_generation: AtomicU64,
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
    scope_guard: Option<OwnedRwLockReadGuard<()>>,
}

/// A pool and its exact local authority snapshot. This type is intentionally not
/// Clone: adapters retain one lease for the complete operation.
pub(crate) struct ConnectionLease {
    pin: PinnedConnection,
    entry: Arc<CacheEntry>,
    _scope_guard: OwnedRwLockReadGuard<()>,
}

/// Local operation boundary used before a database pool is needed. It freezes the
/// active workspace/account while commands classify input, evaluate gates, and write
/// scoped artifacts, without issuing an unnecessary remote authorization request.
pub(crate) struct ConnectionOperationScope {
    manager: ConnectionManager,
    _scope_guard: OwnedRwLockReadGuard<()>,
}

/// Exclusive keychain/material mutation boundary. Existing operations drain before
/// this is created, and no new scope pins can begin until it is released.
pub(crate) struct ConnectionMutation {
    manager: ConnectionManager,
    pin: Option<PinnedConnection>,
    scope_guard: Option<OwnedRwLockWriteGuard<()>>,
}

impl ConnectionLease {
    pub(crate) fn live(&self) -> &Live {
        &self.entry.live
    }

    pub(crate) fn pin(&self) -> &PinnedConnection {
        &self.pin
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
    /// the writer-preferred scope lock. Re-entering `ConnectionManager::acquire`
    /// while this scope owns a read guard can deadlock behind a queued mutation.
    pub(crate) async fn connect(
        self,
        pin: PinnedConnection,
        access: ConnectionAccess,
    ) -> AppResult<ConnectionLease> {
        let authorization =
            authorize_pin(self.manager.inner.remote_authority.as_ref(), &pin, access).await?;
        if !self.manager.inner.store.is_pin_current(&pin).await? {
            return Err(scope_changed());
        }
        let Self {
            manager,
            _scope_guard,
        } = self;
        ConnectionContext {
            manager,
            pin,
            access,
            authorization,
            scope_guard: Some(_scope_guard),
        }
        .connect()
        .await
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

    pub(crate) async fn connect(mut self) -> AppResult<ConnectionLease> {
        let key = ConnectionCacheKey::new(&self.pin, self.access);
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
                        authorize_pin(
                            self.manager.inner.remote_authority.as_ref(),
                            &self.pin,
                            self.access,
                        )
                        .await?;
                    }
                    if !self.manager.inner.store.is_pin_current(&self.pin).await? {
                        return Err(scope_changed());
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
                    return Ok(ConnectionLease {
                        pin: self.pin,
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
                &self.pin.profile,
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
                if let Err(error) = authorize_pin(
                    self.manager.inner.remote_authority.as_ref(),
                    &self.pin,
                    self.access,
                )
                .await
                {
                    drop(state);
                    retire_opened(opened).await;
                    return Err(error);
                }
            }
            match self.manager.inner.store.is_pin_current(&self.pin).await {
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
            } = opened;
            let entry = Arc::new(CacheEntry {
                live,
                generation,
                retire_at,
                managed_lease: StdMutex::new(managed_lease),
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
                entry,
                _scope_guard: self
                    .scope_guard
                    .take()
                    .expect("connection context owns one scope guard"),
            });
        }
    }

    /// Open and close an uncached pool while retaining the exact scope pin for the
    /// complete reachability check. Connection-form tests intentionally do not warm
    /// the shared pool cache.
    pub(crate) async fn test_fresh(self) -> AppResult<()> {
        let opened = connect_authorized(
            Arc::clone(&self.manager.inner.remote_authority),
            &self.pin.profile,
            &self.authorization,
            self.access,
        )
        .await?;
        if self.pin.requires_remote_rbac {
            if let Err(error) = authorize_pin(
                self.manager.inner.remote_authority.as_ref(),
                &self.pin,
                self.access,
            )
            .await
            {
                retire_opened(opened).await;
                return Err(error);
            }
        }
        let pin_is_current = match self.manager.inner.store.is_pin_current(&self.pin).await {
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
    #[cfg(test)]
    pub(crate) fn new(store: Store) -> Self {
        Self::with_remote_authority(store, closed_authority())
    }

    pub(crate) fn with_remote_authority(
        store: Store,
        remote_authority: Arc<dyn RemoteConnectionAuthorityPort>,
    ) -> Self {
        Self {
            inner: Arc::new(ConnectionManagerInner {
                store,
                remote_authority,
                scope_gate: Arc::new(RwLock::new(())),
                slots: DashMap::new(),
                next_generation: AtomicU64::new(1),
            }),
        }
    }

    pub(crate) async fn pin(
        &self,
        id: Uuid,
        access: ConnectionAccess,
    ) -> AppResult<ConnectionContext> {
        let scope_guard = Arc::clone(&self.inner.scope_gate).read_owned().await;
        let pin = self.inner.store.pin_connection_for_read(id).await?;
        let authorization =
            authorize_pin(self.inner.remote_authority.as_ref(), &pin, access).await?;
        if !self.inner.store.is_pin_current(&pin).await? {
            return Err(scope_changed());
        }
        Ok(ConnectionContext {
            manager: self.clone(),
            pin,
            access,
            authorization,
            scope_guard: Some(scope_guard),
        })
    }

    pub(crate) async fn acquire(
        &self,
        id: Uuid,
        access: ConnectionAccess,
    ) -> AppResult<ConnectionLease> {
        self.pin(id, access).await?.connect().await
    }

    pub(crate) async fn begin_operation_scope(&self) -> ConnectionOperationScope {
        ConnectionOperationScope {
            manager: self.clone(),
            _scope_guard: Arc::clone(&self.inner.scope_gate).read_owned().await,
        }
    }

    pub(crate) async fn begin_scope_mutation(&self) -> ConnectionMutation {
        ConnectionMutation {
            manager: self.clone(),
            pin: None,
            scope_guard: Some(Arc::clone(&self.inner.scope_gate).write_owned().await),
        }
    }

    pub(crate) async fn begin_connection_mutation(
        &self,
        id: Uuid,
        access: ConnectionAccess,
    ) -> AppResult<ConnectionMutation> {
        let scope_guard = Arc::clone(&self.inner.scope_gate).write_owned().await;
        let pin = self.inner.store.pin_connection_for_read(id).await?;
        authorize_pin(self.inner.remote_authority.as_ref(), &pin, access).await?;
        if !self.inner.store.is_pin_current(&pin).await? {
            return Err(scope_changed());
        }
        Ok(ConnectionMutation {
            manager: self.clone(),
            pin: Some(pin),
            scope_guard: Some(scope_guard),
        })
    }

    pub(crate) async fn activate_workspace(
        &self,
        id: Uuid,
        account_user_id: Option<&str>,
    ) -> AppResult<Workspace> {
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
        let _gate = self.inner.scope_gate.write().await;
        let workspace = self.inner.store.activate_workspace_account(user_id).await?;
        let retired = self.detach_all().await;
        drop(_gate);
        retire_entries(retired).await;
        Ok(workspace)
    }

    pub(crate) async fn remove_workspace_account(&self, user_id: &str) -> AppResult<()> {
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

fn schedule_expiry(slot: Arc<Mutex<ConnectionSlot>>, generation: u64, delay: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        let expired = {
            let mut state = slot.lock().await;
            if state
                .entry
                .as_ref()
                .is_some_and(|entry| entry.generation == generation)
            {
                state.entry.take()
            } else {
                None
            }
        };
        if expired.is_some() {
            retire_entries(expired.into_iter().collect()).await;
        }
    });
}

fn cache_entry_expired(entry: &CacheEntry) -> bool {
    entry
        .retire_at
        .is_some_and(|retire_at| retire_at <= Instant::now())
}

async fn retire_entries(entries: Vec<Arc<CacheEntry>>) {
    let retirements = entries.into_iter().filter_map(|entry| {
        Arc::try_unwrap(entry).ok().map(|entry| async move {
            entry.close_once().await;
            if let Some(managed_lease) = entry.take_managed_lease() {
                release_managed_bounded(managed_lease).await;
            }
        })
    });
    if tokio::time::timeout(
        MANAGED_RELEASE_TIMEOUT + Duration::from_secs(1),
        join_all(retirements),
    )
    .await
    .is_err()
    {
        tracing::warn!(
            "connection retirement timed out; remaining pools and provider leases are dropping"
        );
    }
}

async fn retire_opened(opened: OpenedLive) {
    opened.live.close().await;
    if let Some(managed_lease) = opened.managed_lease {
        release_managed_bounded(managed_lease).await;
    }
}

fn scope_changed() -> AppError {
    AppError::Blocked {
        reason: "workspace or connection access changed; retry the operation".into(),
    }
}

async fn authorize_pin(
    remote_authority: &dyn RemoteConnectionAuthorityPort,
    pin: &PinnedConnection,
    access: ConnectionAccess,
) -> AppResult<ConnectionAuthorization> {
    let write = access == ConnectionAccess::Write;
    if pin.requires_remote_rbac
        && pin.profile.credential_mode == WorkspaceCredentialMode::MemberLocal
        && write
    {
        return Err(AppError::Blocked {
            reason: "shared member-local connections are read-only".into(),
        });
    }
    if !pin.profile.workspace_access.can_read()
        || (write && (!pin.profile.workspace_access.can_write() || !pin.profile.allow_writes))
    {
        return Err(AppError::Blocked {
            reason: "your workspace role does not permit this database action".into(),
        });
    }
    if !pin.requires_remote_rbac {
        return Ok(ConnectionAuthorization {
            user_id: None,
            workspace_id: None,
        });
    }
    let user_id = pin.scope.selected_account_id.clone().ok_or_else(|| {
        AppError::Config("shared connection access requires an active workspace account".into())
    })?;
    let account_id = AccountId::new(user_id.clone())
        .ok_or_else(|| AppError::Config("active workspace account id is invalid".into()))?;
    let authority = remote_authority
        .authorize(
            &account_id,
            pin.scope.workspace_id.into(),
            pin.connection_id.into(),
            write,
        )
        .await?;
    if authority.revision != pin.connection_revision {
        return Err(AppError::Blocked {
            reason: "the shared connection changed; refresh the workspace and retry".into(),
        });
    }
    Ok(ConnectionAuthorization {
        user_id: Some(user_id),
        workspace_id: Some(pin.scope.workspace_id),
    })
}

/// Open a pool using either an OS credential reference or a short-lived provider lease.
async fn connect_authorized(
    remote_authority: Arc<dyn RemoteConnectionAuthorityPort>,
    profile: &ConnectionProfile,
    authorization: &ConnectionAuthorization,
    access: ConnectionAccess,
) -> AppResult<OpenedLive> {
    if profile.credential_mode == WorkspaceCredentialMode::Managed {
        let user_id = authorization.user_id.as_deref().ok_or_else(|| {
            AppError::Config("managed database access requires a workspace account".into())
        })?;
        let workspace_id = authorization.workspace_id.ok_or_else(|| {
            AppError::Config("managed database access requires a team workspace".into())
        })?;
        let account_id = AccountId::new(user_id.to_owned())
            .ok_or_else(|| AppError::Config("active workspace account id is invalid".into()))?;
        let workspace_id = WorkspaceId::from(workspace_id);
        let lease = remote_authority
            .issue_managed_lease(
                &account_id,
                workspace_id,
                profile,
                access == ConnectionAccess::Write,
            )
            .await?;
        // Anchor retirement immediately after the HTTPS response, before a slow TLS
        // or database handshake can consume part of the provider credential's life.
        let retire_at = Instant::now()
            + lease
                .valid_for
                .saturating_sub(Duration::from_secs(30))
                .max(Duration::from_secs(1));
        let managed_lease = ManagedLeaseHandle {
            authority: remote_authority,
            account_id,
            workspace_id,
            connection_id: profile.id.into(),
            lease_id: lease.lease_id,
        };
        let live = match crate::driver::connect(&lease.profile, lease.secret.as_str(), access).await
        {
            Ok(live) => live,
            Err(error) => {
                release_managed_bounded(managed_lease).await;
                return Err(error);
            }
        };
        return Ok(OpenedLive {
            live,
            retire_at: Some(retire_at),
            managed_lease: Some(managed_lease),
        });
    }

    let secret = Zeroizing::new(super::fetch_profile_secret(profile)?);
    Ok(OpenedLive {
        live: crate::driver::connect(profile, secret.as_str(), access).await?,
        retire_at: None,
        managed_lease: None,
    })
}

#[cfg(test)]
mod tests;
