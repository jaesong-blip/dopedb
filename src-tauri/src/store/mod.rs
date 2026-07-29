//! The local application store: a WAL SQLite DB at
//! `dirs::data_dir()/dopedb/app.db` holding connections, safety settings,
//! query history, the audit log, saved dashboards, snippets, and the schema cache.
//!
//! Secrets are NEVER stored here — connections carry only a `secret_ref` that
//! points at an OS credential-store item. Row⇄model mapping is manual (`sqlx::query`,
//! runtime, not the compile-time `query!` macro) because this is a
//! runtime-arbitrary-SQL client.

mod bootstrap;
mod migrations;
mod projections;
mod repositories;
mod retired_chat_archive;
mod workspace_codec;

#[cfg(test)]
mod tests;

pub(crate) use workspace_codec::{
    credential_mode_str, parse_credential_mode, parse_workspace_access, workspace_access_str,
};
use workspace_codec::{
    parse_workspace_kind, parse_workspace_role, row_to_workspace, workspace_kind_str,
    workspace_role_str,
};

use bootstrap::*;
use projections::*;
use repositories::*;

pub(crate) use projections::{
    engine_str, kind_str, parse_engine, parse_kind, parse_provider, parse_uuid, parse_uuid_opt,
    provider_str,
};

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use dopedb_protocol::catalog::{CatalogSnapshot, DatabaseEngine, CATALOG_SCHEMA_VERSION};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{AssertSqlSafe, Executor, Row, Sqlite, SqlitePool, Transaction};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::dashboards::{validate_visualization, Dashboard, DashboardDraft};
use crate::features::workspaces::{
    Workspace, WorkspaceAccountMembership, WorkspaceAuthAccount, WorkspaceAuthUser, WorkspaceKind,
    WorkspaceRole,
};
use crate::kernel::identity::{AccountId, ConnectionId, DashboardId, WorkspaceId};
use crate::model::{
    ConnectionProfile, Engine, HistoryEntry, Provider, QueryKind, SafetySettings,
    WorkspaceConnectionAccess, WorkspaceCredentialMode,
};

/// Handle to the local app.db. Cheap to clone (the pool is an `Arc` internally).
#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    /// Serializes audit-chain appends. The chain is read-tail-then-insert, which two
    /// concurrent `audit::record` calls on the pooled (multi-connection) SQLite store
    /// would otherwise interleave — both reading the same tail hash and forking the
    /// chain, making `verify_chain` report false tampering.
    // ponytail: one global async lock; audit writes are rare, contention is a non-issue.
    audit_lock: Arc<Mutex<()>>,
}

/// Stable, non-secret identity for local execution artifacts. Team resources are
/// partitioned by the exact Better Auth account; Personal resources remain
/// account-free even while an account is selected in the switcher.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum AccountScope {
    Personal,
    WorkspaceUser(String),
}

impl AccountScope {
    pub(crate) fn storage_key(&self) -> &str {
        match self {
            Self::Personal => "personal",
            Self::WorkspaceUser(user_id) => user_id,
        }
    }
}

/// One atomically observed workspace/account selection. `generation` changes for
/// every committed selection, including A → B → A, so a late task cannot mistake a
/// newly re-selected scope for the one in which it originally started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActiveResourceScope {
    pub workspace_id: Uuid,
    pub workspace_kind: WorkspaceKind,
    pub selected_account_id: Option<String>,
    pub account_scope: AccountScope,
    pub generation: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CatalogCachePolicy {
    Persistent,
    EphemeralOnly,
}

/// A connection resolved together with the exact active scope and every piece of
/// local credential material that can change its meaning.
#[derive(Clone)]
pub(crate) struct PinnedConnection {
    pub scope: ActiveResourceScope,
    pub connection_id: Uuid,
    pub connection_revision: i64,
    pub binding_revision: i64,
    pub binding_updated_at: String,
    pub profile: ConnectionProfile,
    pub requires_remote_rbac: bool,
    pub catalog_cache_policy: CatalogCachePolicy,
}

/// Minimal immutable identity required to tombstone a saved dashboard. Keeping
/// presentation JSON out of this pin lets users delete malformed legacy rows.
#[derive(Clone)]
pub(crate) struct PinnedDashboard {
    pub dashboard_id: DashboardId,
    pub connection_id: Uuid,
    pub dashboard_revision: i64,
    pub connection: PinnedConnection,
}

/// History row plus the exact active scope in which its provenance was first
/// resolved. Agent dashboard preparation validates eligibility before pinning, then
/// passes this token back for an ABA-safe same-scope re-read.
#[derive(Clone)]
pub(crate) struct ResolvedDashboardHistory {
    pub history: HistoryEntry,
    scope: ActiveResourceScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CacheWriteOutcome {
    Stored,
    Stale,
    NotPersisted,
}

impl Store {
    /// Open (creating if needed) the app.db and run migrations.
    pub async fn open() -> AppResult<Store> {
        let dir = dirs::data_dir()
            .ok_or_else(|| AppError::Config("no OS data dir (dirs::data_dir)".into()))?
            .join("dopedb");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("app.db");

        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new().connect_with(opts).await?;
        sqlx::raw_sql(migrations::SCHEMA).execute(&pool).await?;
        // Idempotent column adds for DBs created before the column existed (SQLite has
        // no `ADD COLUMN IF NOT EXISTS`, so we run it and ignore the duplicate-column error).
        let _ = sqlx::query("ALTER TABLE connections ADD COLUMN env TEXT")
            .execute(&pool)
            .await;
        let _ = sqlx::query("ALTER TABLE connections ADD COLUMN schema_group TEXT")
            .execute(&pool)
            .await;
        let _ =
            sqlx::query("ALTER TABLE connections ADD COLUMN provider TEXT NOT NULL DEFAULT 'auto'")
                .execute(&pool)
                .await;
        let _ = sqlx::query("ALTER TABLE connections ADD COLUMN driver_id TEXT")
            .execute(&pool)
            .await;
        let _ = sqlx::query(
            "ALTER TABLE connections ADD COLUMN workspace_access TEXT NOT NULL DEFAULT 'local'",
        )
        .execute(&pool)
        .await;
        let _ = sqlx::query(
            "ALTER TABLE connections ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'local'",
        )
        .execute(&pool)
        .await;
        let _ = sqlx::query("ALTER TABLE agent_chat_threads ADD COLUMN connection_id TEXT")
            .execute(&pool)
            .await;
        let _ = sqlx::query(
            "ALTER TABLE jobs ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0
             CHECK(pause_requested IN (0, 1))",
        )
        .execute(&pool)
        .await;
        let _ = sqlx::query("ALTER TABLE sql_documents ADD COLUMN selected_schema TEXT")
            .execute(&pool)
            .await;
        let _ = sqlx::query(
            "ALTER TABLE sql_documents ADD COLUMN resolve_mode TEXT NOT NULL
             DEFAULT 'playground' CHECK(resolve_mode IN ('playground', 'script'))",
        )
        .execute(&pool)
        .await;
        add_workspace_columns(&pool).await;
        migrate_workspace_foundation(&pool).await?;
        migrate_audit_no_cascade(&pool).await?;
        add_local_scope_columns(&pool).await;
        add_connection_binding_scope_columns(&pool).await?;
        migrate_schema_cache_scopes(&pool).await?;
        ensure_schema_cache_v2(&pool).await?;
        repair_active_scope_on_open(&pool).await?;
        ensure_local_scope_indexes(&pool).await?;
        Ok(Store {
            pool,
            audit_lock: Arc::new(Mutex::new(())),
        })
    }

    /// Escape hatch for sibling modules (audit) that own their own SQL.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Lock guarding audit-chain appends (see the field doc). `audit::record` holds
    /// this across its read-tail + insert so the chain can't fork under concurrency.
    pub(crate) fn audit_lock(&self) -> &Mutex<()> {
        &self.audit_lock
    }

    /// Wrap an already-open pool as a `Store` (tests only — bypasses `open`'s data-dir).
    #[cfg(test)]
    pub(crate) fn from_pool_for_test(pool: SqlitePool) -> Store {
        Store {
            pool,
            audit_lock: Arc::new(Mutex::new(())),
        }
    }
}
