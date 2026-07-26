//! Characterization tests for broker dispatch wire behavior.
use std::collections::HashMap;
use std::str::FromStr;

use dopedb_protocol::{
    ConnectionListResult, QueryPlanArguments, QueryPlanResult, QueryRunArguments, QueryRunResult,
    SessionAuthentication, SkillMutationResult, SkillStatusResult,
};
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tempfile::TempDir;

use super::*;
use crate::connection::ConnectionManager;
use crate::features::queries::AgentQueryRunPrepareError;
use crate::model::{
    ConnectionProfile, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};
use crate::operations::OperationRuntime;
use crate::store::{Store, TEST_SCHEMA};

fn request(command: CommandName, arguments: serde_json::Value) -> RequestEnvelope {
    RequestEnvelope {
        protocol_version: PROTOCOL_MAX,
        command_schema_version: COMMAND_SCHEMA_VERSION,
        request_id: Uuid::new_v4(),
        authentication: None,
        command,
        arguments,
    }
}

fn dispatcher() -> BrokerDispatcher {
    let runtime_id = Uuid::new_v4();
    BrokerDispatcher::new(
        runtime_id,
        "0.3.3",
        BrokerSessionRegistry::new(runtime_id),
        None,
        None,
        None,
    )
}

#[test]
fn query_prepare_projection_distinguishes_tampered_actor_from_session_mismatch() {
    assert_eq!(
        super::projection::map_prepare_error(AgentQueryRunPrepareError::StoredPlanInvalid),
        ErrorCode::InvalidRequest
    );
    assert_eq!(
        super::projection::map_prepare_error(AgentQueryRunPrepareError::SessionMismatch),
        ErrorCode::ScopeDenied
    );
}

#[tokio::test]
async fn status_uses_the_typed_empty_payload_and_safe_projection() {
    let dispatcher = dispatcher();
    let accepted = dispatcher
        .dispatch(request(CommandName::Status, json!({})))
        .await;
    assert!(accepted.is_ok());
    assert_eq!(
        accepted.result().unwrap()["appVersion"],
        serde_json::Value::String("0.3.3".into())
    );

    let rejected = dispatcher
        .dispatch(request(
            CommandName::Status,
            json!({"token": "must-not-pass"}),
        ))
        .await;
    assert_eq!(
        rejected.error().map(ProtocolError::code),
        Some(ErrorCode::InvalidRequest)
    );
}

#[tokio::test]
async fn skill_inventory_and_install_use_the_public_typed_broker_path() {
    let home = TempDir::new().unwrap();
    let runtime_id = Uuid::new_v4();
    let dispatcher = BrokerDispatcher::new(
        runtime_id,
        "0.3.3",
        BrokerSessionRegistry::new(runtime_id),
        None,
        Some(crate::skills::SkillManager::for_home(home.path().to_path_buf()).unwrap()),
        None,
    );
    let status_response = dispatcher
        .dispatch(request(
            CommandName::SkillStatus,
            json!({"target": "codex"}),
        ))
        .await;
    let status: SkillStatusResult =
        serde_json::from_value(status_response.result().cloned().unwrap()).unwrap();
    assert_eq!(status.targets.len(), 1);
    assert_eq!(
        status.targets[0].state,
        dopedb_protocol::SkillInstallState::Missing
    );

    let install_response = dispatcher
        .dispatch(request(
            CommandName::SkillInstall,
            json!({
                "target": "codex",
                "expected": [{
                    "target": "codex",
                    "inventoryFingerprint": status.targets[0].inventory_fingerprint
                }]
            }),
        ))
        .await;
    let installed: SkillMutationResult =
        serde_json::from_value(install_response.result().cloned().unwrap()).unwrap();
    assert_eq!(
        installed.status.targets[0].state,
        dopedb_protocol::SkillInstallState::ManagedCurrent
    );
    assert_eq!(
        installed.changed_targets,
        vec![dopedb_protocol::SkillTarget::Codex]
    );
}

#[tokio::test]
async fn disabled_skill_manager_fails_without_reading_the_user_home() {
    let response = dispatcher()
        .dispatch(request(CommandName::SkillsList, json!({})))
        .await;
    assert_eq!(
        response.error().map(ProtocolError::code),
        Some(ErrorCode::PolicyBlocked)
    );
}

#[tokio::test]
async fn db_commands_require_terminal_auth_before_payload_decode() {
    let response = dispatcher()
        .dispatch(request(
            CommandName::QueryPlan,
            json!({"connection": "invalid", "sql": ""}),
        ))
        .await;
    assert_eq!(
        response.error().map(ProtocolError::code),
        Some(ErrorCode::AuthenticationDenied)
    );
}

#[tokio::test]
async fn incompatible_protocol_fails_before_command_decode() {
    let mut request = request(CommandName::Status, json!({}));
    request.protocol_version = PROTOCOL_MAX + 1;
    let response = dispatcher().dispatch(request).await;
    assert_eq!(
        response.error().map(ProtocolError::code),
        Some(ErrorCode::ProtocolMismatch)
    );
}

#[tokio::test]
async fn future_command_decodes_only_to_return_a_stable_schema_error() {
    let future = json!({
        "protocolVersion": PROTOCOL_MAX,
        "commandSchemaVersion": COMMAND_SCHEMA_VERSION + 1,
        "requestId": Uuid::new_v4(),
        "command": "future.command",
        "arguments": {"untrusted": true}
    });
    let request: RequestEnvelope = serde_json::from_value(future.clone()).unwrap();
    assert_eq!(request.command, CommandName::Unknown);
    let response = dispatcher().dispatch(request).await;
    assert_eq!(
        response.error().map(ProtocolError::code),
        Some(ErrorCode::ProtocolMismatch)
    );

    let mut same_schema = future;
    same_schema["commandSchemaVersion"] = serde_json::json!(COMMAND_SCHEMA_VERSION);
    let response = dispatcher()
        .dispatch(serde_json::from_value(same_schema).unwrap())
        .await;
    assert_eq!(
        response.error().map(ProtocolError::code),
        Some(ErrorCode::InvalidRequest)
    );
}

#[test]
fn oversized_results_fail_as_a_stable_error_before_transport_write() {
    let response = success(
        Uuid::new_v4(),
        &"x".repeat(dopedb_protocol::MAX_STRING_BYTES + 1),
    );
    assert_eq!(
        response.error().map(ProtocolError::code),
        Some(ErrorCode::ResponseTooLarge)
    );
    assert!(response.result().is_none());
}

#[test]
fn response_projection_preserves_payload_and_uses_the_negotiated_version() {
    let request_id = Uuid::new_v4();
    let response = response_at_protocol(success(request_id, &json!({"ready": true})), 7);
    assert_eq!(response.protocol_version(), 7);
    assert_eq!(response.request_id(), request_id);
    assert_eq!(response.result().unwrap(), &json!({"ready": true}));
}

#[test]
fn terminal_query_interruptions_keep_stable_cancel_and_timeout_codes() {
    assert_eq!(
        map_query_execution_error(&AppError::Safety("query cancelled".into())),
        ErrorCode::Cancelled
    );
    assert_eq!(
        map_query_execution_error(&AppError::Safety(
            "query timed out after 300s and was aborted".into()
        )),
        ErrorCode::Timeout
    );
}

struct ServiceHarness {
    dispatcher: BrokerDispatcher,
    primary_session: (Uuid, String),
    other_session: (Uuid, String),
    store: Store,
    connections: ConnectionManager,
    connection_id: Uuid,
    _directory: TempDir,
}

impl ServiceHarness {
    async fn new() -> Self {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
        let store = Store::from_pool_for_test(pool);

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("broker-target.db");
        let target_options = SqliteConnectOptions::new()
            .filename(&target)
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
        store
            .upsert_connection(&ConnectionProfile {
                id: connection_id,
                name: "fixture".into(),
                engine: Engine::Sqlite,
                provider: Provider::Generic,
                driver_id: Some("sqlx-sqlite".into()),
                host: String::new(),
                port: 0,
                database: target.to_string_lossy().into_owned(),
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
            })
            .await
            .unwrap();
        let pin = store.pin_connection_for_read(connection_id).await.unwrap();
        let connections = ConnectionManager::new(store.clone());
        let (operation, _) = OperationRuntime::new(&store);
        let runtime_id = operation.runtime_id();
        let services = ApplicationServices::new(store.clone(), connections.clone(), operation);
        let sessions = BrokerSessionRegistry::new(runtime_id);
        let primary = sessions
            .issue(
                Uuid::new_v4().into(),
                &pin,
                BrokerCapability::ALL,
                Duration::from_secs(60),
            )
            .unwrap();
        let other = sessions
            .issue(
                Uuid::new_v4().into(),
                &pin,
                BrokerCapability::ALL,
                Duration::from_secs(60),
            )
            .unwrap();
        let primary_session = (
            primary.terminal_session_id.into(),
            primary.token().to_string(),
        );
        let other_session = (other.terminal_session_id.into(), other.token().to_string());
        Self {
            dispatcher: BrokerDispatcher::new(
                runtime_id,
                "0.3.3",
                sessions,
                Some(services),
                None,
                None,
            ),
            primary_session,
            other_session,
            store,
            connections,
            connection_id,
            _directory: directory,
        }
    }

    fn request<T: Serialize>(
        &self,
        command: CommandName,
        arguments: &T,
        session: &(Uuid, String),
    ) -> RequestEnvelope {
        RequestEnvelope {
            protocol_version: PROTOCOL_MAX,
            command_schema_version: COMMAND_SCHEMA_VERSION,
            request_id: Uuid::new_v4(),
            authentication: Some(SessionAuthentication::new(session.0, session.1.clone())),
            command,
            arguments: serde_json::to_value(arguments).unwrap(),
        }
    }

    async fn close(self) {
        let mutation = self
            .connections
            .begin_connection_mutation(
                self.connection_id,
                crate::connection::ConnectionAccess::Read,
            )
            .await
            .unwrap();
        mutation.retire_connection(self.connection_id).await;
        self.store.pool().close().await;
    }
}

#[tokio::test]
async fn phase_six_dispatch_is_secret_free_and_terminal_provenance_bound() {
    let harness = ServiceHarness::new().await;
    let list = harness
        .dispatcher
        .dispatch(harness.request(
            CommandName::ConnectionList,
            &EmptyArguments::default(),
            &harness.primary_session,
        ))
        .await;
    let list: ConnectionListResult =
        serde_json::from_value(list.result().cloned().unwrap()).unwrap();
    assert_eq!(list.connections.len(), 1);
    let serialized = serde_json::to_string(&list).unwrap();
    for forbidden in ["host", "username", "password", "secret", "credential"] {
        assert!(!serialized.to_ascii_lowercase().contains(forbidden));
    }

    let wrong_connection = harness
        .dispatcher
        .dispatch(harness.request(
            CommandName::QueryPlan,
            &QueryPlanArguments {
                connection: ConnectionSelector::Id(Uuid::new_v4()),
                sql: "SELECT 1".into(),
                max_rows: None,
            },
            &harness.primary_session,
        ))
        .await;
    assert_eq!(
        wrong_connection.error().map(ProtocolError::code),
        Some(ErrorCode::ScopeDenied)
    );

    let document_on_sql = harness
        .dispatcher
        .dispatch(harness.request(
            CommandName::DocumentRun,
            &DocumentRunArguments {
                connection: ConnectionSelector::Id(harness.connection_id),
                query: ProtocolDocumentQuery::Count {
                    collection: "users".into(),
                    filter: None,
                },
                max_rows: None,
            },
            &harness.primary_session,
        ))
        .await;
    assert_eq!(
        document_on_sql.error().map(ProtocolError::code),
        Some(ErrorCode::InvalidRequest)
    );

    let mut plan_request = harness.request(
        CommandName::QueryPlan,
        &QueryPlanArguments {
            connection: ConnectionSelector::Id(harness.connection_id),
            sql: "SELECT id, name FROM users ORDER BY id".into(),
            max_rows: None,
        },
        &harness.primary_session,
    );
    plan_request.protocol_version = PROTOCOL_MIN;
    let planned = harness.dispatcher.dispatch(plan_request).await;
    let plan: QueryPlanResult = serde_json::from_value(planned.result().cloned().unwrap()).unwrap();
    let provenance: String =
        sqlx::query_scalar("SELECT actor_provenance_json FROM operations WHERE id = ?1")
            .bind(plan.plan_id.to_string())
            .fetch_one(harness.store.pool())
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&provenance).unwrap()["clientProtocolVersion"],
        serde_json::json!(PROTOCOL_MIN)
    );

    let denied = harness
        .dispatcher
        .dispatch(harness.request(
            CommandName::QueryRun,
            &QueryRunArguments {
                plan_id: plan.plan_id,
            },
            &harness.other_session,
        ))
        .await;
    assert_eq!(
        denied.error().map(ProtocolError::code),
        Some(ErrorCode::ScopeDenied)
    );

    let executed = harness
        .dispatcher
        .dispatch(harness.request(
            CommandName::QueryRun,
            &QueryRunArguments {
                plan_id: plan.plan_id,
            },
            &harness.primary_session,
        ))
        .await;
    let run: QueryRunResult = serde_json::from_value(executed.result().cloned().unwrap()).unwrap();
    assert_eq!(run.result.row_count, 2);
    assert_eq!(run.result.rows.len(), 2);

    let dashboard_arguments = DashboardCreateArguments {
        query_run_id: run.query_run_id,
        title: "Users".into(),
        description: "Saved from the exact successful run".into(),
        kind: ProtocolDashboardKind::Auto,
        x_column: None,
        y_columns: Vec::new(),
    };
    let denied_dashboard = harness
        .dispatcher
        .dispatch(harness.request(
            CommandName::DashboardCreate,
            &dashboard_arguments,
            &harness.other_session,
        ))
        .await;
    assert_eq!(
        denied_dashboard.error().map(ProtocolError::code),
        Some(ErrorCode::PolicyBlocked)
    );

    let created_dashboard = harness
        .dispatcher
        .dispatch(harness.request(
            CommandName::DashboardCreate,
            &dashboard_arguments,
            &harness.primary_session,
        ))
        .await;
    let dashboard: DashboardCreateResult =
        serde_json::from_value(created_dashboard.result().cloned().unwrap()).unwrap();
    assert_eq!(dashboard.query_run_id, run.query_run_id);
    assert_eq!(dashboard.dashboard.connection_id, harness.connection_id);
    assert_eq!(
        dashboard.dashboard.sql,
        "SELECT id, name FROM users ORDER BY id"
    );

    harness.close().await;
}
