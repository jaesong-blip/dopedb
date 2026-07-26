//! Desktop SQL characterization tests.

#[cfg(test)]
use std::time::Duration;

#[cfg(test)]
use uuid::Uuid;

#[cfg(test)]
use crate::connection::{ConnectionAccess, ConnectionManager, DbPool};
#[cfg(test)]
use crate::error::AppError;
#[cfg(test)]
use crate::kernel::TerminalAuthority;
#[cfg(test)]
use crate::model::{Classification, PreviewMode, QueryKind, SafetySettings};
#[cfg(test)]
use crate::operations::OperationRuntime;
#[cfg(test)]
use crate::store::Store;

#[cfg(test)]
use super::super::domain::{
    DesktopSqlClassificationRequest, DesktopSqlPreviewRequest, TerminalSqlProposalRequest,
};
#[cfg(test)]
use super::desktop_support::{desktop_preview_connection_access, skipped_preview_report};
#[cfg(test)]
use super::platform::QueryPlatformAdapter;

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::str::FromStr;

    use super::*;
    use crate::kernel::identity::AccountScopeId;
    use crate::model::{
        ConnectionProfile, Engine, Provider, RiskLevel, WorkspaceConnectionAccess,
        WorkspaceCredentialMode,
    };
    use crate::store::TEST_SCHEMA;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
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

    fn classification(kind: QueryKind, rollback_safe: bool) -> Classification {
        Classification {
            kind,
            risk: RiskLevel::Low,
            statement_count: 1,
            no_where: false,
            tables: vec![],
            notes: vec![],
            rollback_safe,
        }
    }

    #[test]
    fn desktop_preview_access_is_always_read_only_before_exact_approval() {
        let settings = SafetySettings {
            allow_writes: true,
            explain_preview: true,
            ..SafetySettings::default()
        };

        for classification in [
            classification(QueryKind::Read, false),
            classification(QueryKind::Write, true),
            classification(QueryKind::Write, false),
            classification(QueryKind::Ddl, false),
            classification(QueryKind::Privilege, false),
        ] {
            assert_eq!(
                desktop_preview_connection_access(&classification, &settings),
                ConnectionAccess::Read
            );
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
            let (operation, _) = OperationRuntime::new(&store);
            let service = QueryPlatformAdapter::new(
                store.clone(),
                connections.clone(),
                operation,
                super::super::TerminalQueryRunRegistry::default(),
            );
            Self {
                service,
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
                store,
                connections,
                directory,
                ..
            } = self;
            drop(service);
            drop(connections);
            store.pool().close().await;
            drop(store);
            directory
                .close()
                .expect("temporary SQLite directory must be removable after pool shutdown");
        }

        async fn terminal_authority(&self) -> TerminalAuthority {
            let context = self
                .connections
                .pin(self.connection_id, ConnectionAccess::Read)
                .await
                .unwrap();
            let pin = context.pin();
            let account_scope = AccountScopeId::new(pin.scope.account_scope.storage_key()).unwrap();
            TerminalAuthority {
                terminal_session_id: Uuid::new_v4().into(),
                workspace_id: pin.scope.workspace_id.into(),
                account_scope,
                scope_generation: pin.scope.generation,
                connection_id: pin.connection_id.into(),
                connection_revision: pin.connection_revision,
                client_protocol_version: dopedb_protocol::PROTOCOL_MAX,
            }
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
    }

    #[tokio::test]
    async fn terminal_sql_proposal_rejects_reselected_scope_before_target_access() {
        let harness = SqliteHarness::new().await;
        let mut authority = harness.terminal_authority().await;
        authority.scope_generation += 1;

        let error = match harness
            .service
            .propose_terminal_sql(TerminalSqlProposalRequest {
                connection_id: harness.connection_id.into(),
                sql: "SELECT id FROM users".into(),
                authority,
            })
            .await
        {
            Err(error) => error.into_error(),
            Ok(_) => panic!("a stale Terminal authority must fail before target proposal"),
        };
        assert!(matches!(
            error,
            AppError::Blocked { ref reason }
                if reason == "Terminal connection authority is no longer current"
        ));
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_classification_is_view_capable_and_holds_scope_through_serialization() {
        let harness = SqliteHarness::new().await;
        harness.set_connection_access_for_test("view").await;

        let receipt = harness
            .service
            .classify_desktop_sql(DesktopSqlClassificationRequest {
                connection_id: harness.connection_id.into(),
                sql: "SELECT id FROM users".into(),
            })
            .await
            .unwrap();
        assert_eq!(receipt.classification.kind, QueryKind::Read);
        let serialized = serde_json::to_value(&receipt).unwrap();
        assert_eq!(
            serialized,
            serde_json::json!({
                "kind": "read",
                "risk": "low",
                "statementCount": 1,
                "noWhere": false,
                "tables": ["users"],
                "notes": [],
                "rollbackSafe": false
            }),
            "desktop classification must retain the literal legacy wire contract"
        );
        assert_eq!(
            serialized,
            serde_json::to_value(&receipt.classification).unwrap(),
            "receipt serialization must preserve the legacy Classification shape"
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                harness.connections.begin_scope_mutation(),
            )
            .await
            .is_err(),
            "classification receipt must retain the scope guard through serialization"
        );
        drop(receipt);
        let mutation = tokio::time::timeout(
            Duration::from_secs(5),
            harness.connections.begin_scope_mutation(),
        )
        .await
        .expect("scope writer must proceed after classification receipt drop");
        drop(mutation);

        harness.set_connection_access_for_test("local").await;
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_preview_preserves_viewer_gate_order_and_exact_messages() {
        let harness = SqliteHarness::new().await;
        harness.set_connection_access_for_test("view").await;

        let write_receipt = harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "UPDATE users SET name = 'Grace' WHERE id = 1".into(),
            })
            .await
            .unwrap();
        assert_eq!(write_receipt.report.mode, PreviewMode::Skipped);
        assert_eq!(
            write_receipt.report.note.as_deref(),
            Some("workspace role is read-only — write preview skipped")
        );
        assert_eq!(
            serde_json::to_value(&write_receipt).unwrap(),
            serde_json::json!({
                "mode": "skipped",
                "estimatedRows": null,
                "exactRows": null,
                "plan": null,
                "note": "workspace role is read-only — write preview skipped"
            }),
            "desktop preview must retain the literal legacy wire contract"
        );
        drop(write_receipt);

        let read_error = match harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "SELECT id FROM users".into(),
            })
            .await
        {
            Err(error) => error.into_error(),
            Ok(_) => panic!("viewer read preview must fail at target authorization"),
        };
        assert_eq!(
            serde_json::to_value(&read_error).unwrap(),
            serde_json::json!({
                "kind": "blocked",
                "message": "blocked: workspace role cannot execute this connection"
            }),
            "desktop preview errors must retain the literal legacy AppError wire contract"
        );
        assert!(matches!(
            read_error,
            AppError::Blocked { reason }
                if reason == "workspace role cannot execute this connection"
        ));

        harness.set_connection_access_for_test("local").await;
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_preconnection_skips_do_not_open_the_target_database() {
        let harness = SqliteHarness::new().await;
        let invalid_database = harness
            .directory
            .path()
            .join("missing-parent")
            .join("target.db")
            .to_string_lossy()
            .into_owned();

        let mut writes_disabled = harness.profile.clone();
        writes_disabled.database = invalid_database.clone();
        writes_disabled.allow_writes = true;
        harness
            .store
            .upsert_connection(&writes_disabled)
            .await
            .unwrap();
        let mut settings = harness
            .store
            .get_safety(harness.connection_id)
            .await
            .unwrap();
        settings.allow_writes = false;
        harness
            .store
            .set_safety(harness.connection_id, &settings)
            .await
            .unwrap();

        let disabled_receipt = harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "DELETE FROM users WHERE id = 1".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            disabled_receipt.report.note.as_deref(),
            Some(
                "writes are disabled for this connection — impact preview skipped (no rows locked)"
            )
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                harness.connections.begin_scope_mutation(),
            )
            .await
            .is_err(),
            "pre-connection skipped receipt must retain its scope guard through serialization"
        );
        drop(disabled_receipt);
        let mutation = tokio::time::timeout(
            Duration::from_secs(5),
            harness.connections.begin_scope_mutation(),
        )
        .await
        .expect("scope writer must proceed after skipped preview receipt drop");
        drop(mutation);

        harness.set_connection_access_for_test("view").await;
        settings.allow_writes = true;
        harness
            .store
            .set_safety(harness.connection_id, &settings)
            .await
            .unwrap();
        let readonly_receipt = harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "DELETE FROM users WHERE id = 1".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            readonly_receipt.report.note.as_deref(),
            Some("workspace role is read-only — write preview skipped")
        );
        drop(readonly_receipt);

        harness.set_connection_access_for_test("local").await;
        harness
            .store
            .upsert_connection(&harness.profile)
            .await
            .unwrap();
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_read_preview_preserves_wire_shape_and_lease_guard() {
        let harness = SqliteHarness::new().await;
        let receipt = harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "SELECT id, name FROM users ORDER BY id".into(),
            })
            .await
            .unwrap();
        assert_eq!(receipt.report.mode, PreviewMode::Explain);
        assert_eq!(
            serde_json::to_value(&receipt).unwrap(),
            serde_json::to_value(&receipt.report).unwrap(),
            "receipt serialization must preserve the legacy PreviewReport shape"
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                harness.connections.begin_scope_mutation(),
            )
            .await
            .is_err(),
            "preview receipt must retain the live lease through serialization"
        );
        drop(receipt);
        let mutation = tokio::time::timeout(
            Duration::from_secs(5),
            harness.connections.begin_scope_mutation(),
        )
        .await
        .expect("scope writer must proceed after preview receipt drop");
        drop(mutation);
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_preview_receipt_serializes_safety_mutation_until_drop() {
        let harness = SqliteHarness::new().await;
        let receipt = harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "SELECT id FROM users".into(),
            })
            .await
            .unwrap();

        let mut updated = harness
            .store
            .get_safety(harness.connection_id)
            .await
            .unwrap();
        assert_eq!(updated.max_rows, 1000);
        updated.max_rows = 77;

        let store = harness.store.clone();
        let connections = harness.connections.clone();
        let connection_id = harness.connection_id;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let mut updater = tokio::spawn(async move {
            started_tx
                .send(())
                .expect("test must observe safety mutation start");
            let _mutation = connections
                .begin_connection_mutation(connection_id, ConnectionAccess::Read)
                .await
                .unwrap();
            store.set_safety(connection_id, &updated).await.unwrap();
        });
        started_rx
            .await
            .expect("safety mutation task must reach the scope writer");

        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut updater)
                .await
                .is_err(),
            "safety mutation must wait while the preview receipt retains its authority"
        );
        assert_eq!(
            harness
                .store
                .get_safety(harness.connection_id)
                .await
                .unwrap()
                .max_rows,
            1000,
            "waiting mutation must not publish settings early"
        );

        drop(receipt);
        tokio::time::timeout(Duration::from_secs(5), updater)
            .await
            .expect("safety mutation must proceed after preview receipt drop")
            .expect("safety mutation task must succeed");
        assert_eq!(
            harness
                .store
                .get_safety(harness.connection_id)
                .await
                .unwrap()
                .max_rows,
            77
        );
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_write_preview_disabled_is_read_authorized_and_explain_only() {
        let harness = SqliteHarness::new().await;
        let mut settings = harness
            .store
            .get_safety(harness.connection_id)
            .await
            .unwrap();
        settings.allow_writes = true;
        settings.explain_preview = false;
        harness
            .store
            .set_safety(harness.connection_id, &settings)
            .await
            .unwrap();

        // The profile write gate remains false. Success therefore proves that this
        // branch requested Read access and never entered execute+rollback.
        assert!(!harness.profile.allow_writes);
        let receipt = harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "UPDATE users SET name = 'Grace' WHERE id = 1".into(),
            })
            .await
            .unwrap();
        assert_eq!(receipt.report.mode, PreviewMode::Explain);
        assert_eq!(receipt.report.exact_rows, None);
        drop(receipt);
        assert_eq!(harness.user_name(1).await, "Ada");
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_write_preview_never_executes_before_exact_approval() {
        let harness = SqliteHarness::new().await;
        let mut settings = harness
            .store
            .get_safety(harness.connection_id)
            .await
            .unwrap();
        settings.allow_writes = true;
        settings.explain_preview = true;
        harness
            .store
            .set_safety(harness.connection_id, &settings)
            .await
            .unwrap();

        let receipt = harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "UPDATE users SET name = 'Grace' WHERE id = 1".into(),
            })
            .await
            .unwrap();
        assert_eq!(receipt.report.mode, PreviewMode::Explain);
        assert_eq!(receipt.report.exact_rows, None);
        assert!(receipt
            .report
            .note
            .as_deref()
            .is_some_and(|note| note.contains("no target-mutating statement was executed")));
        drop(receipt);
        assert_eq!(harness.user_name(1).await, "Ada");
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_nonrollback_write_preview_uses_read_authority_only() {
        let harness = SqliteHarness::new().await;
        let mut settings = harness
            .store
            .get_safety(harness.connection_id)
            .await
            .unwrap();
        settings.allow_writes = true;
        settings.explain_preview = true;
        harness
            .store
            .set_safety(harness.connection_id, &settings)
            .await
            .unwrap();

        let receipt = harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "this is not sql".into(),
            })
            .await
            .unwrap();
        assert_eq!(receipt.report.mode, PreviewMode::Explain);
        assert_eq!(receipt.report.exact_rows, None);
        drop(receipt);
        assert_eq!(harness.user_name(1).await, "Ada");
        harness.close().await;
    }

    #[tokio::test]
    async fn desktop_ddl_preview_skips_before_opening_the_target() {
        let harness = SqliteHarness::new().await;
        let mut invalid = harness.profile.clone();
        invalid.database = harness
            .directory
            .path()
            .join("missing-parent")
            .join("target.db")
            .to_string_lossy()
            .into_owned();
        harness.store.upsert_connection(&invalid).await.unwrap();

        let mut settings = harness
            .store
            .get_safety(harness.connection_id)
            .await
            .unwrap();
        settings.allow_writes = true;
        harness
            .store
            .set_safety(harness.connection_id, &settings)
            .await
            .unwrap();

        let receipt = harness
            .service
            .preview_desktop_sql(DesktopSqlPreviewRequest {
                connection_id: harness.connection_id.into(),
                sql: "CREATE TABLE preview_only (id INTEGER PRIMARY KEY)".into(),
            })
            .await
            .unwrap();
        assert_eq!(receipt.report.mode, PreviewMode::Skipped);
        assert_eq!(
            receipt.report.note.as_deref(),
            Some("DDL / privilege change — no row-count preview; review the statement directly.")
        );
        drop(receipt);
        harness.close().await;
    }
}
