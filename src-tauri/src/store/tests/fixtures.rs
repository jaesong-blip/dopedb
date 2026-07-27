//! Store repository integration and migration characterization tests.

pub(super) use super::super::{
    add_connection_binding_scope_columns, add_local_scope_columns, add_workspace_columns,
    engine_str, ensure_local_scope_indexes, ensure_schema_cache_v2, migrate_audit_no_cascade,
    migrate_schema_cache_scopes, migrate_workspace_foundation, migrations, parse_engine,
    repair_active_scope_on_open, CacheWriteOutcome, CatalogCachePolicy, Store,
};
pub(super) use crate::error::AppError;
pub(super) use crate::features::dashboards::{
    DashboardDraft, DashboardKind, DashboardVisualization,
};
pub(super) use crate::features::workspaces::{WorkspaceAuthUser, WorkspaceRole};
pub(super) use crate::kernel::identity::{
    AccountId, ConnectionId, RetiredChatThreadId, WorkspaceId,
};
pub(super) use crate::model::{ConnectionProfile, Engine, HistoryEntry, Provider, QueryKind};
pub(super) use chrono::{TimeZone, Utc};
pub(super) use dopedb_protocol::catalog::{CatalogContents, CatalogSnapshot, DatabaseEngine};
pub(super) use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
pub(super) use sqlx::SqlitePool;
pub(super) use std::collections::HashMap;
pub(super) use std::str::FromStr;
pub(super) use std::time::Duration;
pub(super) use uuid::Uuid;

pub(super) async fn memory_pool() -> SqlitePool {
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap()
}

pub(super) fn sqlite_profile(id: Uuid, name: &str) -> ConnectionProfile {
    ConnectionProfile {
        id,
        name: name.into(),
        engine: Engine::Sqlite,
        provider: Provider::Generic,
        driver_id: Some("sqlx-sqlite".into()),
        host: String::new(),
        port: 0,
        database: ":memory:".into(),
        username: String::new(),
        sslmode: "disable".into(),
        extra_params: HashMap::new(),
        readonly_default: true,
        allow_writes: false,
        secret_ref: None,
        env: None,
        schema_group: None,
        workspace_access: crate::model::WorkspaceConnectionAccess::Local,
        credential_mode: crate::model::WorkspaceCredentialMode::Local,
    }
}

pub(super) fn workspace_user(id: &str, name: &str) -> WorkspaceAuthUser {
    WorkspaceAuthUser {
        id: AccountId::new(id).unwrap(),
        email: format!("{}@example.com", name.to_lowercase()),
        display_name: name.into(),
    }
}

pub(super) fn catalog_snapshot(
    connection_id: Uuid,
    database: &str,
    marker: char,
) -> CatalogSnapshot {
    CatalogSnapshot::capture(
        connection_id,
        DatabaseEngine::Sqlite,
        database,
        Utc.with_ymd_and_hms(2026, 7, 24, 0, 0, 0).single().unwrap(),
        CatalogContents {
            namespaces: vec![dopedb_protocol::catalog::Namespace {
                name: marker.to_string(),
                comment: None,
            }],
            ..CatalogContents::default()
        },
    )
    .unwrap()
}

pub(super) fn dashboard_draft(connection_id: Uuid, title: &str) -> DashboardDraft {
    DashboardDraft {
        connection_id: ConnectionId::from(connection_id),
        title: title.into(),
        description: String::new(),
        sql: "SELECT 1".into(),
        visualization: DashboardVisualization {
            version: 1,
            kind: DashboardKind::Table,
            x_column: None,
            y_columns: Vec::new(),
        },
    }
}

pub(super) async fn seed_legacy_chat_thread(
    store: &Store,
    connection_id: Uuid,
    title: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    let workspace_id = store.active_workspace_id().await.unwrap();
    let account_scope = store.active_local_scope().await.unwrap();
    let now = Utc::now();
    sqlx::query(
        r#"INSERT INTO agent_chat_threads
               (id, provider, connection_id, workspace_id, account_scope, title,
                cli_session_id, model, effort, created_at, updated_at)
               VALUES (?1,'codex',?2,?3,?4,?5,'legacy-session','legacy-model','high',?6,?6)"#,
    )
    .bind(id.to_string())
    .bind(connection_id.to_string())
    .bind(workspace_id.to_string())
    .bind(account_scope)
    .bind(title)
    .bind(now)
    .execute(store.pool())
    .await
    .unwrap();
    id
}

pub(super) async fn seed_legacy_chat_message(
    store: &Store,
    thread_id: Uuid,
    role: &str,
    text: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO agent_chat_messages (id, thread_id, role, text, error, created_at)
               VALUES (?1,?2,?3,?4,NULL,?5)"#,
    )
    .bind(id.to_string())
    .bind(thread_id.to_string())
    .bind(role)
    .bind(text)
    .bind(Utc::now())
    .execute(store.pool())
    .await
    .unwrap();
    id
}
