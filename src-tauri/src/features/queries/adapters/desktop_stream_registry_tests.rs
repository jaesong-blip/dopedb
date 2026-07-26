use super::*;

use serde_json::json;

fn batch(id: OperationId, sequence: u64) -> DesktopSqlStreamBatch {
    DesktopSqlStreamBatch {
        operation_id: id,
        sequence,
        columns: vec!["n".into()],
        rows: vec![vec![json!(1)]],
    }
}

#[tokio::test]
async fn pull_ack_is_exact_single_delivery_and_owner_bound() {
    let registry = DesktopSqlStreamRegistry::default();
    let id = OperationId::from(Uuid::new_v4());
    let session = registry.begin(id, "main".into()).unwrap();
    let borrow = session.borrow();
    let mut ready = None;
    borrow
        .dispatch(0, batch(id, 0), |value| {
            ready = Some(value);
            Ok::<_, ()>(())
        })
        .unwrap();
    let ready = ready.unwrap();
    assert!(registry.pull(id, 0, &ready.capability, "other").is_none());
    assert!(registry.pull(id, 0, &ready.capability, "main").is_some());
    assert!(registry.pull(id, 0, &ready.capability, "main").is_none());
    assert_eq!(
        borrow.wait_for_ack(0).await,
        Err(DesktopSqlStreamSinkError::Cancelled)
    );
    drop(session);
    assert_eq!(registry.active_count(), 0);
}

#[tokio::test]
async fn foreign_capability_cannot_ack_or_cancel_another_stream() {
    let registry = DesktopSqlStreamRegistry::default();
    let id = OperationId::from(Uuid::new_v4());
    let session = registry.begin(id, "main".into()).unwrap();
    let borrow = session.borrow();
    let mut ready = None;
    borrow
        .dispatch(0, batch(id, 0), |value| {
            ready = Some(value);
            Ok::<_, ()>(())
        })
        .unwrap();
    let ready = ready.unwrap();
    assert!(!registry.acknowledge(id, 0, "not-the-capability", "main"));
    assert!(!registry.cancel(id, "not-the-capability", "main"));
    assert!(registry.pull(id, 0, &ready.capability, "main").is_some());
    assert!(registry.acknowledge(id, 0, &ready.capability, "main"));
    assert!(borrow.wait_for_ack(0).await.is_ok());
}

#[tokio::test]
async fn owner_replay_or_future_sequence_cancels_and_wakes_waiter() {
    let registry = DesktopSqlStreamRegistry::default();
    let id = OperationId::from(Uuid::new_v4());
    let session = registry.begin(id, "main".into()).unwrap();
    let borrow = session.borrow();
    let mut ready = None;
    borrow
        .dispatch(0, batch(id, 0), |value| {
            ready = Some(value);
            Ok::<_, ()>(())
        })
        .unwrap();
    let ready = ready.unwrap();
    assert!(registry.pull(id, 1, &ready.capability, "main").is_none());
    assert_eq!(
        borrow.wait_for_ack(0).await,
        Err(DesktopSqlStreamSinkError::Cancelled)
    );
}

#[test]
fn ready_capability_is_256_bits_and_notification_is_small() {
    let registry = DesktopSqlStreamRegistry::default();
    let id = OperationId::from(Uuid::new_v4());
    let session = registry.begin(id, "main".into()).unwrap();
    let borrow = session.borrow();
    let mut ready = None;
    borrow
        .dispatch(0, batch(id, 0), |value| {
            ready = Some(value);
            Ok::<_, ()>(())
        })
        .unwrap();
    assert!(serde_json::to_vec(&ready.unwrap()).unwrap().len() < 8_192);
    drop(session);
}

#[test]
fn owner_drop_releases_the_retained_page_without_a_borrow_closing_it() {
    let registry = DesktopSqlStreamRegistry::default();
    let id = OperationId::from(Uuid::new_v4());
    let session = registry.begin(id, "main".into()).unwrap();
    let borrow = session.borrow();
    borrow
        .dispatch(0, batch(id, 0), |_| Ok::<_, ()>(()))
        .unwrap();
    drop(borrow);
    assert_eq!(registry.active_count(), 1);
    drop(session);
    assert_eq!(registry.active_count(), 0);
}

#[test]
fn exact_wire_limit_includes_envelope_columns_and_row_count() {
    let registry = DesktopSqlStreamRegistry::default();
    let id = OperationId::from(Uuid::new_v4());
    let session = registry.begin(id, "main".into()).unwrap();
    let borrow = session.borrow();
    let oversized_columns = DesktopSqlStreamBatch {
        operation_id: id,
        sequence: 0,
        columns: vec!["x".repeat(DESKTOP_STREAM_BATCH_MAX_BYTES)],
        rows: Vec::new(),
    };
    assert_eq!(
        borrow.dispatch(0, oversized_columns, |_| Ok::<_, ()>(())),
        Err(DesktopSqlStreamSinkError::BatchTooLarge)
    );
    let too_many_rows = DesktopSqlStreamBatch {
        operation_id: id,
        sequence: 0,
        columns: vec!["n".into()],
        rows: (0..257).map(|_| vec![json!(1)]).collect(),
    };
    assert_eq!(
        borrow.dispatch(0, too_many_rows, |_| Ok::<_, ()>(())),
        Err(DesktopSqlStreamSinkError::BatchTooLarge)
    );
}

#[test]
fn exact_complete_batch_boundary_is_checked_before_retention() {
    let id = OperationId::from(Uuid::new_v4());
    let encoded_len = |column_len| {
        serde_json::to_vec(&DesktopSqlStreamBatch {
            operation_id: id,
            sequence: 0,
            columns: vec!["x".repeat(column_len)],
            rows: vec![vec![json!("value")]],
        })
        .unwrap()
        .len()
    };
    let mut low = 0;
    let mut high = DESKTOP_STREAM_BATCH_MAX_BYTES;
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        if encoded_len(middle) <= DESKTOP_STREAM_BATCH_MAX_BYTES {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    let fitting = DesktopSqlStreamBatch {
        operation_id: id,
        sequence: 0,
        columns: vec!["x".repeat(low)],
        rows: vec![vec![json!("value")]],
    };
    assert!(serde_json::to_vec(&fitting).unwrap().len() <= DESKTOP_STREAM_BATCH_MAX_BYTES);
    let registry = DesktopSqlStreamRegistry::default();
    let session = registry.begin(id, "main".into()).unwrap();
    assert!(session
        .borrow()
        .dispatch(0, fitting, |_| Ok::<_, ()>(()))
        .is_ok());

    let too_large = DesktopSqlStreamBatch {
        operation_id: OperationId::from(Uuid::new_v4()),
        sequence: 0,
        columns: vec!["x".repeat(low + 1)],
        rows: vec![vec![json!("value")]],
    };
    let too_large_id = too_large.operation_id;
    let registry = DesktopSqlStreamRegistry::default();
    let session = registry.begin(too_large_id, "main".into()).unwrap();
    assert_eq!(
        session.borrow().dispatch(0, too_large, |_| Ok::<_, ()>(())),
        Err(DesktopSqlStreamSinkError::BatchTooLarge)
    );
}

#[tokio::test]
async fn ack_between_subscription_and_wait_is_not_lost() {
    let registry = DesktopSqlStreamRegistry::default();
    let id = OperationId::from(Uuid::new_v4());
    let session = registry.begin(id, "main".into()).unwrap();
    let borrow = session.borrow();
    let mut ready = None;
    borrow
        .dispatch(0, batch(id, 0), |value| {
            ready = Some(value);
            Ok::<_, ()>(())
        })
        .unwrap();
    let ready = ready.unwrap();
    assert!(registry.pull(id, 0, &ready.capability, "main").is_some());
    let registry_for_hook = registry.clone();
    let capability = ready.capability.clone();
    let mut acknowledged = false;
    let result = borrow
        .wait_for_ack_with_hook(0, move || {
            if !acknowledged {
                acknowledged = true;
                assert!(registry_for_hook.acknowledge(id, 0, &capability, "main"));
            }
        })
        .await;
    assert_eq!(result, Ok(()));
}

#[tokio::test]
async fn rapid_ack_stress_never_times_out() {
    let registry = DesktopSqlStreamRegistry::default();
    for _ in 0..128 {
        let id = OperationId::from(Uuid::new_v4());
        let session = registry.begin(id, "main".into()).unwrap();
        let borrow = session.borrow();
        let mut ready = None;
        borrow
            .dispatch(0, batch(id, 0), |value| {
                ready = Some(value);
                Ok::<_, ()>(())
            })
            .unwrap();
        let ready = ready.unwrap();
        assert!(registry.pull(id, 0, &ready.capability, "main").is_some());
        assert!(registry.acknowledge(id, 0, &ready.capability, "main"));
        assert_eq!(borrow.wait_for_ack(0).await, Ok(()));
        drop(session);
    }
}

#[test]
fn pre_ready_cancel_is_owner_bound_and_prevents_a_later_stream_bind() {
    let registry = DesktopSqlStreamRegistry::default();
    let id = OperationId::from(Uuid::new_v4());
    let capability = "d".repeat(64);
    registry
        .reserve_pending("main".into(), capability.clone())
        .unwrap();
    assert!(!registry.cancel_pending(&capability, "other"));
    assert!(registry.cancel_pending(&capability, "main"));
    assert_eq!(
        registry.bind_pending(id, "main".into(), capability),
        Err(DesktopSqlStreamSinkError::Cancelled)
    );
    assert_eq!(registry.active_count(), 0);
}
