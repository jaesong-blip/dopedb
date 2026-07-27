//! Script feature characterization and transaction-safety tests.

use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tempfile::TempDir;

use super::*;
use crate::model::{
    ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};
use crate::store::TEST_SCHEMA;

struct ScriptHarness {
    directory: TempDir,
    store: Store,
    connections: ConnectionManager,
    catalog: CatalogFeature,
    service: ScriptFeature,
    operation: OperationRuntime,
    operation_service: crate::features::operation_control::OperationControlFeature,
    approval: crate::operations::LocalApprovalAuthority,
    connection_id: Uuid,
    profile: ConnectionProfile,
    target_path: std::path::PathBuf,
}

impl ScriptHarness {
    async fn new() -> Self {
        let app_options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let app_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(app_options)
            .await
            .unwrap();
        sqlx::raw_sql(TEST_SCHEMA).execute(&app_pool).await.unwrap();
        let store = Store::from_pool_for_test(app_pool);
        let directory = TempDir::new().unwrap();
        let target_path = directory.path().join("script-target.sqlite");
        initialize_target(&target_path).await;
        let connection_id = Uuid::new_v4();
        let profile = ConnectionProfile {
            id: connection_id,
            name: "script-test".into(),
            engine: Engine::Sqlite,
            provider: Provider::Generic,
            driver_id: Some("sqlx-sqlite".into()),
            host: String::new(),
            port: 0,
            database: target_path.display().to_string(),
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
        };
        store.upsert_connection(&profile).await.unwrap();
        let connections = ConnectionManager::new(store.clone());
        let (operation, approval) = OperationRuntime::new(&store);
        let operation_service = crate::features::operation_control::compose(
            store.clone(),
            connections.clone(),
            operation.clone(),
        );
        let catalog = crate::features::catalog::compose(store.clone(), connections.clone());
        let service = compose(
            store.clone(),
            connections.clone(),
            catalog.clone(),
            operation.clone(),
        );
        Self {
            directory,
            store,
            connections,
            catalog,
            service,
            operation,
            operation_service,
            approval,
            connection_id,
            profile,
            target_path,
        }
    }

    async fn configure(&self, allow_writes: bool, auto_run_reads: bool) {
        let mut profile = self.profile.clone();
        profile.allow_writes = allow_writes;
        self.store.upsert_connection(&profile).await.unwrap();
        let mut settings = self.store.get_safety(self.connection_id).await.unwrap();
        settings.allow_writes = allow_writes;
        settings.auto_run_reads = auto_run_reads;
        self.store
            .set_safety(self.connection_id, &settings)
            .await
            .unwrap();
    }

    async fn user_names(&self) -> Vec<String> {
        let options = SqliteConnectOptions::new()
            .filename(&self.target_path)
            .read_only(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let names = sqlx::query_scalar("SELECT name FROM users ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        pool.close().await;
        names
    }

    async fn audit_actions(&self) -> Vec<String> {
        let (mut entries, valid, first_bad) = audit::snapshot(&self.store, self.connection_id)
            .await
            .unwrap();
        assert!(valid);
        assert_eq!(first_bad, None);
        entries.reverse();
        entries.into_iter().map(|entry| entry.action).collect()
    }

    async fn propose(
        &self,
        sql: &str,
        origin: Option<&str>,
    ) -> Result<DesktopScriptProposalReceipt, DesktopScriptRunError> {
        self.service
            .propose_desktop(DesktopScriptProposalRequest {
                connection_id: self.connection_id,
                sql: sql.into(),
                origin: origin.map(str::to_string),
                schema_change: None,
                table_change: None,
            })
            .await
    }

    async fn propose_table(
        &self,
        statements: &[&str],
    ) -> Result<DesktopScriptProposalReceipt, DesktopScriptRunError> {
        let snapshot = self
            .catalog
            .load_snapshot(self.connection_id.into(), CatalogReadPolicy::Refresh)
            .await
            .unwrap();
        self.service
            .propose_desktop(DesktopScriptProposalRequest {
                connection_id: self.connection_id,
                sql: statements.join(";\n"),
                origin: Some("table_editor".into()),
                schema_change: None,
                table_change: Some(TableScriptContext {
                    catalog_fingerprint: snapshot.fingerprint().into(),
                    expected_affected: vec![1; statements.len()],
                }),
            })
            .await
    }

    async fn approve(&self, proposal: &DesktopScriptProposalReceipt) {
        self.operation_service
            .approve_local(
                &self.approval,
                crate::features::operation_control::OperationDecisionRequest {
                    operation_id: proposal.operation_id,
                    expected_payload_hash: proposal.payload_hash.clone(),
                    reason: None,
                },
            )
            .await
            .unwrap();
    }

    async fn close(self) {
        let mutation = self
            .connections
            .begin_connection_mutation(self.connection_id, ConnectionAccess::Read)
            .await
            .unwrap();
        mutation.retire_connection(self.connection_id).await;
        let Self {
            directory,
            store,
            connections,
            service,
            operation_service,
            ..
        } = self;
        drop(service);
        drop(operation_service);
        drop(connections);
        store.pool().close().await;
        drop(store);
        directory
            .close()
            .expect("temporary script directory must be removable after pool shutdown");
    }
}

async fn initialize_target(path: &Path) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
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

#[test]
fn write_path_only_when_a_statement_writes() {
    assert!(!script_has_write(&[QueryKind::Read, QueryKind::Read]));
    assert!(script_has_write(&[QueryKind::Read, QueryKind::Write]));
    assert!(script_has_write(&[QueryKind::Ddl]));
    assert!(script_has_write(&[QueryKind::Privilege]));
}

#[tokio::test]
async fn read_script_preserves_wire_history_and_lease() {
    let harness = ScriptHarness::new().await;
    let proposal = harness
        .propose(
            "SELECT id FROM users ORDER BY id; SELECT name FROM users ORDER BY id",
            Some("sql"),
        )
        .await
        .unwrap();
    assert!(!proposal.approval_required);
    assert_eq!(proposal.state, OperationState::Ready);
    let receipt = harness
        .service
        .run_desktop(proposal.operation_id)
        .await
        .unwrap();
    assert!(receipt.outcome.all_reads);
    assert!(!receipt.outcome.committed);
    assert_eq!(receipt.outcome.statements.len(), 2);
    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        serde_json::to_value(&receipt.outcome).unwrap(),
        "script receipt must preserve the literal legacy ScriptOutcome wire"
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            harness.connections.begin_scope_mutation(),
        )
        .await
        .is_err(),
        "script receipt must retain authority through adapter serialization"
    );
    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].origin, "sql");
    assert_eq!(history[0].status, "ok");
    assert_eq!(history[0].row_count, Some(4));
    assert_eq!(harness.audit_actions().await, ["script:execute"]);
    drop(receipt);
    let mutation = tokio::time::timeout(
        Duration::from_secs(5),
        harness.connections.begin_scope_mutation(),
    )
    .await
    .expect("scope mutation must proceed after script receipt drop");
    drop(mutation);
    harness.close().await;
}

#[tokio::test]
async fn read_script_remains_a_plan_run_flow_when_auto_run_is_off() {
    let harness = ScriptHarness::new().await;
    harness.configure(false, false).await;
    let proposal = harness.propose("SELECT id FROM users", None).await.unwrap();
    assert!(!proposal.approval_required);
    let receipt = harness
        .service
        .run_desktop(proposal.operation_id)
        .await
        .unwrap();
    assert!(receipt.outcome.all_reads);
    drop(receipt);
    assert_eq!(harness.audit_actions().await, ["script:execute"]);
    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, "ok");
    assert_eq!(history[0].origin, "manual");
    harness.close().await;
}

#[tokio::test]
async fn write_script_gates_preserve_exact_errors_and_never_touch_target() {
    let harness = ScriptHarness::new().await;
    let writes_disabled = match harness
        .propose("UPDATE users SET name = 'Grace' WHERE id = 1", None)
        .await
    {
        Err(error) => error.into_error(),
        Ok(_) => panic!("writes-disabled script must be rejected"),
    };
    assert_eq!(
        serde_json::to_value(&writes_disabled).unwrap(),
        serde_json::json!({
            "kind": "blocked",
            "message": "blocked: writes are disabled for this connection"
        })
    );

    harness.configure(true, true).await;
    let proposal = harness
        .propose("UPDATE users SET name = 'Grace' WHERE id = 1", Some("sql"))
        .await
        .unwrap();
    assert!(proposal.approval_required);
    let approval_required = match harness.service.run_desktop(proposal.operation_id).await {
        Err(error) => error.into_error(),
        Ok(_) => panic!("unapproved write script must be rejected"),
    };
    assert!(matches!(approval_required, AppError::Blocked { .. }));
    assert_eq!(harness.user_names().await, ["Ada", "Linus"]);
    assert!(harness.audit_actions().await.is_empty());
    assert!(harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap()
        .is_empty());
    harness.close().await;
}

#[tokio::test]
async fn arbitrary_privilege_script_is_blocked_before_operation_persistence() {
    let harness = ScriptHarness::new().await;
    harness.configure(true, true).await;
    let error = match harness
        .propose("GRANT SELECT ON users TO analyst", None)
        .await
    {
        Err(error) => error.into_error(),
        Ok(_) => panic!("arbitrary privilege scripts must be blocked"),
    };
    assert!(matches!(
        error,
        AppError::Blocked { ref reason } if reason.contains("arbitrary privilege SQL")
    ));
    assert!(harness.audit_actions().await.is_empty());
    harness.close().await;
}

#[tokio::test]
async fn write_script_is_atomic_and_closes_attempt_ledger() {
    let harness = ScriptHarness::new().await;
    harness.configure(true, true).await;
    let proposal = harness
        .propose(
            "UPDATE users SET name = 'Grace' WHERE id = 1;\
                 UPDATE users SET name = 'Ken' WHERE id = 2",
            Some("data-view"),
        )
        .await
        .unwrap();
    harness.approve(&proposal).await;
    let receipt = harness
        .service
        .run_desktop(proposal.operation_id)
        .await
        .unwrap();
    assert!(receipt.outcome.committed);
    assert!(!receipt.outcome.all_reads);
    assert_eq!(receipt.outcome.statements.len(), 2);
    drop(receipt);
    assert_eq!(harness.user_names().await, ["Grace", "Ken"]);
    assert_eq!(
        harness.audit_actions().await,
        ["script:execute:attempt", "script:execute"]
    );
    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].origin, "data-view");
    assert_eq!(history[0].status, "ok");
    assert_eq!(history[0].row_count, Some(2));
    harness.close().await;
}

#[tokio::test]
async fn staged_table_changes_roll_back_on_optimistic_conflict() {
    let harness = ScriptHarness::new().await;
    harness.configure(true, true).await;
    let proposal = harness
        .propose_table(&[
            "UPDATE users SET name = 'Grace' WHERE id = 1 AND name = 'Ada'",
            "UPDATE users SET name = 'Ken' WHERE id = 2 AND name = 'stale'",
        ])
        .await
        .unwrap();
    harness.approve(&proposal).await;

    let receipt = harness
        .service
        .run_desktop(proposal.operation_id)
        .await
        .unwrap();

    assert!(!receipt.outcome.committed);
    assert!(receipt.outcome.statements[1]
        .error
        .as_deref()
        .is_some_and(|error| error.contains("optimistic concurrency conflict")));
    drop(receipt);
    assert_eq!(harness.user_names().await, ["Ada", "Linus"]);
    harness.close().await;
}

#[tokio::test]
async fn script_commit_without_acknowledgement_is_not_reported_as_rolled_back() {
    let harness = ScriptHarness::new().await;
    harness.configure(true, true).await;
    let lease = harness
        .connections
        .acquire(harness.connection_id, ConnectionAccess::Write)
        .await
        .unwrap();
    let DbPool::Sqlite(pool) = &lease.live().sql().unwrap().write_pool else {
        panic!("script harness must use SQLite");
    };
    sqlx::raw_sql(
        "CREATE TABLE parents (id INTEGER PRIMARY KEY);
             CREATE TABLE deferred_children (
               id INTEGER PRIMARY KEY,
               parent_id INTEGER NOT NULL,
               FOREIGN KEY(parent_id) REFERENCES parents(id)
                 DEFERRABLE INITIALLY DEFERRED
             );",
    )
    .execute(pool)
    .await
    .unwrap();
    drop(lease);

    let proposal = harness
        .propose(
            "INSERT INTO deferred_children (id, parent_id) VALUES (1, 999)",
            None,
        )
        .await
        .unwrap();
    harness.approve(&proposal).await;
    let error = match harness.service.run_desktop(proposal.operation_id).await {
        Err(error) => error.into_error(),
        Ok(_) => panic!("deferred foreign-key commit must not report success"),
    };
    assert!(
        matches!(error, AppError::OutcomeUnknown(_)),
        "uncertain script commit must remain visible, got {error}"
    );
    assert_eq!(
        harness
            .operation
            .get(proposal.operation_id)
            .await
            .unwrap()
            .state,
        OperationState::OutcomeUnknown
    );
    harness.close().await;
}

#[tokio::test]
async fn committed_ddl_script_invalidates_schema_cache() {
    let harness = ScriptHarness::new().await;
    harness.configure(true, true).await;
    harness
        .store
        .set_schema_cache(harness.connection_id, r#"{"tables":[]}"#)
        .await
        .unwrap();
    let proposal = harness
        .propose(
            "CREATE TABLE widgets (id INTEGER PRIMARY KEY);\
                 INSERT INTO widgets (id) VALUES (1)",
            None,
        )
        .await
        .unwrap();
    harness.approve(&proposal).await;
    let receipt = harness
        .service
        .run_desktop(proposal.operation_id)
        .await
        .unwrap();
    assert!(receipt.outcome.committed);
    drop(receipt);
    assert_eq!(
        harness
            .store
            .get_schema_cache(harness.connection_id)
            .await
            .unwrap(),
        None
    );
    let (audit, valid, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap();
    assert!(valid);
    assert_eq!(first_bad, None);
    assert!(audit.iter().all(|entry| entry.kind == QueryKind::Ddl));
    harness.close().await;
}

#[tokio::test]
async fn failed_write_script_rolls_back_and_returns_statement_outcomes() {
    let harness = ScriptHarness::new().await;
    harness.configure(true, true).await;
    let proposal = harness
        .propose(
            "UPDATE users SET name = 'Grace' WHERE id = 1;\
                 UPDATE missing_users SET name = 'Ken' WHERE id = 2;\
                 UPDATE users SET name = 'Dennis' WHERE id = 2",
            None,
        )
        .await
        .unwrap();
    harness.approve(&proposal).await;
    let receipt = harness
        .service
        .run_desktop(proposal.operation_id)
        .await
        .unwrap();
    assert!(!receipt.outcome.committed);
    assert_eq!(receipt.outcome.statements.len(), 3);
    assert!(receipt.outcome.statements[0].error.is_none());
    assert!(receipt.outcome.statements[1]
        .error
        .as_deref()
        .is_some_and(|message| message.contains("missing_users")));
    assert_eq!(
        receipt.outcome.statements[2].error.as_deref(),
        Some("skipped — transaction rolled back")
    );
    drop(receipt);
    assert_eq!(harness.user_names().await, ["Ada", "Linus"]);
    assert_eq!(
        harness.audit_actions().await,
        ["script:execute:attempt", "script:execute"]
    );
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
    harness.close().await;
}

#[tokio::test]
async fn write_script_fails_closed_when_attempt_audit_is_unavailable() {
    let harness = ScriptHarness::new().await;
    harness.configure(true, true).await;
    sqlx::raw_sql(
        "CREATE TRIGGER fail_script_attempt
             BEFORE INSERT ON audit_log
             BEGIN
               SELECT RAISE(FAIL, 'forced script attempt audit failure');
             END;",
    )
    .execute(harness.store.pool())
    .await
    .unwrap();
    let proposal = harness
        .propose("UPDATE users SET name = 'Grace' WHERE id = 1", None)
        .await
        .unwrap();
    harness.approve(&proposal).await;
    let error = match harness.service.run_desktop(proposal.operation_id).await {
        Err(error) => error.into_error(),
        Ok(_) => {
            panic!("script must fail before target touch when attempt audit is unavailable")
        }
    };
    assert!(matches!(
        error,
        AppError::Config(message)
            if message.starts_with("audit pre-record failed — refusing to run script:")
                && message.contains("forced script attempt audit failure")
    ));
    assert_eq!(harness.user_names().await, ["Ada", "Linus"]);
    assert!(harness.audit_actions().await.is_empty());
    assert!(harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap()
        .is_empty());
    harness.close().await;
}
