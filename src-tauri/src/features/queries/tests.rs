//! Characterization coverage for Terminal query plans, claims, and durable runs.

use std::collections::HashMap;
use std::str::FromStr;
use std::time::{Duration, Instant};

use crate::audit;
use crate::connection::{ConnectionAccess, ConnectionManager};
use crate::error::AppError;
use crate::kernel::agent_policy::QUERY_PLAN_TTL;
use crate::kernel::identity::{AccountScopeId, OperationId};
use crate::kernel::TerminalAuthority;
use crate::model::{
    ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};
use crate::operations::{OperationRuntime, OperationState};
use crate::store::{Store, TEST_SCHEMA};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tempfile::TempDir;
use uuid::Uuid;

use super::adapters::SeedQueryPlanForTest;
use super::{
    compose_with_adapter, AgentQueryPlanError, AgentQueryRunError, AgentQueryRunPrepareError,
    TerminalQueryAdapter, TerminalQueryPlanRequest,
};

fn profile(id: Uuid, database: String) -> ConnectionProfile {
    ConnectionProfile {
        id,
        name: "query-feature-test".into(),
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

struct SqliteHarness {
    queries: super::QueriesFeature,
    adapter: TerminalQueryAdapter,
    operation: OperationRuntime,
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
        let target_path = directory.path().join("query-feature-target.db");
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
        let (queries, adapter) =
            compose_with_adapter(store.clone(), connections.clone(), operation.clone());
        Self {
            queries,
            adapter,
            operation,
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
            queries,
            adapter,
            operation,
            store,
            connections,
            directory,
            ..
        } = self;
        drop(queries);
        drop(adapter);
        drop(operation);
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

    async fn seed_plan(
        &self,
        authority: &TerminalAuthority,
        plan_id: OperationId,
        sql: &str,
        created_at: Instant,
    ) {
        self.seed_plan_with_actor(authority, plan_id, sql, created_at, None)
            .await;
    }

    async fn seed_plan_with_actor(
        &self,
        authority: &TerminalAuthority,
        plan_id: OperationId,
        sql: &str,
        created_at: Instant,
        actor_id: Option<String>,
    ) {
        let pin = self
            .store
            .pin_connection_for_read(self.connection_id)
            .await
            .unwrap();
        self.adapter
            .seed_plan_for_test(
                &pin,
                authority,
                SeedQueryPlanForTest {
                    plan_id,
                    sql: sql.into(),
                    max_rows: 1,
                    decision: "ready".into(),
                    created_at,
                    actor_id,
                },
            )
            .await;
    }
}

#[tokio::test]
async fn cli_origin_separates_audit_but_keeps_dashboard_eligible_history() {
    let harness = SqliteHarness::new().await;
    let authority = harness.terminal_authority().await;
    let plan_receipt = harness
        .queries
        .plan_terminal_read(TerminalQueryPlanRequest {
            connection_id: harness.connection_id.into(),
            sql: "SELECT id FROM users ORDER BY id".into(),
            max_rows: Some(1),
            authority: authority.clone(),
        })
        .await
        .unwrap();
    let plan_id = plan_receipt.plan().plan_id;
    drop(plan_receipt);
    let run_receipt = harness
        .queries
        .prepare_terminal_run(plan_id, &authority)
        .await
        .unwrap()
        .execute()
        .await
        .unwrap();
    let query_run_id = run_receipt.run().query_run_id;
    drop(run_receipt);

    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id, Uuid::from(query_run_id));
    assert_eq!(history[0].origin, "agent");

    let (mut audit, chain_ok, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap();
    assert!(chain_ok);
    assert_eq!(first_bad, None);
    audit.reverse();
    assert_eq!(
        audit
            .iter()
            .map(|entry| entry.action.as_str())
            .collect::<Vec<_>>(),
        ["cli:plan_query", "cli:run_query"]
    );
    harness.close().await;
}

#[tokio::test]
async fn terminal_sql_preview_rejects_reselected_scope_before_target_access() {
    let harness = SqliteHarness::new().await;
    let mut authority = harness.terminal_authority().await;
    authority.scope_generation += 1;

    let error = match harness
        .queries
        .plan_terminal_read(TerminalQueryPlanRequest {
            connection_id: harness.connection_id.into(),
            sql: "SELECT id FROM users".into(),
            max_rows: Some(1),
            authority,
        })
        .await
    {
        Err(AgentQueryPlanError::Application(error)) => error,
        _ => panic!("a stale Terminal authority must fail before target preview"),
    };
    assert!(matches!(
        error,
        AppError::Blocked { ref reason }
            if reason == "Terminal connection authority is no longer current"
    ));
    harness.close().await;
}

#[tokio::test]
async fn terminal_cancel_registered_at_claim_is_not_lost_before_execution() {
    let harness = SqliteHarness::new().await;
    let authority = harness.terminal_authority().await;
    let plan_receipt = harness
        .queries
        .plan_terminal_read(TerminalQueryPlanRequest {
            connection_id: harness.connection_id.into(),
            sql: "SELECT id FROM users ORDER BY id".into(),
            max_rows: Some(1),
            authority: authority.clone(),
        })
        .await
        .unwrap();
    let plan_id = plan_receipt.plan().plan_id;
    drop(plan_receipt);

    let prepared = harness
        .queries
        .prepare_terminal_run(plan_id, &authority)
        .await
        .unwrap();
    assert_eq!(
        harness.operation.get(plan_id.into()).await.unwrap().state,
        OperationState::Executing
    );
    crate::executor::cancel::cancel(plan_id.into());

    let error = match prepared.execute().await {
        Err(error) => error,
        Ok(_) => panic!("a pre-signalled Terminal query must not reach a successful result"),
    };
    assert!(matches!(
        error,
        AgentQueryRunError::Execution(ref failure)
            if matches!(
                failure.error(),
                AppError::Safety(reason) if reason == "query cancelled"
            )
    ));
    drop(error);
    assert_eq!(
        harness.operation.get(plan_id.into()).await.unwrap().state,
        OperationState::Cancelled
    );
    harness.close().await;
}

#[tokio::test]
async fn service_clones_claim_one_durable_operation() {
    let harness = SqliteHarness::new().await;
    let other_transport = harness.queries.clone();
    let authority = harness.terminal_authority().await;
    let receipt = harness
        .queries
        .plan_terminal_read(TerminalQueryPlanRequest {
            connection_id: harness.connection_id.into(),
            sql: "SELECT 1".into(),
            max_rows: Some(1),
            authority: authority.clone(),
        })
        .await
        .unwrap();
    let plan_id = receipt.plan().plan_id;
    drop(receipt);

    let prepared = other_transport
        .prepare_terminal_run(plan_id, &authority)
        .await
        .unwrap();
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(plan_id, &authority)
            .await,
        Err(AgentQueryRunPrepareError::UnknownOrAlreadyUsed)
    ));
    drop(prepared);
    harness.close().await;
}

#[tokio::test]
async fn execution_failure_keeps_single_use_and_persists_best_effort_history() {
    let harness = SqliteHarness::new().await;
    let authority = harness.terminal_authority().await;
    let plan_id = OperationId::from(Uuid::new_v4());
    harness
        .seed_plan(
            &authority,
            plan_id,
            "SELECT no_such_function()",
            Instant::now(),
        )
        .await;
    let prepared = harness
        .queries
        .prepare_terminal_run(plan_id, &authority)
        .await
        .unwrap();
    let failure = match prepared.execute().await {
        Err(AgentQueryRunError::Execution(failure)) => failure,
        _ => panic!("invalid SQLite function must fail during execution"),
    };
    assert!(!failure.error().to_string().is_empty());
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(plan_id, &authority)
            .await,
        Err(AgentQueryRunPrepareError::UnknownOrAlreadyUsed)
    ));
    drop(failure);

    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, "error");
    assert!(history[0].error.is_some());
    harness.close().await;
}

#[tokio::test]
async fn successful_read_without_consent_history_returns_no_rows_and_consumes_plan() {
    let harness = SqliteHarness::new().await;
    let authority = harness.terminal_authority().await;
    let receipt = harness
        .queries
        .plan_terminal_read(TerminalQueryPlanRequest {
            connection_id: harness.connection_id.into(),
            sql: "SELECT id, name FROM users ORDER BY id".into(),
            max_rows: Some(2),
            authority: authority.clone(),
        })
        .await
        .unwrap();
    let plan_id = receipt.plan().plan_id;
    drop(receipt);
    let prepared = harness
        .queries
        .prepare_terminal_run(plan_id, &authority)
        .await
        .unwrap();

    sqlx::raw_sql(
        "CREATE TRIGGER fail_success_query_history
         BEFORE INSERT ON query_history
         WHEN NEW.status = 'ok'
         BEGIN
           SELECT RAISE(FAIL, 'forced success history failure');
         END;",
    )
    .execute(harness.store.pool())
    .await
    .unwrap();

    let failure = match prepared.execute().await {
        Err(AgentQueryRunError::ProvenancePersistence(failure)) => failure,
        _ => panic!("a successful read without durable provenance must fail closed"),
    };
    let debug = format!("{failure:?}");
    assert!(debug.contains("forced success history failure"));
    assert!(!debug.contains("Ada"));
    assert!(!debug.contains("Linus"));
    assert!(!debug.contains("\"rows\""));
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(plan_id, &authority)
            .await,
        Err(AgentQueryRunPrepareError::UnknownOrAlreadyUsed)
    ));
    let _ = failure.into_error();
    assert!(harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap()
        .is_empty());
    harness.close().await;
}

#[tokio::test]
async fn audit_and_failed_history_outages_do_not_mask_execution_error() {
    let harness = SqliteHarness::new().await;
    let authority = harness.terminal_authority().await;
    sqlx::raw_sql(
        "CREATE TRIGGER fail_query_audit
         BEFORE INSERT ON audit_log
         BEGIN
           SELECT RAISE(FAIL, 'forced audit failure');
         END;
         CREATE TRIGGER fail_error_query_history
         BEFORE INSERT ON query_history
         WHEN NEW.status = 'error'
         BEGIN
           SELECT RAISE(FAIL, 'forced failed-history failure');
         END;",
    )
    .execute(harness.store.pool())
    .await
    .unwrap();

    let plan_id = OperationId::from(Uuid::new_v4());
    harness
        .seed_plan(
            &authority,
            plan_id,
            "SELECT no_such_function()",
            Instant::now(),
        )
        .await;
    let prepared = harness
        .queries
        .prepare_terminal_run(plan_id, &authority)
        .await
        .unwrap();
    let failure = match prepared.execute().await {
        Err(AgentQueryRunError::Execution(failure)) => failure,
        _ => panic!("the original target-database execution must remain the error"),
    };
    let original = failure.error().to_string();
    assert!(original.contains("no_such_function"));
    assert!(!original.contains("forced audit failure"));
    assert!(!original.contains("forced failed-history failure"));
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(plan_id, &authority)
            .await,
        Err(AgentQueryRunPrepareError::UnknownOrAlreadyUsed)
    ));
    drop(failure);

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
async fn plan_and_run_receipts_hold_scope_writer_until_adapter_drop() {
    let harness = SqliteHarness::new().await;
    let authority = harness.terminal_authority().await;
    let plan_receipt = harness
        .queries
        .plan_terminal_read(TerminalQueryPlanRequest {
            connection_id: harness.connection_id.into(),
            sql: "SELECT id FROM users ORDER BY id".into(),
            max_rows: Some(1),
            authority: authority.clone(),
        })
        .await
        .unwrap();
    let plan_id = plan_receipt.plan().plan_id;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            harness.connections.begin_scope_mutation(),
        )
        .await
        .is_err(),
        "plan receipt must retain the scope read guard through adapter emission"
    );
    assert_eq!(plan_receipt.plan().plan_id, plan_id);
    drop(plan_receipt);
    let mutation = tokio::time::timeout(
        Duration::from_secs(5),
        harness.connections.begin_scope_mutation(),
    )
    .await
    .expect("scope writer must proceed after the plan receipt drops");
    drop(mutation);

    let prepared = harness
        .queries
        .prepare_terminal_run(plan_id, &authority)
        .await
        .unwrap();
    let run_receipt = prepared.execute().await.unwrap();
    let query_run_id = run_receipt.run().query_run_id;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            harness.connections.begin_scope_mutation(),
        )
        .await
        .is_err(),
        "run receipt must retain the scope read guard through adapter emission"
    );
    assert_eq!(run_receipt.run().query_run_id, query_run_id);
    drop(run_receipt);
    let mutation = tokio::time::timeout(
        Duration::from_secs(5),
        harness.connections.begin_scope_mutation(),
    )
    .await
    .expect("scope writer must proceed after the run receipt drops");
    drop(mutation);
    harness.close().await;
}

#[tokio::test]
async fn non_read_rejection_is_audited_before_returning() {
    let harness = SqliteHarness::new().await;
    let authority = harness.terminal_authority().await;
    let rejection = harness
        .queries
        .plan_terminal_read(TerminalQueryPlanRequest {
            connection_id: harness.connection_id.into(),
            sql: "DELETE FROM users".into(),
            max_rows: None,
            authority,
        })
        .await;
    assert!(matches!(rejection, Err(AgentQueryPlanError::NotSingleRead)));
    let after = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap()
        .0;
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].action, "cli:plan_query");
    assert!(after[0].error.is_some());
    harness.close().await;
}

#[tokio::test]
async fn authority_failure_consumes_the_plan_before_awaiting() {
    let harness = SqliteHarness::new().await;
    let authority = harness.terminal_authority().await;
    let plan_id = OperationId::from(Uuid::new_v4());
    harness
        .seed_plan(&authority, plan_id, "SELECT 1", Instant::now())
        .await;
    let mut revised_profile = harness.profile.clone();
    revised_profile.name = "query-feature-revised".into();
    harness
        .store
        .upsert_connection(&revised_profile)
        .await
        .unwrap();
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(plan_id, &authority)
            .await,
        Err(AgentQueryRunPrepareError::AuthorityChanged)
    ));
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(plan_id, &authority)
            .await,
        Err(AgentQueryRunPrepareError::UnknownOrAlreadyUsed)
    ));

    let tampered_actor_plan_id = OperationId::from(Uuid::new_v4());
    harness
        .seed_plan_with_actor(
            &authority,
            tampered_actor_plan_id,
            "SELECT 1",
            Instant::now(),
            Some("tampered-agent".into()),
        )
        .await;
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(tampered_actor_plan_id, &authority)
            .await,
        Err(AgentQueryRunPrepareError::StoredPlanInvalid)
    ));

    let session_bound_plan_id = OperationId::from(Uuid::new_v4());
    harness
        .seed_plan(
            &authority,
            session_bound_plan_id,
            "SELECT 1",
            Instant::now(),
        )
        .await;
    let mut other_session = authority.clone();
    other_session.terminal_session_id = Uuid::new_v4().into();
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(session_bound_plan_id, &other_session)
            .await,
        Err(AgentQueryRunPrepareError::SessionMismatch)
    ));
    harness.close().await;
}

#[tokio::test]
async fn expired_failure_also_consumes_the_plan() {
    let harness = SqliteHarness::new().await;
    let authority = harness.terminal_authority().await;
    let plan_id = OperationId::from(Uuid::new_v4());
    harness
        .seed_plan(
            &authority,
            plan_id,
            "SELECT 1",
            Instant::now() - QUERY_PLAN_TTL - Duration::from_secs(1),
        )
        .await;
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(plan_id, &authority)
            .await,
        Err(AgentQueryRunPrepareError::Expired)
    ));
    assert!(matches!(
        harness
            .queries
            .prepare_terminal_run(plan_id, &authority)
            .await,
        Err(AgentQueryRunPrepareError::UnknownOrAlreadyUsed)
    ));
    harness.close().await;
}
