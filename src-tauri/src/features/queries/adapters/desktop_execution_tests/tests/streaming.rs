use super::*;

async fn latest_operation_id(harness: &SqliteHarness) -> crate::kernel::identity::OperationId {
    let id = sqlx::query_scalar::<_, String>(
        "SELECT id FROM operations WHERE connection_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(harness.connection_id.to_string())
    .fetch_one(harness.store.pool())
    .await
    .expect("the durable desktop proposal must be persisted");
    crate::kernel::identity::OperationId::from(
        uuid::Uuid::parse_str(&id).expect("stored operation id must remain a UUID"),
    )
}

async fn audit_len(harness: &SqliteHarness) -> usize {
    let (entries, valid, first_bad) = crate::audit::snapshot(&harness.store, harness.connection_id)
        .await
        .expect("audit snapshot must remain readable");
    assert!(valid);
    assert_eq!(first_bad, None);
    entries.len()
}

fn auto_read_feature(harness: &SqliteHarness) -> crate::features::queries::QueriesFeature {
    crate::features::queries::compose(
        harness.store.clone(),
        harness.connections.clone(),
        harness.operation.clone(),
    )
}

#[tokio::test]
async fn desktop_read_stream_waits_for_ack_then_records_the_legacy_read_outcome() {
    let harness = SqliteHarness::new().await;
    let proposal = harness
        .propose("SELECT id, name FROM users ORDER BY id", Some("data-view"))
        .await
        .unwrap();
    let operation_id = proposal.operation_id;
    harness
        .service
        .desktop_streams
        .reserve(operation_id, "test-webview".into(), "a".repeat(64))
        .unwrap();
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    let service = harness.service.clone();
    let task = tokio::spawn(async move {
        service
            .run_desktop_sql_stream(
                operation_id,
                "test-webview".into(),
                "a".repeat(64),
                move |ready| {
                    sender
                        .try_send(ready)
                        .map_err(|_| DesktopSqlStreamSinkError::ReceiverDropped)
                },
            )
            .await
    });
    let batch = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
        .await
        .expect("the first bounded batch must arrive")
        .expect("the stream sender must remain live");
    assert_eq!(batch.sequence, 0);
    let page = harness
        .service
        .desktop_streams
        .pull(
            operation_id,
            batch.sequence,
            &batch.capability,
            "test-webview",
        )
        .expect("the owner can pull the retained page once");
    assert_eq!(page.columns, ["id", "name"]);
    assert_eq!(page.rows.len(), 2);
    assert!(harness.service.desktop_streams.acknowledge(
        operation_id,
        batch.sequence,
        &batch.capability,
        "test-webview",
    ));
    assert_eq!(task.await.unwrap().unwrap().row_count, 2);
    let history = harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap();
    assert_eq!(history[0].row_count, Some(2));
    harness.close().await;
}

#[tokio::test]
async fn aborting_the_real_stream_task_cancels_operation_and_releases_its_lease() {
    let harness = SqliteHarness::new().await;
    let proposal = harness
        .propose("SELECT id, name FROM users", None)
        .await
        .unwrap();
    let operation_id = proposal.operation_id;
    harness
        .service
        .desktop_streams
        .reserve(operation_id, "test-webview".into(), "b".repeat(64))
        .unwrap();
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    let service = harness.service.clone();
    let task = tokio::spawn(async move {
        service
            .run_desktop_sql_stream(
                operation_id,
                "test-webview".into(),
                "b".repeat(64),
                move |ready| {
                    sender
                        .try_send(ready)
                        .map_err(|_| DesktopSqlStreamSinkError::ReceiverDropped)
                },
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(1), receiver.recv())
        .await
        .expect("the task must own an active query and lease before aborting");
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if harness
                .operation
                .get(operation_id.into())
                .await
                .unwrap()
                .state
                != OperationState::Executing
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the owned cleanup must durably finish the aborted operation");
    assert_eq!(
        harness
            .operation
            .get(operation_id.into())
            .await
            .unwrap()
            .state,
        OperationState::Cancelled
    );
    assert_eq!(harness.service.desktop_streams.active_count(), 0);
    assert_eq!(harness.user_name(1).await, "Ada");
    harness.close().await;
}

#[tokio::test]
async fn auto_read_cancel_during_deferred_proposal_never_reaches_target_execution() {
    let harness = SqliteHarness::new().await;
    let queries = auto_read_feature(&harness);
    let capability = "c".repeat(64);
    queries
        .reserve_pending_desktop_sql_stream("test-webview".into(), capability.clone())
        .unwrap();
    let (proposed, proposed_id) = tokio::sync::oneshot::channel();
    let (resume, resume_proposal) = tokio::sync::oneshot::channel();
    let task_queries = queries.clone();
    let task = tokio::spawn(async move {
        task_queries
            .run_desktop_sql_read_stream_after_proposal(
                crate::features::queries::DesktopSqlProposalRequest {
                    connection_id: harness.connection_id.into(),
                    sql: "SELECT id, name FROM users ORDER BY id".into(),
                    origin: Some("data-view".into()),
                },
                "test-webview".into(),
                capability,
                |_| Ok(()),
                move |operation_id| async move {
                    proposed.send(operation_id).unwrap();
                    resume_proposal
                        .await
                        .expect("test must resume the deferred proposal handoff");
                },
            )
            .await
    });
    let operation_id = tokio::time::timeout(Duration::from_secs(1), proposed_id)
        .await
        .expect("the durable auto-read proposal must be created before binding")
        .unwrap();
    assert_eq!(
        harness
            .operation
            .get(operation_id.into())
            .await
            .unwrap()
            .state,
        OperationState::Ready
    );
    assert!(queries.cancel_pending_desktop_sql_stream(&"c".repeat(64), "test-webview"));
    resume.send(()).unwrap();
    let error = match task.await.unwrap() {
        Err(error) => error,
        Ok(_) => panic!("the pending cancellation must preserve the stream binding error"),
    };
    assert!(matches!(
        error,
        crate::error::AppError::Safety(ref reason) if reason == "query cancelled"
    ));
    assert_eq!(
        harness
            .operation
            .get(operation_id.into())
            .await
            .unwrap()
            .state,
        OperationState::Cancelled
    );
    assert!(queries
        .pull_desktop_sql_stream(operation_id, 0, &"c".repeat(64), "test-webview")
        .is_none());
    assert!(harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap()
        .is_empty());
    assert!(!crate::executor::cancel::cancel(operation_id.into()));
    drop(queries);
    harness.close().await;
}

#[tokio::test]
async fn explicit_read_workflow_cancels_the_unreturned_ready_operation_without_target_touch() {
    let harness = SqliteHarness::new().await;
    let queries = auto_read_feature(&harness);
    let capability = "d".repeat(64);
    let mut settings = harness
        .store
        .get_safety(harness.connection_id)
        .await
        .unwrap();
    settings.auto_run_reads = false;
    settings.explain_preview = false;
    harness
        .store
        .set_safety(harness.connection_id, &settings)
        .await
        .unwrap();
    let before = audit_len(&harness).await;
    queries
        .reserve_pending_desktop_sql_stream("test-webview".into(), capability.clone())
        .unwrap();
    let result = queries
        .run_desktop_sql_read_stream(
            crate::features::queries::DesktopSqlProposalRequest {
                connection_id: harness.connection_id.into(),
                sql: "SELECT id, name FROM users ORDER BY id".into(),
                origin: Some("data-view".into()),
            },
            "test-webview".into(),
            capability.clone(),
            |_| Ok(()),
        )
        .await;
    assert!(matches!(
        result,
        Err(crate::error::AppError::ProposalRequired)
    ));
    let operation_id = latest_operation_id(&harness).await;
    assert_eq!(
        harness
            .operation
            .get(operation_id.into())
            .await
            .unwrap()
            .state,
        OperationState::Cancelled
    );
    assert!(harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(audit_len(&harness).await, before);
    assert!(!queries.cancel_pending_desktop_sql_stream(&capability, "test-webview"));
    assert!(queries
        .pull_desktop_sql_stream(operation_id, 0, &capability, "test-webview")
        .is_none());
    drop(queries);
    harness.close().await;
}

#[tokio::test]
async fn explicit_write_workflow_cancels_the_unreturned_pending_approval_operation() {
    let harness = SqliteHarness::new().await;
    let queries = auto_read_feature(&harness);
    let capability = "e".repeat(64);
    let mut profile = harness.profile.clone();
    profile.allow_writes = true;
    harness.store.upsert_connection(&profile).await.unwrap();
    let settings = crate::model::SafetySettings {
        allow_writes: true,
        require_approval: true,
        explain_preview: false,
        ..crate::model::SafetySettings::default()
    };
    harness
        .store
        .set_safety(harness.connection_id, &settings)
        .await
        .unwrap();
    let before = audit_len(&harness).await;
    queries
        .reserve_pending_desktop_sql_stream("test-webview".into(), capability.clone())
        .unwrap();
    let result = queries
        .run_desktop_sql_read_stream(
            crate::features::queries::DesktopSqlProposalRequest {
                connection_id: harness.connection_id.into(),
                sql: "UPDATE users SET name = 'Grace' WHERE id = 1".into(),
                origin: Some("data-view".into()),
            },
            "test-webview".into(),
            capability.clone(),
            |_| Ok(()),
        )
        .await;
    assert!(matches!(
        result,
        Err(crate::error::AppError::Blocked { .. })
    ));
    let operation_id = latest_operation_id(&harness).await;
    assert_eq!(
        harness
            .operation
            .get(operation_id.into())
            .await
            .unwrap()
            .state,
        OperationState::Cancelled
    );
    assert_eq!(harness.user_name(1).await, "Ada");
    assert!(harness
        .store
        .list_history(harness.connection_id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(audit_len(&harness).await, before);
    assert!(!queries.cancel_pending_desktop_sql_stream(&capability, "test-webview"));
    drop(queries);
    harness.close().await;
}
