use std::collections::HashMap;

use chrono::Utc;
use uuid::Uuid;

use super::domain::{
    planning_guidance, project_query_service_session_snapshot,
    validate_query_service_session_snapshot,
};
use crate::executor::namespace::{postgres_search_path_statement, resolve_sql_namespace};
use crate::model::{
    ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};
use crate::monitoring::HealthSnapshot;

#[test]
fn query_guidance_and_namespace_contracts_stay_fail_closed() {
    let production = ConnectionProfile {
        id: Uuid::new_v4(),
        name: "query-feature-test".into(),
        engine: Engine::Sqlite,
        provider: Provider::Generic,
        driver_id: Some("sqlx-sqlite".into()),
        host: String::new(),
        port: 0,
        database: "test.db".into(),
        username: String::new(),
        sslmode: "disable".into(),
        extra_params: HashMap::new(),
        readonly_default: true,
        allow_writes: false,
        secret_ref: None,
        env: Some("prod".into()),
        schema_group: None,
        workspace_access: WorkspaceConnectionAccess::Local,
        credential_mode: WorkspaceCredentialMode::Local,
        provider_target: None,
    };
    let health = HealthSnapshot {
        level: "normal".into(),
        coverage: "limited".into(),
        total_connections: Some(1),
        max_connections: Some(100),
        connection_usage_percent: Some(1.0),
        active_queries: Some(1),
        long_running_queries: Some(0),
        lock_waits: Some(0),
        replication_lag_seconds: None,
        reasons: vec!["Monitoring coverage is limited without pg_monitor.".into()],
        captured_at: Utc::now(),
    };
    let (decision, notices, suggestions) =
        planning_guidance(&production, &health, Some(100_001), 50_000);

    assert_eq!(decision, "caution");
    assert!(notices
        .iter()
        .any(|notice| notice == "This connection is labeled production."));
    assert!(notices
        .iter()
        .any(|notice| notice.contains("EXPLAIN estimates 100001")));
    assert!(suggestions
        .iter()
        .any(|suggestion| suggestion.contains("pg_monitor")));
    assert!(suggestions.windows(2).all(|pair| pair[0] <= pair[1]));

    let mut postgres = production.clone();
    postgres.engine = Engine::Postgres;
    postgres.database = "app".into();
    let adversarial = "tenant\"; DROP SCHEMA public; --";
    assert_eq!(
        resolve_sql_namespace(&postgres, Some(adversarial.into())).unwrap(),
        Some(adversarial.into()),
    );
    assert_eq!(
        postgres_search_path_statement(adversarial),
        "SET LOCAL search_path TO \"tenant\"\"; DROP SCHEMA public; --\"",
    );
    assert!(resolve_sql_namespace(&production, Some("attached".into())).is_err());

    let connection_id = Uuid::new_v4();
    let services_snapshot = serde_json::json!({
        "schemaVersion": 1,
        "id": "document-1:1",
        "documentId": "document-1",
        "connectionId": connection_id,
        "connectionName": "Fixture",
        "consoleTitle": "Query",
        "database": "app",
        "namespace": "public",
        "sql": "SELECT 1",
        "startedAt": "2026-01-01T00:00:00Z",
        "startedLabel": "00:00:00",
        "updatedAt": 1,
        "status": "completed",
        "result": {"kind": "materialized"}
    });
    let validated = validate_query_service_session_snapshot(services_snapshot.clone()).unwrap();
    assert_eq!(Uuid::from(validated.connection_id), connection_id);
    assert_eq!(validated.status.as_str(), "completed");
    let mut running_snapshot = services_snapshot;
    running_snapshot["status"] = serde_json::json!("running");
    assert!(validate_query_service_session_snapshot(running_snapshot).is_err());

    let legacy_stream = serde_json::json!({
        "schemaVersion": 1,
        "id": "document-1:legacy",
        "documentId": "document-1",
        "connectionId": connection_id,
        "connectionName": "Fixture",
        "consoleTitle": "Legacy",
        "database": "app",
        "namespace": "public",
        "sql": "SELECT secret_value",
        "startedAt": "2026-01-01T00:00:00Z",
        "startedLabel": "00:00:00",
        "updatedAt": 2,
        "status": "completed",
        "result": {
            "kind": "stream",
            "sql": "SELECT secret_value",
            "stream": {"rowSource": {"chunkIndex": {"chunks": [{"rows": [["row-secret"]]}]}}},
            "maxRows": 1000
        }
    });
    let mut legacy_cancelled = legacy_stream.clone();
    legacy_cancelled["status"] = serde_json::json!("cancelled");
    let (projected, migrated) = project_query_service_session_snapshot(legacy_stream);
    assert!(migrated);
    assert_eq!(projected["schemaVersion"], 2);
    assert_eq!(projected["result"]["kind"], "unavailable");
    assert_eq!(projected["result"]["reason"], "legacyResultFormat");
    assert!(!serde_json::to_string(&projected)
        .unwrap()
        .contains("row-secret"));
    let (cancelled, migrated) = project_query_service_session_snapshot(legacy_cancelled);
    assert!(migrated);
    assert_eq!(cancelled["schemaVersion"], 2);
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["result"]["kind"], "none");
    assert!(!serde_json::to_string(&cancelled)
        .unwrap()
        .contains("row-secret"));
}
