//! Monitoring feature authorization and audit tests.

use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use super::*;
use crate::model::{
    ConnectionProfile, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};
use crate::store::TEST_SCHEMA;

async fn harness(
    engine: Engine,
) -> (
    MonitoringFeature,
    Store,
    ConnectionManager,
    OperationRuntime,
    Uuid,
) {
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
    let connection_id = Uuid::new_v4();
    store
        .upsert_connection(&ConnectionProfile {
            id: connection_id,
            name: "monitoring-test".into(),
            engine,
            provider: Provider::Generic,
            driver_id: None,
            host: "127.0.0.1".into(),
            port: if matches!(engine, Engine::Postgres) {
                5432
            } else {
                27017
            },
            database: "test".into(),
            username: "tester".into(),
            sslmode: "disable".into(),
            extra_params: HashMap::new(),
            readonly_default: true,
            allow_writes: true,
            secret_ref: None,
            env: Some("test".into()),
            schema_group: None,
            workspace_access: WorkspaceConnectionAccess::Local,
            credential_mode: WorkspaceCredentialMode::Local,
        })
        .await
        .unwrap();
    let safety = crate::model::SafetySettings {
        allow_writes: true,
        ..crate::model::SafetySettings::default()
    };
    store.set_safety(connection_id, &safety).await.unwrap();
    let connections = ConnectionManager::new(store.clone());
    let (operation, _approval) = OperationRuntime::new(&store);
    (
        compose(store.clone(), connections.clone(), operation.clone()),
        store,
        connections,
        operation,
        connection_id,
    )
}

#[tokio::test]
async fn document_status_preserves_basic_wire_without_target_probe() {
    let (service, store, connections, _, connection_id) = harness(Engine::Mongodb).await;
    let receipt = service.status(connection_id).await.unwrap();
    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        serde_json::json!({
            "engine": "mongodb",
            "coverage": "basic",
            "roleAvailable": false,
            "roleGranted": false,
            "currentUser": null,
            "canManage": false,
            "note": "MongoDB connections use the basic, role-free collector."
        })
    );
    assert!(tokio::time::timeout(
        Duration::from_millis(100),
        connections.begin_scope_mutation(),
    )
    .await
    .is_err());
    drop(receipt);
    let mutation = connections.begin_scope_mutation().await;
    drop(mutation);
    store.pool().close().await;
}

#[tokio::test]
async fn non_postgres_change_rejects_before_audit_or_target_touch() {
    let (service, store, _, _, connection_id) = harness(Engine::Mongodb).await;
    let error = match service
        .propose_postgres_role(MonitoringProposalRequest {
            connection_id,
            enabled: true,
        })
        .await
    {
        Err(error) => error.into_error(),
        Ok(_) => panic!("non-PostgreSQL monitoring change must be rejected"),
    };
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        serde_json::json!({
            "kind": "config",
            "message": "config error: pg_monitor is only available for PostgreSQL connections"
        })
    );
    assert!(audit::snapshot(&store, connection_id)
        .await
        .unwrap()
        .0
        .is_empty());
    assert!(store.list_history(connection_id).await.unwrap().is_empty());
    store.pool().close().await;
}

#[tokio::test]
async fn unapproved_postgres_change_remains_pending_without_target_or_audit_touch() {
    let (service, store, _, operation, connection_id) = harness(Engine::Postgres).await;
    let proposal = service
        .propose_postgres_role(MonitoringProposalRequest {
            connection_id,
            enabled: true,
        })
        .await
        .unwrap();
    assert_eq!(proposal.state, OperationState::PendingApproval);
    assert_eq!(proposal.sql, "GRANT pg_monitor TO CURRENT_USER");
    assert_eq!(proposal.payload_hash.len(), 64);
    let error = match service.run_postgres_role(proposal.operation_id).await {
        Err(error) => error.into_error(),
        Ok(_) => panic!("unapproved PostgreSQL monitoring change must be rejected"),
    };
    assert!(matches!(error, AppError::Blocked { .. }));
    assert_eq!(
        operation.get(proposal.operation_id).await.unwrap().state,
        OperationState::PendingApproval
    );
    let (audit, valid, first_bad) = audit::snapshot(&store, connection_id).await.unwrap();
    assert!(valid);
    assert_eq!(first_bad, None);
    assert!(audit.is_empty());
    assert!(store.list_history(connection_id).await.unwrap().is_empty());
    store.pool().close().await;
}
