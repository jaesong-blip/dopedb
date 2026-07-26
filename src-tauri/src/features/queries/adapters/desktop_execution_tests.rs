//! Desktop SQL characterization tests.

use super::super::domain::{DesktopSqlProposalRequest, DesktopSqlStreamSinkError};
use super::desktop_contracts::*;
use super::desktop_support::skipped_preview_report;
use super::platform::QueryPlatformAdapter;
use crate::audit;
use crate::connection::{ConnectionAccess, ConnectionManager, DbPool};
use crate::error::AppError;
use crate::model::{PreviewMode, QueryKind};
use crate::operations::{OperationRuntime, OperationState};
use crate::store::Store;
use std::time::Duration;
use uuid::Uuid;
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
    };
    use crate::store::TEST_SCHEMA;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::collections::HashMap;
    use std::str::FromStr;
    use tempfile::TempDir;
    fn profile(id: Uuid, database: String) -> ConnectionProfile {
        ConnectionProfile {
            id,
            name: "query-service-test".into(),
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
    #[test]
    fn desktop_static_preview_reports_keep_exact_legacy_messages() {
        let workspace =
            skipped_preview_report("workspace role is read-only — write preview skipped");
        assert_eq!(workspace.mode, PreviewMode::Skipped);
        assert_eq!(workspace.estimated_rows, None);
        assert_eq!(workspace.exact_rows, None);
        assert_eq!(workspace.plan, None);
        assert_eq!(
            workspace.note.as_deref(),
            Some("workspace role is read-only — write preview skipped")
        );
        let disabled = skipped_preview_report(
            "writes are disabled for this connection — impact preview skipped (no rows locked)",
        );
        assert_eq!(
            disabled.note.as_deref(),
            Some(
                "writes are disabled for this connection — impact preview skipped (no rows locked)"
            )
        );
    }
    struct SqliteHarness {
        service: QueryPlatformAdapter,
        operation: OperationRuntime,
        approval: crate::operations::LocalApprovalAuthority,
        store: Store,
        connections: ConnectionManager,
        connection_id: Uuid,
        profile: ConnectionProfile,
        directory: TempDir,
    }
    impl SqliteHarness {
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
            let directory = tempfile::tempdir().unwrap();
            let target_path = directory.path().join("query-service-target.db");
            let target_options = SqliteConnectOptions::new()
                .filename(&target_path)
                .create_if_missing(true)
                .foreign_keys(true);
            let target_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(target_options)
                .await
                .unwrap();
            sqlx::raw_sql(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                 INSERT INTO users (id, name) VALUES (1, 'Ada'), (2, 'Linus');",
            )
            .execute(&target_pool)
            .await
            .unwrap();
            target_pool.close().await;
            let connection_id = Uuid::new_v4();
            let profile = profile(connection_id, target_path.to_string_lossy().into_owned());
            store.upsert_connection(&profile).await.unwrap();
            let connections = ConnectionManager::new(store.clone());
            let (operation, approval) = OperationRuntime::new(&store);
            let service = QueryPlatformAdapter::new(
                store.clone(),
                connections.clone(),
                operation.clone(),
                super::super::TerminalQueryRunRegistry::default(),
                super::super::DesktopSqlStreamRegistry::default(),
                super::super::DesktopStreamCleanupRuntime::default(),
            );
            Self {
                service,
                operation,
                approval,
                store,
                connections,
                connection_id,
                profile,
                directory,
            }
        }
        async fn close(self) {
            let mutation = self
                .connections
                .begin_connection_mutation(self.connection_id, ConnectionAccess::Read)
                .await
                .unwrap();
            mutation.retire_connection(self.connection_id).await;
            let Self {
                service,
                operation,
                store,
                connections,
                directory,
                ..
            } = self;
            drop(service);
            drop(operation);
            drop(connections);
            store.pool().close().await;
            drop(store);
            directory
                .close()
                .expect("temporary SQLite directory must be removable after pool shutdown");
        }
        async fn propose(
            &self,
            sql: &str,
            origin: Option<&str>,
        ) -> Result<DesktopSqlProposalReceipt, DesktopSqlInspectionError> {
            self.service
                .propose_desktop_sql(DesktopSqlProposalRequest {
                    connection_id: self.connection_id.into(),
                    sql: sql.into(),
                    origin: origin.map(str::to_string),
                })
                .await
        }
        async fn approve(&self, proposal: &DesktopSqlProposalReceipt) {
            self.approve_with_reason(proposal, None).await.unwrap();
        }
        async fn approve_with_reason(
            &self,
            proposal: &DesktopSqlProposalReceipt,
            reason: Option<String>,
        ) -> crate::AppResult<()> {
            let record = self.operation.get(proposal.operation_id.into()).await?;
            if let Some(expected) = crate::operations::required_confirmation(&record) {
                if reason.as_deref() != Some(expected) {
                    return Err(AppError::Blocked {
                        reason: format!(
                            "type the exact confirmation phrase `{expected}` before approving this operation"
                        ),
                    });
                }
            }
            let scope = self.connections.begin_operation_scope().await;
            let pin = scope.pin_connection_for_view(record.connection_id).await?;
            crate::operations::ensure_operation_scope(&record, &pin)?;
            let settings = self.store.get_safety(pin.connection_id).await?;
            let policy = crate::operations::capture_policy(&pin, &settings)?;
            self.operation
                .approve_exact(
                    &self.approval,
                    crate::operations::ExactApprovalRequest {
                        operation_id: record.id,
                        expected_payload_hash: proposal.payload_hash.clone(),
                        approver: crate::operations::approver_for_pin(&pin),
                        current_policy_revision: policy.revision,
                        reason,
                    },
                )
                .await?;
            Ok(())
        }
        async fn user_name(&self, id: i64) -> String {
            let lease = self
                .connections
                .acquire(self.connection_id, ConnectionAccess::Read)
                .await
                .unwrap();
            let live = lease.live().sql().unwrap();
            match live.ro() {
                DbPool::Sqlite(pool) => sqlx::query_scalar("SELECT name FROM users WHERE id = ?")
                    .bind(id)
                    .fetch_one(pool)
                    .await
                    .unwrap(),
                _ => panic!("query-service harness must use SQLite"),
            }
        }
        async fn set_connection_access_for_test(&self, access: &str) {
            sqlx::query(
                "UPDATE connections
                 SET workspace_access = ?2, revision = revision + 1
                 WHERE id = ?1",
            )
            .bind(self.connection_id.to_string())
            .bind(access)
            .execute(self.store.pool())
            .await
            .unwrap();
        }
        async fn enable_writes(&self, require_approval: bool) {
            let mut writable = self.profile.clone();
            writable.allow_writes = true;
            self.store.upsert_connection(&writable).await.unwrap();
            let mut settings = self.store.get_safety(self.connection_id).await.unwrap();
            settings.allow_writes = true;
            settings.require_approval = require_approval;
            self.store
                .set_safety(self.connection_id, &settings)
                .await
                .unwrap();
        }
        async fn audit_actions_in_order(&self) -> Vec<String> {
            let (mut entries, valid, first_bad) = audit::snapshot(&self.store, self.connection_id)
                .await
                .unwrap();
            assert!(valid);
            assert_eq!(first_bad, None);
            entries.reverse();
            entries.into_iter().map(|entry| entry.action).collect()
        }
    }
    #[tokio::test]
    async fn desktop_sql_read_preserves_wire_provenance_and_lease_guard() {
        let harness = SqliteHarness::new().await;
        let proposal = harness
            .propose("SELECT id, name FROM users ORDER BY id", Some("data-view"))
            .await
            .unwrap();
        assert!(!proposal.approval_required);
        assert_eq!(proposal.state, OperationState::Ready);
        let receipt = harness
            .service
            .run_desktop_sql(proposal.operation_id)
            .await
            .unwrap();
        let result = receipt
            .outcome
            .result
            .as_ref()
            .expect("read execution must return a result grid");
        assert_eq!(result.row_count, 2);
        assert_eq!(
            serde_json::to_value(&receipt).unwrap(),
            serde_json::json!({
                "result": {
                    "columns": ["id", "name"],
                    "rows": [[1, "Ada"], [2, "Linus"]],
                    "rowCount": 2,
                    "truncated": false,
                    "durationMs": result.duration_ms
                },
                "affected": null,
                "committed": false
            }),
            "desktop SQL receipt must preserve the literal legacy ExecOutcome wire"
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                harness.connections.begin_scope_mutation(),
            )
            .await
            .is_err(),
            "desktop SQL receipt must retain the live lease through serialization"
        );
        let history = harness
            .store
            .list_history(harness.connection_id)
            .await
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, "ok");
        assert_eq!(history[0].kind, QueryKind::Read);
        assert_eq!(history[0].row_count, Some(2));
        assert_eq!(history[0].origin, "data-view");
        let (audit, valid, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
            .await
            .unwrap();
        assert!(valid);
        assert_eq!(first_bad, None);
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].action, "read");
        assert_eq!(audit[0].affected_estimate, Some(2));
        drop(receipt);
        let mutation = tokio::time::timeout(
            Duration::from_secs(5),
            harness.connections.begin_scope_mutation(),
        )
        .await
        .expect("scope writer must proceed after desktop SQL receipt drop");
        drop(mutation);
        harness.close().await;
    }
    #[tokio::test]
    async fn desktop_sql_write_gate_rejects_before_persist_or_target_touch() {
        let harness = SqliteHarness::new().await;
        let error = match harness
            .propose("UPDATE users SET name = 'Grace' WHERE id = 1", None)
            .await
        {
            Err(error) => error.into_error(),
            _ => panic!("writes-disabled policy must reject before target touch"),
        };
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "kind": "blocked",
                "message": "blocked: writing is disabled for this connection (writes are off by default). Enable writes in the connection's safety settings to propose it."
            })
        );
        assert_eq!(harness.user_name(1).await, "Ada");
        assert!(harness.audit_actions_in_order().await.is_empty());
        assert!(harness
            .store
            .list_history(harness.connection_id)
            .await
            .unwrap()
            .is_empty());
        harness.close().await;
    }
    #[tokio::test]
    async fn desktop_arbitrary_privilege_sql_is_blocked_before_persistence() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(false).await;
        let error = match harness
            .propose("GRANT SELECT ON users TO analyst", None)
            .await
        {
            Err(error) => error.into_error(),
            Ok(_) => panic!("arbitrary privilege SQL must not become an operation"),
        };
        assert!(matches!(
            error,
            AppError::Blocked { ref reason } if reason.contains("arbitrary privilege SQL")
        ));
        assert!(harness.audit_actions_in_order().await.is_empty());
        harness.close().await;
    }
    #[tokio::test]
    async fn desktop_sql_workspace_view_role_blocks_without_audit_or_target_touch() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(true).await;
        harness.set_connection_access_for_test("view").await;
        let error = match harness
            .propose("UPDATE users SET name = 'Grace' WHERE id = 1", None)
            .await
        {
            Err(error) => error.into_error(),
            Ok(_) => panic!("workspace read role must reject mutations"),
        };
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "kind": "blocked",
                "message": "blocked: your workspace role grants read-only database access"
            })
        );
        harness.set_connection_access_for_test("local").await;
        assert_eq!(harness.user_name(1).await, "Ada");
        assert!(harness.audit_actions_in_order().await.is_empty());
        assert!(harness
            .store
            .list_history(harness.connection_id)
            .await
            .unwrap()
            .is_empty());
        harness.close().await;
    }
    #[tokio::test]
    async fn desktop_sql_exact_approval_commits_and_records_both_ledgers() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(true).await;
        let sql = "UPDATE users SET name = 'Grace' WHERE id = 1";
        let proposal = harness.propose(sql, Some("sql")).await.unwrap();
        assert!(proposal.approval_required);
        assert_eq!(proposal.state, OperationState::PendingApproval);

        let rejected = match harness.service.run_desktop_sql(proposal.operation_id).await {
            Err(error) => error.into_error(),
            Ok(_) => panic!("a write without its exact approval must remain blocked"),
        };
        assert!(matches!(rejected, AppError::Blocked { .. }));

        harness.approve(&proposal).await;
        let receipt = harness
            .service
            .run_desktop_sql(proposal.operation_id)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&receipt).unwrap(),
            serde_json::json!({
                "result": null,
                "affected": 1,
                "committed": true
            })
        );
        drop(receipt);
        assert_eq!(harness.user_name(1).await, "Grace");
        assert_eq!(
            harness.audit_actions_in_order().await,
            ["execute:attempt", "execute"]
        );
        let history = harness
            .store
            .list_history(harness.connection_id)
            .await
            .unwrap();
        assert_eq!(history.len(), 1);
        assert!(history.iter().any(|entry| {
            entry.status == "ok"
                && entry.origin == "sql"
                && entry.kind == QueryKind::Write
                && entry.row_count == Some(1)
        }));
        harness.close().await;
    }

    #[tokio::test]
    async fn unacknowledged_target_commit_becomes_outcome_unknown_without_retry() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(true).await;
        let lease = harness
            .connections
            .acquire(harness.connection_id, ConnectionAccess::Write)
            .await
            .unwrap();
        let DbPool::Sqlite(pool) = &lease.live().sql().unwrap().write_pool else {
            panic!("query-service harness must use SQLite");
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
        let error = match harness.service.run_desktop_sql(proposal.operation_id).await {
            Err(error) => error.into_error(),
            Ok(_) => panic!("deferred foreign-key commit must not report success"),
        };
        assert!(
            matches!(error, AppError::OutcomeUnknown(_)),
            "commit acknowledgement failure must be explicit, got {error}"
        );
        assert_eq!(
            harness
                .service
                .operation
                .get(proposal.operation_id.into())
                .await
                .unwrap()
                .state,
            OperationState::OutcomeUnknown
        );
        assert!(harness
            .service
            .operation
            .claim(proposal.operation_id.into())
            .await
            .is_err());
        harness.close().await;
    }

    #[tokio::test]
    async fn critical_write_requires_the_exact_typed_confirmation() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(true).await;
        let proposal = harness.propose("DELETE FROM users", None).await.unwrap();
        assert_eq!(
            proposal.confirmation_phrase.as_deref(),
            Some(crate::operations::CRITICAL_CONFIRMATION)
        );
        let missing = harness.approve_with_reason(&proposal, None).await;
        assert!(matches!(missing, Err(AppError::Blocked { .. })));
        harness
            .approve_with_reason(&proposal, proposal.confirmation_phrase.clone())
            .await
            .unwrap();
        let receipt = harness
            .service
            .run_desktop_sql(proposal.operation_id)
            .await
            .unwrap();
        drop(receipt);
        assert_eq!(
            harness
                .service
                .operation
                .get(proposal.operation_id.into())
                .await
                .unwrap()
                .state,
            OperationState::Succeeded
        );
        harness.close().await;
    }

    #[tokio::test]
    async fn production_write_requires_production_confirmation() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(true).await;
        let mut production = harness.profile.clone();
        production.allow_writes = true;
        production.env = Some("prod".into());
        harness.store.upsert_connection(&production).await.unwrap();

        let proposal = harness
            .propose("UPDATE users SET name = 'Grace' WHERE id = 1", None)
            .await
            .unwrap();
        assert_eq!(
            proposal.confirmation_phrase.as_deref(),
            Some(crate::operations::PRODUCTION_CONFIRMATION)
        );
        let wrong = harness
            .approve_with_reason(&proposal, Some("prod".into()))
            .await;
        assert!(matches!(wrong, Err(AppError::Blocked { .. })));
        harness
            .approve_with_reason(&proposal, proposal.confirmation_phrase.clone())
            .await
            .unwrap();
        let receipt = harness
            .service
            .run_desktop_sql(proposal.operation_id)
            .await
            .unwrap();
        drop(receipt);
        assert_eq!(harness.user_name(1).await, "Grace");
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_sql_write_always_requires_exact_approval_when_legacy_prompt_is_off() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(false).await;
        let proposal = harness
            .propose("UPDATE users SET name = 'Grace' WHERE id = 1", None)
            .await
            .unwrap();
        assert!(proposal.approval_required);
        assert!(harness
            .service
            .run_desktop_sql(proposal.operation_id)
            .await
            .is_err());
        harness.approve(&proposal).await;
        let receipt = harness
            .service
            .run_desktop_sql(proposal.operation_id)
            .await
            .unwrap();
        assert!(receipt.outcome.committed);
        drop(receipt);
        assert_eq!(harness.user_name(1).await, "Grace");
        assert_eq!(
            harness.audit_actions_in_order().await,
            ["execute:attempt", "execute"]
        );
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_sql_write_fails_closed_when_attempt_audit_is_unavailable() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(true).await;
        sqlx::raw_sql(
            "CREATE TRIGGER fail_desktop_write_attempt
             BEFORE INSERT ON audit_log
             BEGIN
               SELECT RAISE(FAIL, 'forced desktop attempt audit failure');
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
        let error = match harness.service.run_desktop_sql(proposal.operation_id).await {
            Err(error) => error.into_error(),
            Ok(_) => panic!("write must fail closed before target touch"),
        };
        assert!(matches!(
            error,
            AppError::Config(message)
                if message.starts_with("audit pre-record failed — refusing to run write:")
                    && message.contains("forced desktop attempt audit failure")
        ));
        assert_eq!(harness.user_name(1).await, "Ada");
        assert!(audit::snapshot(&harness.store, harness.connection_id)
            .await
            .unwrap()
            .0
            .is_empty());
        assert!(harness
            .store
            .list_history(harness.connection_id)
            .await
            .unwrap()
            .is_empty());
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_sql_execution_failure_closes_the_attempt_and_keeps_original_error() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(true).await;
        let proposal = harness
            .propose("UPDATE users SET name = 'Grace' WHERE id = 1", None)
            .await
            .unwrap();
        harness.approve(&proposal).await;
        let target = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&harness.profile.database)
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        sqlx::raw_sql("DROP TABLE users")
            .execute(&target)
            .await
            .unwrap();
        target.close().await;
        let failure = match harness.service.run_desktop_sql(proposal.operation_id).await {
            Err(DesktopSqlRunError::Execution(failure)) => failure,
            _ => panic!("missing target table must fail during desktop execution"),
        };
        let original = failure.error.to_string();
        assert!(original.contains("users"));
        assert!(!original.contains("audit"));
        let mapped = failure.into_error();
        assert_eq!(mapped.to_string(), original);
        assert_eq!(
            harness.audit_actions_in_order().await,
            ["execute:attempt", "error"]
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
            .is_some_and(|message| message.contains("users")));
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_sql_committed_ddl_invalidates_the_legacy_schema_cache() {
        let harness = SqliteHarness::new().await;
        harness.enable_writes(true).await;
        harness
            .store
            .set_schema_cache(harness.connection_id, r#"{"tables":[]}"#)
            .await
            .unwrap();
        assert!(harness
            .store
            .get_schema_cache(harness.connection_id)
            .await
            .unwrap()
            .is_some());

        let proposal = harness
            .propose("CREATE TABLE widgets (id INTEGER PRIMARY KEY)", None)
            .await
            .unwrap();
        harness.approve(&proposal).await;
        let receipt = harness
            .service
            .run_desktop_sql(proposal.operation_id)
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
        harness.close().await;
    }

    mod streaming;
}
