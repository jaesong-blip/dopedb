use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use chrono::Utc;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tempfile::TempDir;
use uuid::Uuid;

use super::{
    compose, AgentDashboardCreateError, AgentDashboardPresentation, DashboardDraft, DashboardKind,
    DashboardRunError, DashboardRunRequest, DashboardVisualization, DashboardsFeature,
};
use crate::audit;
use crate::connection::{ConnectionAccess, ConnectionManager};
use crate::error::AppError;
use crate::kernel::identity::{AccountScopeId, ConnectionId, DashboardId, QueryRunId};
use crate::kernel::TerminalAuthority;
use crate::model::{
    ConnectionProfile, Engine, HistoryEntry, Provider, QueryKind, WorkspaceConnectionAccess,
    WorkspaceCredentialMode,
};
use crate::services::TerminalQueryRunRegistry;
use crate::store::{Store, TEST_SCHEMA};

fn sqlite_profile(id: Uuid, database: String, name: &str) -> ConnectionProfile {
    ConnectionProfile {
        id,
        name: name.into(),
        engine: Engine::Sqlite,
        provider: Provider::Generic,
        driver_id: Some("sqlx-sqlite".into()),
        host: String::new(),
        port: 0,
        database,
        username: String::new(),
        sslmode: "disable".into(),
        extra_params: HashMap::new(),
        readonly_default: true,
        allow_writes: false,
        secret_ref: None,
        env: Some("test".into()),
        schema_group: None,
        workspace_access: WorkspaceConnectionAccess::Local,
        credential_mode: WorkspaceCredentialMode::Local,
    }
}

async fn memory_store() -> Store {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
    Store::from_pool_for_test(pool)
}

async fn terminal_authority(
    store: &Store,
    terminal_session_id: Uuid,
    connection_id: Uuid,
) -> TerminalAuthority {
    let pin = store
        .pin_connection_for_dashboard(connection_id)
        .await
        .unwrap();
    TerminalAuthority {
        terminal_session_id: terminal_session_id.into(),
        workspace_id: pin.scope.workspace_id.into(),
        account_scope: AccountScopeId::new(pin.scope.account_scope.storage_key()).unwrap(),
        scope_generation: pin.scope.generation,
        connection_id: ConnectionId::from(pin.connection_id),
        connection_revision: pin.connection_revision,
        client_protocol_version: dopedb_protocol::PROTOCOL_MAX,
    }
}

fn presentation(title: &str) -> AgentDashboardPresentation {
    AgentDashboardPresentation {
        title: title.into(),
        description: "Saved from one agent run".into(),
        kind: DashboardKind::Table,
        x_column: None,
        y_columns: Vec::new(),
    }
}

async fn insert_history(
    store: &Store,
    connection_id: Uuid,
    origin: &str,
    status: &str,
    kind: QueryKind,
) -> Uuid {
    let id = Uuid::new_v4();
    let pin = store.pin_connection_for_read(connection_id).await.unwrap();
    store
        .insert_history_if_current(
            &pin,
            &HistoryEntry {
                id,
                connection_id,
                sql: "SELECT id, name FROM users".into(),
                kind,
                status: status.into(),
                row_count: Some(1),
                duration_ms: Some(1),
                error: None,
                executed_at: Utc::now(),
                origin: origin.into(),
            },
        )
        .await
        .unwrap();
    id
}

struct CreationHarness {
    feature: DashboardsFeature,
    store: Store,
    terminal_runs: TerminalQueryRunRegistry,
    authority: TerminalAuthority,
    connection_id: Uuid,
}

impl CreationHarness {
    async fn new() -> Self {
        let store = memory_store().await;
        let connection_id = Uuid::new_v4();
        store
            .upsert_connection(&sqlite_profile(
                connection_id,
                ":memory:".into(),
                "dashboard-create-test",
            ))
            .await
            .unwrap();
        let connections = ConnectionManager::new(store.clone());
        let terminal_runs = TerminalQueryRunRegistry::default();
        let authority = terminal_authority(&store, Uuid::new_v4(), connection_id).await;
        let feature = compose(store.clone(), connections, terminal_runs.clone());
        Self {
            feature,
            store,
            terminal_runs,
            authority,
            connection_id,
        }
    }

    fn authorize(&self, query_run_id: Uuid) {
        self.terminal_runs.register(
            query_run_id,
            self.authority.terminal_session_id,
            self.connection_id.into(),
        );
    }
}

#[tokio::test]
async fn creation_distinguishes_missing_and_ineligible_query_runs() {
    let harness = CreationHarness::new().await;
    let missing = Uuid::new_v4();
    harness.authorize(missing);
    assert!(matches!(
        harness
            .feature
            .create_terminal(
                &harness.authority,
                QueryRunId::from(missing),
                presentation("Missing"),
            )
            .await,
        Err(AgentDashboardCreateError::QueryRunNotFound)
    ));

    for (origin, status, kind) in [
        ("manual", "ok", QueryKind::Read),
        ("agent", "error", QueryKind::Read),
        ("agent", "ok", QueryKind::Write),
    ] {
        let query_run_id =
            insert_history(&harness.store, harness.connection_id, origin, status, kind).await;
        harness.authorize(query_run_id);
        assert!(matches!(
            harness
                .feature
                .create_terminal(
                    &harness.authority,
                    QueryRunId::from(query_run_id),
                    presentation("Ineligible"),
                )
                .await,
            Err(AgentDashboardCreateError::QueryRunIneligible)
        ));
    }
}

#[tokio::test]
async fn creation_uses_stored_sql_and_validates_before_persistence() {
    let harness = CreationHarness::new().await;
    let query_run_id = insert_history(
        &harness.store,
        harness.connection_id,
        "agent",
        "ok",
        QueryKind::Read,
    )
    .await;
    harness.authorize(query_run_id);
    let saved = harness
        .feature
        .create_terminal(
            &harness.authority,
            QueryRunId::from(query_run_id),
            presentation("Agent result"),
        )
        .await
        .unwrap();
    assert_eq!(
        saved.connection_id,
        ConnectionId::from(harness.connection_id)
    );
    assert_eq!(saved.sql, "SELECT id, name FROM users");

    let invalid_run = insert_history(
        &harness.store,
        harness.connection_id,
        "agent",
        "ok",
        QueryKind::Read,
    )
    .await;
    harness.authorize(invalid_run);
    assert!(matches!(
        harness
            .feature
            .create_terminal(
                &harness.authority,
                QueryRunId::from(invalid_run),
                presentation(" "),
            )
            .await,
        Err(AgentDashboardCreateError::InvalidDraft(AppError::Config(_)))
    ));
}

struct DashboardRunHarness {
    _temp_dir: TempDir,
    store: Store,
    connections: ConnectionManager,
    feature: DashboardsFeature,
    connection_id: Uuid,
    dashboard_id: DashboardId,
    target_path: std::path::PathBuf,
}

impl DashboardRunHarness {
    async fn new(sql: &str) -> Self {
        let store = memory_store().await;
        let temp_dir = TempDir::new().unwrap();
        let target_path = temp_dir.path().join("dashboard-target.sqlite");
        initialize_dashboard_target(&target_path).await;
        let connection_id = Uuid::new_v4();
        store
            .upsert_connection(&sqlite_profile(
                connection_id,
                target_path.display().to_string(),
                "dashboard-run-test",
            ))
            .await
            .unwrap();
        let connections = ConnectionManager::new(store.clone());
        let feature = compose(
            store.clone(),
            connections.clone(),
            TerminalQueryRunRegistry::default(),
        );
        let dashboard = store
            .save_dashboard(&DashboardDraft {
                connection_id: ConnectionId::from(connection_id),
                title: "People".into(),
                description: "Dashboard execution contract".into(),
                sql: sql.into(),
                visualization: DashboardVisualization {
                    version: 1,
                    kind: DashboardKind::Table,
                    x_column: None,
                    y_columns: Vec::new(),
                },
            })
            .await
            .unwrap();
        Self {
            _temp_dir: temp_dir,
            store,
            connections,
            feature,
            connection_id,
            dashboard_id: dashboard.id,
            target_path,
        }
    }

    async fn overwrite_dashboard_sql(&self, sql: &str) {
        sqlx::query("UPDATE dashboards SET sql = ?1 WHERE id = ?2")
            .bind(sql)
            .bind(self.dashboard_id.to_string())
            .execute(self.store.pool())
            .await
            .unwrap();
    }

    async fn user_name(&self, id: i64) -> String {
        let options = SqliteConnectOptions::new()
            .filename(&self.target_path)
            .read_only(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let name = sqlx::query_scalar::<_, String>("SELECT name FROM users WHERE id = ?1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        pool.close().await;
        name
    }

    async fn close(self) {
        let mutation = self
            .connections
            .begin_connection_mutation(self.connection_id, ConnectionAccess::Read)
            .await
            .unwrap();
        mutation.retire_connection(self.connection_id).await;
        let Self {
            _temp_dir,
            store,
            connections,
            feature,
            ..
        } = self;
        drop(feature);
        drop(connections);
        store.pool().close().await;
        drop(store);
        _temp_dir
            .close()
            .expect("temporary dashboard directory must be removable after pool shutdown");
    }
}

async fn initialize_dashboard_target(path: &Path) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
         INSERT INTO users (id, name) VALUES (1, 'Ada'), (2, 'Linus');",
    )
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
}

#[tokio::test]
async fn run_preserves_wire_ledger_and_authority_lease() {
    let harness = DashboardRunHarness::new("SELECT id, name FROM users ORDER BY id").await;
    let receipt = harness
        .feature
        .run(DashboardRunRequest {
            dashboard_id: harness.dashboard_id,
            query_id: None,
        })
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        serde_json::json!({
            "columns": ["id", "name"],
            "rows": [[1, "Ada"], [2, "Linus"]],
            "rowCount": 2,
            "truncated": false,
            "durationMs": receipt.result.duration_ms
        })
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            harness.connections.begin_scope_mutation(),
        )
        .await
        .is_err(),
        "serialized receipt must retain connection authority"
    );
    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].origin, "dashboard");
    assert_eq!(history[0].status, "ok");
    assert_eq!(history[0].kind, QueryKind::Read);
    assert_eq!(history[0].row_count, Some(2));
    let (audit, valid, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap();
    assert!(valid);
    assert_eq!(first_bad, None);
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].action, "dashboard:run");
    assert_eq!(audit[0].affected_estimate, Some(2));

    drop(receipt);
    let mutation = tokio::time::timeout(
        Duration::from_secs(5),
        harness.connections.begin_scope_mutation(),
    )
    .await
    .expect("scope mutation must proceed after receipt drop");
    drop(mutation);
    harness.close().await;
}

#[tokio::test]
async fn run_revalidates_tampered_sql_before_target_touch() {
    let harness = DashboardRunHarness::new("SELECT id, name FROM users ORDER BY id").await;
    harness
        .overwrite_dashboard_sql("UPDATE users SET name = 'Grace' WHERE id = 1")
        .await;
    let failure = match harness
        .feature
        .run(DashboardRunRequest {
            dashboard_id: harness.dashboard_id,
            query_id: None,
        })
        .await
    {
        Err(error @ DashboardRunError::Scoped(_)) => error,
        _ => panic!("tampered dashboard write must fail before target touch"),
    };
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            harness.connections.begin_scope_mutation(),
        )
        .await
        .is_err(),
        "blocked result must retain its operation scope until transport mapping"
    );
    let error = failure.into_error();
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        serde_json::json!({
            "kind": "blocked",
            "message": "blocked: dashboards may only save one read-only SQL statement"
        })
    );
    assert_eq!(harness.user_name(1).await, "Ada");
    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, "blocked");
    assert_eq!(history[0].kind, QueryKind::Write);
    let (audit, valid, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap();
    assert!(valid);
    assert_eq!(first_bad, None);
    assert_eq!(audit.len(), 1);
    assert!(audit[0]
        .error
        .as_deref()
        .is_some_and(|message| message.contains("dashboards may only save")));
    harness.close().await;
}

#[tokio::test]
async fn run_execution_error_preserves_original_error_and_ledger() {
    let harness = DashboardRunHarness::new("SELECT * FROM missing_users").await;
    let failure = match harness
        .feature
        .run(DashboardRunRequest {
            dashboard_id: harness.dashboard_id,
            query_id: None,
        })
        .await
    {
        Err(error @ DashboardRunError::Execution(_)) => error,
        _ => panic!("missing table must fail inside the read-only executor"),
    };
    let original = match &failure {
        DashboardRunError::Execution(failure) => failure.error.to_string(),
        _ => unreachable!(),
    };
    assert!(original.contains("missing_users"));
    assert_eq!(failure.into_error().to_string(), original);
    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, "error");
    assert!(history[0]
        .error
        .as_deref()
        .is_some_and(|message| message.contains("missing_users")));
    let (audit, valid, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap();
    assert!(valid);
    assert_eq!(first_bad, None);
    assert_eq!(audit.len(), 1);
    assert!(audit[0]
        .error
        .as_deref()
        .is_some_and(|message| message.contains("missing_users")));
    assert_eq!(harness.user_name(1).await, "Ada");
    harness.close().await;
}
