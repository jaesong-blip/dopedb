use std::collections::HashMap;
use std::str::FromStr;

use chrono::Utc;
use dopedb_protocol::{
    ObjectKind, ObjectRef, OperationActorKind, OperationKind, OperationRiskLevel,
};
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

use super::super::super::ports::{Checkpoint, JobAuthority, JobLedgerPort, NewCapability, NewJob};
use super::JobRepository;
use crate::features::jobs::domain::JobConsistency;
use crate::features::jobs::{
    JobFileDirection, JobFormat, JobKind, JobPlan, JobState, JobValidation,
};
use crate::kernel::identity::{JobId, OperationId};
use crate::model::{
    ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};
use crate::operations::{
    NewOperation, OperationActor, OperationActorProvenance, OperationPlanDisposition,
    OperationRuntime,
};
use crate::store::{Store, TEST_SCHEMA};

async fn plan_job_operation(
    store: &Store,
    authority: &JobAuthority,
    kind: OperationKind,
    key: &str,
) -> OperationId {
    let (runtime, _) = OperationRuntime::new(store);
    OperationId::from(
        runtime
            .plan(
                NewOperation {
                    id: Uuid::new_v4(),
                    workspace_id: authority.resource.workspace_id.into(),
                    account_scope: authority.account_scope.as_str().into(),
                    connection_id: authority.resource.connection_id.into(),
                    connection_revision: authority.connection_revision,
                    terminal_session_id: None,
                    actor: OperationActor {
                        kind: OperationActorKind::LocalUser,
                        id: "local-owner".into(),
                        provenance: OperationActorProvenance {
                            origin_surface: "job_test".into(),
                            ..OperationActorProvenance::default()
                        },
                    },
                    kind,
                    payload_schema_version: 1,
                    payload: json!({"format": "ndjson"}),
                    schema_fingerprint: Some("a".repeat(64)),
                    risk_level: OperationRiskLevel::Low,
                    preview: json!({}),
                    policy_snapshot: json!({"allowWrites": true}),
                    policy_revision: "test-policy".into(),
                    single_use: true,
                    idempotency_key: key.into(),
                    expires_at: None,
                },
                if kind.may_mutate_target() {
                    OperationPlanDisposition::ApprovalRequired
                } else {
                    OperationPlanDisposition::Ready
                },
            )
            .await
            .unwrap()
            .id,
    )
}

async fn fixture() -> (JobRepository, JobAuthority, OperationId) {
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
            name: "job fixture".into(),
            engine: Engine::Sqlite,
            provider: Provider::Generic,
            driver_id: Some("sqlx-sqlite".into()),
            host: String::new(),
            port: 0,
            database: ":memory:".into(),
            username: String::new(),
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
    let pin = store.pin_connection_for_read(connection_id).await.unwrap();
    let authority = JobAuthority {
        resource: crate::kernel::identity::WorkspaceConnectionId {
            workspace_id: pin.scope.workspace_id.into(),
            connection_id: pin.connection_id.into(),
        },
        account_scope: crate::kernel::identity::AccountScopeId::new(
            pin.scope.account_scope.storage_key(),
        )
        .unwrap(),
        connection_revision: pin.connection_revision,
        engine: pin.profile.engine,
        workspace_access: pin.profile.workspace_access,
    };
    let operation_id = plan_job_operation(
        &store,
        &authority,
        OperationKind::Export,
        &format!("job-test:{connection_id}"),
    )
    .await;
    (JobRepository::new(store), authority, operation_id)
}

#[tokio::test]
async fn progress_pause_resume_and_cancel_are_durable_and_append_only() {
    let (repository, authority, operation_id) = fixture().await;
    let job_id = JobId::from(Uuid::new_v4());
    let output_directory = tempfile::tempdir().unwrap();
    let capability = repository
        .create_capability(
            &authority,
            NewCapability {
                connection_id: authority.resource.connection_id,
                direction: JobFileDirection::Output,
                path: output_directory.path().join("items.ndjson"),
                display_name: "items.ndjson".into(),
                size_bytes: None,
                modified_at: None,
                source_sha256: None,
                expires_at: Utc::now() + chrono::Duration::hours(1),
            },
        )
        .await
        .unwrap();
    let created = repository
        .insert_job(
            &authority,
            NewJob {
                id: job_id,
                operation_id,
                connection_id: authority.resource.connection_id,
                kind: JobKind::Export,
                format: JobFormat::Ndjson,
                plan: JobPlan::Export {
                    capability_id: capability.id,
                    relation: ObjectRef {
                        catalog: None,
                        namespace: Some("main".into()),
                        name: "items".into(),
                        kind: ObjectKind::Table,
                        native_id: None,
                    },
                    consistency: JobConsistency::PerBatchCurrent,
                    columns: vec!["id".into()],
                    field_names: Vec::new(),
                    batch_size: 500,
                },
                source_summary: "main.items".into(),
                target_summary: "items.ndjson".into(),
                rows_total: Some(1_000),
                bytes_total: None,
                resumable: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(created.job.state, JobState::Queued);
    assert!(sqlx::query("UPDATE jobs SET plan_hash = ?1 WHERE id = ?2")
        .bind("f".repeat(64))
        .bind(job_id.to_string())
        .execute(repository.store.pool())
        .await
        .is_err());
    assert!(
        sqlx::query("UPDATE job_file_capabilities SET local_path = 'replaced' WHERE id = ?1")
            .bind(capability.id.to_string())
            .execute(repository.store.pool())
            .await
            .is_err()
    );

    repository.claim_running(&authority, job_id).await.unwrap();
    assert_eq!(
        repository
            .rollback_initial_start(job_id)
            .await
            .unwrap()
            .job
            .state,
        JobState::Queued
    );
    repository.claim_running(&authority, job_id).await.unwrap();
    repository
        .update_progress(
            job_id,
            500,
            4_096,
            Some(Checkpoint {
                source_fingerprint: "a".repeat(64),
                target_fingerprint: "b".repeat(64),
                value: json!({"rowsProcessed": 500}),
            }),
        )
        .await
        .unwrap();
    assert!(repository
        .update_progress(job_id, 499, 4_095, None)
        .await
        .is_err());
    assert!(repository
        .update_progress(
            job_id,
            500,
            4_096,
            Some(Checkpoint {
                source_fingerprint: "not-a-hash".into(),
                target_fingerprint: "b".repeat(64),
                value: json!({}),
            }),
        )
        .await
        .is_err());
    let requested = repository.request_pause(job_id).await.unwrap();
    assert_eq!(requested.job.state, JobState::PauseRequested);
    assert_eq!(
        repository.finish_pause(job_id).await.unwrap().job.state,
        JobState::Paused
    );

    repository.claim_running(&authority, job_id).await.unwrap();
    assert_eq!(
        repository.request_pause(job_id).await.unwrap().job.state,
        JobState::PauseRequested
    );
    assert_eq!(
        repository.request_cancel(job_id).await.unwrap().job.state,
        JobState::CancelRequested
    );
    repository
        .update_progress(job_id, 750, 6_144, None)
        .await
        .unwrap();
    assert_eq!(
        repository
            .finish(job_id, JobState::Cancelled, None, None)
            .await
            .unwrap()
            .job
            .state,
        JobState::Cancelled
    );

    let events = sqlx::query_scalar::<_, String>(
        "SELECT event_kind FROM job_events WHERE job_id = ?1 ORDER BY sequence",
    )
    .bind(job_id.to_string())
    .fetch_all(repository.store.pool())
    .await
    .unwrap();
    assert_eq!(
        events,
        vec![
            "queued",
            "started",
            "warning",
            "started",
            "progress",
            "warning",
            "paused",
            "resumed",
            "warning",
            "warning",
            "progress",
            "cancelled",
        ]
    );
    assert!(
        sqlx::query("UPDATE job_events SET event_json = '{}' WHERE job_id = ?1")
            .bind(job_id.to_string())
            .execute(repository.store.pool())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn restart_pauses_resumable_export_but_never_retries_import() {
    let (repository, authority, export_operation_id) = fixture().await;
    let directory = tempfile::tempdir().unwrap();
    let export_capability = repository
        .create_capability(
            &authority,
            NewCapability {
                connection_id: authority.resource.connection_id,
                direction: JobFileDirection::Output,
                path: directory.path().join("export.ndjson"),
                display_name: "export.ndjson".into(),
                size_bytes: None,
                modified_at: None,
                source_sha256: None,
                expires_at: Utc::now() + chrono::Duration::hours(1),
            },
        )
        .await
        .unwrap();
    let export_id = JobId::from(Uuid::new_v4());
    repository
        .insert_job(
            &authority,
            NewJob {
                id: export_id,
                operation_id: export_operation_id,
                connection_id: authority.resource.connection_id,
                kind: JobKind::Export,
                format: JobFormat::Ndjson,
                plan: JobPlan::Export {
                    capability_id: export_capability.id,
                    relation: ObjectRef {
                        catalog: None,
                        namespace: Some("main".into()),
                        name: "items".into(),
                        kind: ObjectKind::Table,
                        native_id: None,
                    },
                    consistency: JobConsistency::PerBatchCurrent,
                    columns: Vec::new(),
                    field_names: Vec::new(),
                    batch_size: 500,
                },
                source_summary: "main.items".into(),
                target_summary: "export.ndjson".into(),
                rows_total: None,
                bytes_total: None,
                resumable: true,
            },
        )
        .await
        .unwrap();
    repository
        .claim_running(&authority, export_id)
        .await
        .unwrap();
    repository
        .update_progress(
            export_id,
            500,
            4_096,
            Some(Checkpoint {
                source_fingerprint: "c".repeat(64),
                target_fingerprint: "d".repeat(64),
                value: json!({"rowsProcessed": 500}),
            }),
        )
        .await
        .unwrap();

    let import_operation_id = plan_job_operation(
        &repository.store,
        &authority,
        OperationKind::Import,
        "job-test:interrupted-import",
    )
    .await;
    let input_path = directory.path().join("input.ndjson");
    std::fs::write(&input_path, "{\"id\":1}\n").unwrap();
    let import_capability = repository
        .create_capability(
            &authority,
            NewCapability {
                connection_id: authority.resource.connection_id,
                direction: JobFileDirection::Input,
                path: input_path,
                display_name: "input.ndjson".into(),
                size_bytes: Some(9),
                modified_at: None,
                source_sha256: Some("b".repeat(64)),
                expires_at: Utc::now() + chrono::Duration::hours(1),
            },
        )
        .await
        .unwrap();
    let import_id = JobId::from(Uuid::new_v4());
    repository
        .insert_job(
            &authority,
            NewJob {
                id: import_id,
                operation_id: import_operation_id,
                connection_id: authority.resource.connection_id,
                kind: JobKind::Import,
                format: JobFormat::Ndjson,
                plan: JobPlan::Import {
                    capability_id: import_capability.id,
                    target_relation: Some(ObjectRef {
                        catalog: None,
                        namespace: Some("main".into()),
                        name: "items".into(),
                        kind: ObjectKind::Table,
                        native_id: None,
                    }),
                    mapping: Vec::new(),
                    validation: JobValidation::default(),
                    batch_size: 500,
                },
                source_summary: "input.ndjson".into(),
                target_summary: "main.items".into(),
                rows_total: None,
                bytes_total: Some(9),
                resumable: true,
            },
        )
        .await
        .unwrap();
    repository
        .claim_running(&authority, import_id)
        .await
        .unwrap();

    repository.recover_interrupted().await.unwrap();
    let export = repository.get_unscoped(export_id).await.unwrap();
    let import = repository.get_unscoped(import_id).await.unwrap();
    assert_eq!(export.job.state, JobState::Paused);
    assert_eq!(export.job.error_code.as_deref(), Some("runtime_restarted"));
    assert_eq!(import.job.state, JobState::Failed);
    assert_eq!(import.job.error_code.as_deref(), Some("outcome_unknown"));
    assert!(repository
        .latest_checkpoint(export_id)
        .await
        .unwrap()
        .is_some());
}
