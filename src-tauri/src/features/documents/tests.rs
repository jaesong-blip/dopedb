//! Document feature authorization and wire-contract tests.

use std::collections::HashMap;
use std::str::FromStr;

use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use super::*;
use crate::kernel::identity::AccountScopeId;
use crate::model::{
    ConnectionProfile, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};
use crate::store::TEST_SCHEMA;

fn profile(id: Uuid, engine: Engine) -> ConnectionProfile {
    ConnectionProfile {
        id,
        name: "document-service-test".into(),
        engine,
        provider: Provider::Generic,
        driver_id: Some(
            match engine {
                Engine::Mongodb => "mongodb-rust",
                _ => "sqlx-sqlite",
            }
            .into(),
        ),
        host: "sensitive-host.invalid".into(),
        port: if engine == Engine::Mongodb { 27_017 } else { 0 },
        database: if engine == Engine::Sqlite {
            ":memory:".into()
        } else {
            "test".into()
        },
        username: "sensitive-user".into(),
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

fn safe_find() -> DocumentQuery {
    DocumentQuery::Find {
        collection: "users".into(),
        filter: Some(json!({ "active": true })),
        projection: None,
        sort: None,
        skip: None,
        limit: None,
    }
}

fn blocked_aggregate() -> DocumentQuery {
    DocumentQuery::Aggregate {
        collection: "users".into(),
        pipeline: vec![json!({ "$out": "copied_users" })],
    }
}

struct Harness {
    service: DocumentFeature,
    store: Store,
    connections: ConnectionManager,
    connection_id: Uuid,
}

impl Harness {
    async fn new(engine: Engine) -> Self {
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
            .upsert_connection(&profile(connection_id, engine))
            .await
            .unwrap();
        let connections = ConnectionManager::new(store.clone());
        let (operation, _) = OperationRuntime::new(&store);
        let service = compose(store.clone(), connections.clone(), operation);
        Self {
            service,
            store,
            connections,
            connection_id,
        }
    }

    async fn close(self) {
        let Self {
            service,
            store,
            connections,
            ..
        } = self;
        drop(service);
        drop(connections);
        store.pool().close().await;
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
}

#[test]
fn row_caps_preserve_agent_and_desktop_contracts() {
    assert_eq!(bounded_agent_rows(Some(5_000), 25), MAX_AGENT_ROWS);
    assert_eq!(bounded_agent_rows(None, 5_000), MAX_AGENT_ROWS);
    assert_eq!(bounded_agent_rows(Some(0), 500), 0);
    assert_eq!(bounded_desktop_rows(0), 1);
    assert_eq!(bounded_desktop_rows(250), 250);
    assert_eq!(bounded_desktop_rows(u64::MAX), MAX_DESKTOP_ROWS);
}

#[test]
fn desktop_plan_never_weakens_typed_read_only() {
    let classification = crate::mongo::query::classify(&safe_find());
    let settings = SafetySettings {
        auto_run_reads: false,
        ..SafetySettings::default()
    };
    assert!(desktop_blocked_reason(&settings, &classification).is_none());

    let rejected = crate::mongo::query::classify(&blocked_aggregate());
    assert!(
        desktop_blocked_reason(&settings, &rejected).is_some_and(|reason| reason.contains("$out"))
    );
}

#[tokio::test]
async fn desktop_receipt_serializes_as_the_exact_legacy_document_page() {
    let harness = Harness::new(Engine::Sqlite).await;
    let authority = harness
        .connections
        .pin(harness.connection_id, ConnectionAccess::Read)
        .await
        .unwrap();
    let lease = authority.connect().await.unwrap();
    let receipt = DocumentReadReceipt {
        result: DocumentReadResult {
            operation_id: Uuid::new_v4(),
            context: DocumentReadEventContext {
                connection_id: harness.connection_id,
                connection_name: "must-not-serialize".into(),
                query_text: "must-not-serialize".into(),
            },
            query: safe_find(),
            page: DocumentPage {
                documents: vec![json!({ "name": "Ada" })],
                doc_count: 1,
                truncated: false,
                duration_ms: 7,
            },
        },
        _lease: lease,
    };

    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        json!({
            "documents": [{ "name": "Ada" }],
            "docCount": 1,
            "truncated": false,
            "durationMs": 7,
        })
    );
    drop(receipt);
    harness.close().await;
}

#[tokio::test]
async fn rejected_terminal_query_is_audited_without_history_or_profile_leak() {
    let harness = Harness::new(Engine::Mongodb).await;
    let authority = harness.terminal_authority().await;
    let rejected = match harness
        .service
        .run_terminal_read(TerminalDocumentReadRequest {
            connection_id: harness.connection_id,
            query: blocked_aggregate(),
            max_rows: None,
            authority,
        })
        .await
    {
        Err(AgentDocumentReadError::Rejected(rejected)) => rejected,
        Err(other) => panic!("expected typed rejection, got {other:?}"),
        Ok(_) => panic!("unsafe aggregate unexpectedly executed"),
    };
    let debug = format!("{rejected:?}");
    assert!(debug.contains("$out"));
    assert!(!debug.contains("sensitive-host.invalid"));
    assert!(!debug.contains("sensitive-user"));

    let (audit, chain_ok, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap();
    assert!(chain_ok);
    assert_eq!(first_bad, None);
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].action, "cli:run_document_query");
    assert_eq!(audit[0].kind, QueryKind::Write);
    assert!(harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap()
        .is_empty());
    drop(rejected);
    harness.close().await;
}

#[tokio::test]
async fn rejected_token_holds_scope_until_adapter_finishes() {
    let harness = Harness::new(Engine::Mongodb).await;
    let authority = harness.terminal_authority().await;
    let rejected = match harness
        .service
        .run_terminal_read(TerminalDocumentReadRequest {
            connection_id: harness.connection_id,
            query: blocked_aggregate(),
            max_rows: None,
            authority,
        })
        .await
    {
        Err(AgentDocumentReadError::Rejected(rejected)) => rejected,
        Err(other) => panic!("expected typed rejection, got {other:?}"),
        Ok(_) => panic!("unsafe aggregate unexpectedly executed"),
    };

    let mutation_manager = harness.connections.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let mut waiter = tokio::spawn(async move {
        let _ = started_tx.send(());
        mutation_manager.begin_scope_mutation().await
    });
    started_rx.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut waiter)
            .await
            .is_err(),
        "scope mutation must wait while the adapter owns the rejection token"
    );
    drop(rejected);
    let mutation = tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .expect("scope mutation should resume after the token drops")
        .unwrap();
    drop(mutation);
    harness.close().await;
}

#[tokio::test]
async fn desktop_unsafe_document_shape_is_rejected_before_plan_persistence() {
    let harness = Harness::new(Engine::Mongodb).await;
    let error = match harness
        .service
        .propose_desktop_read(DesktopDocumentProposalRequest {
            connection_id: harness.connection_id,
            query: blocked_aggregate(),
            origin: None,
        })
        .await
    {
        Err(error) => error.into_error(),
        Ok(_) => panic!("unsafe aggregate unexpectedly executed"),
    };
    assert!(matches!(error, AppError::Blocked { .. }));

    assert!(harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap()
        .is_empty());

    let (audit, chain_ok, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap();
    assert!(chain_ok);
    assert_eq!(first_bad, None);
    assert!(audit.is_empty());
    harness.close().await;
}

#[tokio::test]
async fn cli_provenance_uses_cli_audit_but_agent_history() {
    let harness = Harness::new(Engine::Mongodb).await;
    let pin = harness
        .store
        .pin_connection_for_read(harness.connection_id)
        .await
        .unwrap();
    record_agent_execution(
        &harness.store,
        &pin,
        r#"{"op":"count","collection":"users"}"#,
        Some(1),
        Some(2),
        None,
    )
    .await;

    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].origin, "agent");
    assert_eq!(history[0].status, "ok");
    assert_eq!(history[0].row_count, Some(1));
    let (audit, chain_ok, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap();
    assert!(chain_ok);
    assert_eq!(first_bad, None);
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].action, "cli:run_document_query");
    assert_eq!(audit[0].affected_estimate, None);
    harness.close().await;
}

#[tokio::test]
async fn terminal_execution_error_preserves_audit_and_history_contract() {
    let harness = Harness::new(Engine::Mongodb).await;
    let pin = harness
        .store
        .pin_connection_for_read(harness.connection_id)
        .await
        .unwrap();
    let query_text = r#"{"op":"find","collection":"users"}"#;
    record_agent_execution(
        &harness.store,
        &pin,
        query_text,
        None,
        None,
        Some("backend unavailable".into()),
    )
    .await;

    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].sql, query_text);
    assert_eq!(history[0].kind, QueryKind::Read);
    assert_eq!(history[0].status, "error");
    assert_eq!(history[0].origin, "agent");
    assert_eq!(history[0].error.as_deref(), Some("backend unavailable"));
    let (audit, chain_ok, first_bad) = audit::snapshot(&harness.store, harness.connection_id)
        .await
        .unwrap();
    assert!(chain_ok);
    assert_eq!(first_bad, None);
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].action, "cli:run_document_query");
    assert_eq!(audit[0].kind, QueryKind::Read);
    assert_eq!(audit[0].affected_estimate, None);
    assert_eq!(audit[0].error.as_deref(), Some("backend unavailable"));
    harness.close().await;
}

#[tokio::test]
async fn sql_connection_is_rejected_without_exposing_its_profile() {
    let harness = Harness::new(Engine::Sqlite).await;
    let authority = harness.terminal_authority().await;
    let error = match harness
        .service
        .run_terminal_read(TerminalDocumentReadRequest {
            connection_id: harness.connection_id,
            query: safe_find(),
            max_rows: None,
            authority,
        })
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("SQL connection unexpectedly accepted a document query"),
    };
    assert!(matches!(
        error,
        AgentDocumentReadError::NonDocumentConnection
    ));
    let debug = format!("{error:?}");
    assert!(!debug.contains("sensitive-host.invalid"));
    assert!(!debug.contains("sensitive-user"));
    harness.close().await;
}
