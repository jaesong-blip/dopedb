//! Operation repository characterization and tamper-resistance tests.

use std::str::FromStr;

use chrono::Duration;
use dopedb_protocol::{OperationActorKind, OperationKind, OperationRiskLevel};
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use super::*;
use crate::store::TEST_SCHEMA;

async fn repository() -> (OperationRepository, SqlitePool) {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
    (OperationRepository::from_pool(pool.clone()), pool)
}

fn operation(kind: OperationKind, _runtime_id: Uuid, idempotency_key: &str) -> NewOperation {
    NewOperation {
        id: Uuid::new_v4(),
        workspace_id: Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap(),
        account_scope: "personal".into(),
        connection_id: Uuid::new_v4(),
        connection_revision: 1,
        terminal_session_id: Some(Uuid::new_v4()),
        actor: OperationActor {
            kind: OperationActorKind::LocalUser,
            id: "local-owner".into(),
            provenance: OperationActorProvenance {
                client_protocol_version: Some(1),
                origin_surface: "sql_editor".into(),
                ..OperationActorProvenance::default()
            },
        },
        kind,
        payload_schema_version: 1,
        payload: json!({"sql": "SELECT 1", "parameters": []}),
        schema_fingerprint: Some("a".repeat(64)),
        risk_level: OperationRiskLevel::Low,
        preview: json!({"statementCount": 1}),
        policy_snapshot: json!({"allowWrites": false}),
        policy_revision: "local-policy-v1".into(),
        single_use: true,
        idempotency_key: idempotency_key.into(),
        expires_at: Some(Utc::now() + Duration::minutes(5)),
    }
}

fn approval_command(
    record: &OperationRecord,
    runtime_id: Uuid,
    approver_kind: OperationActorKind,
    decision: OperationApprovalDecision,
) -> OperationApprovalCommand {
    OperationApprovalCommand {
        operation_id: record.id,
        runtime_id,
        expected_payload_hash: record.payload_hash.clone(),
        approver: OperationApprover {
            kind: approver_kind,
            id: "local-owner".into(),
        },
        decision,
        reason: None,
        current_policy_revision: record.policy_revision.clone(),
        now: Utc::now(),
    }
}

#[tokio::test]
async fn schema_is_idempotent_and_contains_all_operation_tables() {
    let (_, pool) = repository().await;
    sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
    for table in ["operations", "operation_approvals", "operation_events"] {
        let exists: i64 = sqlx::query_scalar(
            "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
                 )",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(exists, 1, "{table}");
    }
}

#[tokio::test]
async fn insertion_derives_hash_and_appends_a_verifiable_initial_event() {
    let (repository, _) = repository().await;
    let runtime_id = Uuid::new_v4();
    let record = repository
        .insert_planned(
            runtime_id,
            operation(OperationKind::ReadQuery, runtime_id, "insert-once"),
        )
        .await
        .unwrap();
    assert_eq!(record.state, OperationState::Planned);
    assert_eq!(record.payload_hash.len(), 64);
    assert_eq!(record.runtime_id, runtime_id);
    assert_eq!(record.started_at, None);
    assert_eq!(record.finished_at, None);
    assert!(repository.verify_event_chain(record.id).await.unwrap());
    let events = repository.events(record.id).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, OperationEventKind::Planned);
    assert_eq!(events[0].sequence, 1);
    assert_eq!(events[0].prev_hash, None);
}

#[tokio::test]
async fn idempotency_returns_the_exact_existing_record_and_rejects_key_rebinding() {
    let (repository, _) = repository().await;
    let runtime_id = Uuid::new_v4();
    let first_request = operation(OperationKind::ReadQuery, runtime_id, "same-request");
    let first = repository
        .insert_planned(runtime_id, first_request.clone())
        .await
        .unwrap();
    let mut retry = first_request;
    retry.id = Uuid::new_v4();
    let replay = repository.insert_planned(runtime_id, retry).await.unwrap();
    assert_eq!(replay.id, first.id);
    assert_eq!(repository.events(first.id).await.unwrap().len(), 1);

    let mut conflicting = operation(OperationKind::ReadQuery, runtime_id, "same-request");
    conflicting.connection_id = first.connection_id;
    conflicting.payload = json!({"sql": "SELECT 2", "parameters": []});
    assert!(matches!(
        repository.insert_planned(runtime_id, conflicting).await,
        Err(AppError::Blocked { .. })
    ));
}

#[tokio::test]
async fn immutable_projection_and_append_only_ledgers_reject_direct_updates() {
    let (repository, pool) = repository().await;
    let runtime_id = Uuid::new_v4();
    let record = repository
        .insert_planned(
            runtime_id,
            operation(OperationKind::ReadQuery, runtime_id, "immutable"),
        )
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE operations SET payload_json = '{}' WHERE id = ?1")
            .bind(record.id.to_string())
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE operations SET connection_revision = 2 WHERE id = ?1")
            .bind(record.id.to_string())
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(sqlx::query("DELETE FROM operations WHERE id = ?1")
        .bind(record.id.to_string())
        .execute(&pool)
        .await
        .is_err());
    assert!(
        sqlx::query("UPDATE operation_events SET event_json = '{}' WHERE operation_id = ?1")
            .bind(record.id.to_string())
            .execute(&pool)
            .await
            .is_err()
    );

    sqlx::query(
        "INSERT INTO operation_approvals (
                id, operation_id, payload_hash, approver_kind, approver_id,
                decision, policy_revision, created_at
             ) VALUES (?1, ?2, ?3, 'local_user', 'local-owner', 'approved', ?4, ?5)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(record.id.to_string())
    .bind(&record.payload_hash)
    .bind(&record.policy_revision)
    .bind(timestamp(Utc::now()))
    .execute(&pool)
    .await
    .unwrap();
    assert!(
        sqlx::query("UPDATE operation_approvals SET decision = 'rejected'")
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(sqlx::query("DELETE FROM operation_approvals")
        .execute(&pool)
        .await
        .is_err());
}

#[tokio::test]
async fn connection_deletion_cannot_delete_operation_provenance() {
    let (repository, pool) = repository().await;
    let runtime_id = Uuid::new_v4();
    let request = operation(OperationKind::ReadQuery, runtime_id, "connection-delete");
    sqlx::query(
        "INSERT INTO connections (
                id, name, engine, host, port, db_name, username, sslmode,
                extra_params, readonly_default, allow_writes, created_at, updated_at
             ) VALUES (?1, 'fixture', 'sqlite', '', 0, ':memory:', '', 'disable',
                       '{}', 1, 0, ?2, ?2)",
    )
    .bind(request.connection_id.to_string())
    .bind(timestamp(Utc::now()))
    .execute(&pool)
    .await
    .unwrap();
    let record = repository
        .insert_planned(runtime_id, request.clone())
        .await
        .unwrap();
    sqlx::query("DELETE FROM connections WHERE id = ?1")
        .bind(request.connection_id.to_string())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(repository.get(record.id).await.unwrap().id, record.id);
    assert!(repository.verify_event_chain(record.id).await.unwrap());
}

#[tokio::test]
async fn claim_is_single_use_runtime_scoped_hash_bound_and_expiry_aware() {
    let (repository, _) = repository().await;
    let runtime_id = Uuid::new_v4();
    let planned = repository
        .insert_planned(
            runtime_id,
            operation(OperationKind::ReadQuery, runtime_id, "single-claim"),
        )
        .await
        .unwrap();
    let ready = repository
        .transition(planned.id, runtime_id, OperationState::Ready, &json!({}))
        .await
        .unwrap();
    assert!(repository
        .claim_execution(ready.id, Uuid::new_v4(), Utc::now())
        .await
        .is_err());

    let first = repository.claim_execution(ready.id, runtime_id, Utc::now());
    let second = repository.claim_execution(ready.id, runtime_id, Utc::now());
    let (first, second) = tokio::join!(first, second);
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert_eq!(
        repository.get(ready.id).await.unwrap().state,
        OperationState::Executing
    );

    let mut expired_request = operation(OperationKind::ReadQuery, runtime_id, "expired-claim");
    expired_request.expires_at = Some(Utc::now() - Duration::seconds(1));
    let expired = repository
        .insert_planned(runtime_id, expired_request)
        .await
        .unwrap();
    let expired = repository
        .transition(expired.id, runtime_id, OperationState::Ready, &json!({}))
        .await
        .unwrap();
    assert!(repository
        .claim_execution(expired.id, runtime_id, Utc::now())
        .await
        .is_err());
    assert_eq!(
        repository.get(expired.id).await.unwrap().state,
        OperationState::Expired
    );
}

#[tokio::test]
async fn exact_approval_is_hash_policy_actor_and_state_bound() {
    let (repository, _) = repository().await;
    let runtime_id = Uuid::new_v4();
    let operation = repository
        .insert_planned(
            runtime_id,
            operation(OperationKind::WriteSql, runtime_id, "exact-approval"),
        )
        .await
        .unwrap();
    let pending = repository
        .transition(
            operation.id,
            runtime_id,
            OperationState::PendingApproval,
            &json!({}),
        )
        .await
        .unwrap();

    let mut wrong_hash = approval_command(
        &pending,
        runtime_id,
        OperationActorKind::LocalUser,
        OperationApprovalDecision::Approved,
    );
    wrong_hash.expected_payload_hash = "0".repeat(64);
    assert!(repository.decide_approval(wrong_hash).await.is_err());

    let agent = approval_command(
        &pending,
        runtime_id,
        OperationActorKind::Agent,
        OperationApprovalDecision::Approved,
    );
    assert!(repository.decide_approval(agent).await.is_err());

    let mut stale_policy = approval_command(
        &pending,
        runtime_id,
        OperationActorKind::LocalUser,
        OperationApprovalDecision::Approved,
    );
    stale_policy.current_policy_revision = "changed-policy".into();
    assert!(repository.decide_approval(stale_policy).await.is_err());
    assert!(repository.approvals(pending.id).await.unwrap().is_empty());

    let approved = repository
        .decide_approval(approval_command(
            &pending,
            runtime_id,
            OperationActorKind::LocalUser,
            OperationApprovalDecision::Approved,
        ))
        .await
        .unwrap();
    assert_eq!(approved.state, OperationState::Approved);
    let approvals = repository.approvals(approved.id).await.unwrap();
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].payload_hash, approved.payload_hash);
    assert_eq!(approvals[0].decision, OperationApprovalDecision::Approved);
    assert!(repository.verify_event_chain(approved.id).await.unwrap());
    assert!(repository
        .decide_approval(approval_command(
            &approved,
            runtime_id,
            OperationActorKind::LocalUser,
            OperationApprovalDecision::Approved,
        ))
        .await
        .is_err());
    assert_eq!(repository.approvals(approved.id).await.unwrap().len(), 1);

    let executing = repository
        .claim_execution(approved.id, runtime_id, Utc::now())
        .await
        .unwrap();
    assert_eq!(executing.state, OperationState::Executing);
}

#[tokio::test]
async fn approval_insert_rolls_back_when_projection_transition_fails() {
    let (repository, pool) = repository().await;
    let runtime_id = Uuid::new_v4();
    let operation = repository
        .insert_planned(
            runtime_id,
            operation(OperationKind::WriteSql, runtime_id, "approval-rollback"),
        )
        .await
        .unwrap();
    let pending = repository
        .transition(
            operation.id,
            runtime_id,
            OperationState::PendingApproval,
            &json!({}),
        )
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TRIGGER fixture_block_operation_state
             BEFORE UPDATE OF state ON operations
             BEGIN
                 SELECT RAISE(ABORT, 'fixture transition failure');
             END;",
    )
    .execute(&pool)
    .await
    .unwrap();

    assert!(repository
        .decide_approval(approval_command(
            &pending,
            runtime_id,
            OperationActorKind::LocalUser,
            OperationApprovalDecision::Approved,
        ))
        .await
        .is_err());
    assert!(repository.approvals(pending.id).await.unwrap().is_empty());
    assert_eq!(
        repository.get(pending.id).await.unwrap().state,
        OperationState::PendingApproval
    );
}

#[tokio::test]
async fn rejection_is_a_terminal_append_only_decision() {
    let (repository, _) = repository().await;
    let runtime_id = Uuid::new_v4();
    let operation = repository
        .insert_planned(
            runtime_id,
            operation(OperationKind::Ddl, runtime_id, "reject"),
        )
        .await
        .unwrap();
    let pending = repository
        .transition(
            operation.id,
            runtime_id,
            OperationState::PendingApproval,
            &json!({}),
        )
        .await
        .unwrap();
    let rejected = repository
        .decide_approval(approval_command(
            &pending,
            runtime_id,
            OperationActorKind::WorkspaceUser,
            OperationApprovalDecision::Rejected,
        ))
        .await
        .unwrap();
    assert_eq!(rejected.state, OperationState::Rejected);
    assert_eq!(repository.approvals(rejected.id).await.unwrap().len(), 1);
    assert!(repository
        .claim_execution(rejected.id, runtime_id, Utc::now())
        .await
        .is_err());
}

#[tokio::test]
async fn restart_recovery_never_retries_an_uncertain_mutation() {
    let (repository, _) = repository().await;
    let previous_runtime = Uuid::new_v4();
    let current_runtime = Uuid::new_v4();

    let stale_plan = repository
        .insert_planned(
            previous_runtime,
            operation(OperationKind::ReadQuery, previous_runtime, "stale-plan"),
        )
        .await
        .unwrap();

    let read = repository
        .insert_planned(
            previous_runtime,
            operation(
                OperationKind::ReadQuery,
                previous_runtime,
                "interrupted-read",
            ),
        )
        .await
        .unwrap();
    let read = repository
        .transition(read.id, previous_runtime, OperationState::Ready, &json!({}))
        .await
        .unwrap();
    repository
        .claim_execution(read.id, previous_runtime, Utc::now())
        .await
        .unwrap();

    let write = repository
        .insert_planned(
            previous_runtime,
            operation(
                OperationKind::WriteSql,
                previous_runtime,
                "interrupted-write",
            ),
        )
        .await
        .unwrap();
    let write = repository
        .transition(
            write.id,
            previous_runtime,
            OperationState::PendingApproval,
            &json!({}),
        )
        .await
        .unwrap();
    let write = repository
        .decide_approval(approval_command(
            &write,
            previous_runtime,
            OperationActorKind::LocalUser,
            OperationApprovalDecision::Approved,
        ))
        .await
        .unwrap();
    repository
        .claim_execution(write.id, previous_runtime, Utc::now())
        .await
        .unwrap();

    let import = repository
        .insert_planned(
            previous_runtime,
            operation(
                OperationKind::Import,
                previous_runtime,
                "interrupted-import",
            ),
        )
        .await
        .unwrap();
    let import = repository
        .transition(
            import.id,
            previous_runtime,
            OperationState::PendingApproval,
            &json!({}),
        )
        .await
        .unwrap();
    let import = repository
        .decide_approval(approval_command(
            &import,
            previous_runtime,
            OperationActorKind::LocalUser,
            OperationApprovalDecision::Approved,
        ))
        .await
        .unwrap();
    repository
        .claim_execution(import.id, previous_runtime, Utc::now())
        .await
        .unwrap();

    let report = repository
        .recover_previous_runtimes(current_runtime)
        .await
        .unwrap();
    assert_eq!(report.expired, vec![stale_plan.id]);
    assert_eq!(report.failed, vec![read.id]);
    assert_eq!(report.outcome_unknown, vec![write.id, import.id]);
    assert!(report.checkpoint_validation_required.is_empty());
    assert_eq!(
        repository.get(write.id).await.unwrap().state,
        OperationState::OutcomeUnknown
    );
    assert_eq!(
        repository.get(import.id).await.unwrap().state,
        OperationState::OutcomeUnknown
    );
    assert!(repository.verify_event_chain(write.id).await.unwrap());
    assert!(repository
        .claim_execution(write.id, current_runtime, Utc::now())
        .await
        .is_err());
}

#[tokio::test]
async fn hash_chain_and_payload_loader_detect_out_of_band_tampering() {
    let (repository, pool) = repository().await;
    let runtime_id = Uuid::new_v4();
    let record = repository
        .insert_planned(
            runtime_id,
            operation(OperationKind::ReadQuery, runtime_id, "tamper"),
        )
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER operation_events_reject_update")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE operation_events SET event_json = '{\"tampered\":true}'
             WHERE operation_id = ?1 AND sequence = 1",
    )
    .bind(record.id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    assert!(!repository.verify_event_chain(record.id).await.unwrap());

    sqlx::query("DROP TRIGGER operations_reject_immutable_update")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE operations SET payload_json = '{\"sql\":\"SELECT 2\"}' WHERE id = ?1")
        .bind(record.id.to_string())
        .execute(&pool)
        .await
        .unwrap();
    assert!(repository.get(record.id).await.is_err());
}

#[tokio::test]
async fn progress_keeps_projection_state_and_extends_the_hash_chain() {
    let (repository, _) = repository().await;
    let runtime_id = Uuid::new_v4();
    let operation = repository
        .insert_planned(
            runtime_id,
            operation(OperationKind::Export, runtime_id, "progress"),
        )
        .await
        .unwrap();
    let operation = repository
        .transition(operation.id, runtime_id, OperationState::Ready, &json!({}))
        .await
        .unwrap();
    let operation = repository
        .claim_execution(operation.id, runtime_id, Utc::now())
        .await
        .unwrap();
    let event = repository
        .append_progress(operation.id, runtime_id, &json!({"completedRows": 100}))
        .await
        .unwrap();
    assert_eq!(event.kind, OperationEventKind::Progress);
    assert_eq!(event.state, OperationState::Executing);
    assert_eq!(
        repository.get(operation.id).await.unwrap().state,
        OperationState::Executing
    );
    assert!(repository.verify_event_chain(operation.id).await.unwrap());
}
