//! Owned, bounded cleanup for an aborted desktop SQL stream task.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;

use crate::executor;
use crate::kernel::identity::OperationId;
use crate::kernel::sync::lock_unpoisoned;
use crate::operations::OperationRuntime;

use super::desktop_stream_registry::DesktopSqlStreamRegistry;

const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Eq, PartialEq)]
enum CleanupSignal {
    Running,
    Complete,
    Abort,
}

struct CleanupEntry {
    signal: watch::Sender<CleanupSignal>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct CleanupState {
    entries: Mutex<HashMap<OperationId, CleanupEntry>>,
}

/// Composition-owned janitor. Every abort cleanup task remains tracked here
/// until its bounded terminal transition completes; no finalizer Drop detaches
/// an unowned task.
#[derive(Clone, Default)]
pub(crate) struct DesktopStreamCleanupRuntime {
    state: Arc<CleanupState>,
}

/// Composition-only owner. Its final drop requests a bounded abort for every
/// active stream; the tracked worker owns durable terminalization afterwards.
#[derive(Clone)]
pub(crate) struct DesktopStreamCleanupOwner {
    runtime: DesktopStreamCleanupRuntime,
    owners: Arc<()>,
}

pub(super) struct StreamOperationFinalizer {
    runtime: DesktopStreamCleanupRuntime,
    operation_id: OperationId,
    settled: bool,
}

impl DesktopStreamCleanupRuntime {
    pub(super) fn arm(
        &self,
        operation: OperationRuntime,
        streams: DesktopSqlStreamRegistry,
        operation_id: OperationId,
    ) -> StreamOperationFinalizer {
        let (signal, mut receiver) = watch::channel(CleanupSignal::Running);
        let state = self.state.clone();
        let task = tokio::spawn(async move {
            let _ = receiver.changed().await;
            if *receiver.borrow() == CleanupSignal::Abort {
                streams.close(operation_id);
                executor::cancel::cancel(operation_id.into());
                let cancelled = tokio::time::timeout(
                    CLEANUP_TIMEOUT,
                    operation.confirm_cancelled(
                        operation_id.into(),
                        &serde_json::json!({"reason":"desktop_stream_task_aborted"}),
                    ),
                )
                .await;
                if !matches!(cancelled, Ok(Ok(_))) {
                    let _ = tokio::time::timeout(
                        CLEANUP_TIMEOUT,
                        operation.mark_outcome_unknown(
                            operation_id.into(),
                            &serde_json::json!({"reason":"desktop_stream_abort_cleanup_incomplete"}),
                        ),
                    )
                    .await;
                }
            }
            lock_unpoisoned(&state.entries).remove(&operation_id);
        });
        lock_unpoisoned(&self.state.entries).insert(operation_id, CleanupEntry { signal, task });
        StreamOperationFinalizer {
            runtime: self.clone(),
            operation_id,
            settled: false,
        }
    }

    fn abort(&self, operation_id: OperationId) {
        if let Some(entry) = lock_unpoisoned(&self.state.entries).get(&operation_id) {
            let _ = entry.signal.send(CleanupSignal::Abort);
        }
    }

    fn abort_all(&self) {
        for entry in lock_unpoisoned(&self.state.entries).values() {
            let _ = entry.signal.send(CleanupSignal::Abort);
        }
    }

    async fn complete(&self, operation_id: OperationId) {
        let entry = {
            let mut entries = lock_unpoisoned(&self.state.entries);
            match entries.get(&operation_id) {
                // Shutdown/abort is terminal and must never be overwritten by
                // a normal completion racing from the owner future.
                Some(entry) if *entry.signal.borrow() == CleanupSignal::Abort => None,
                Some(_) => entries.remove(&operation_id),
                None => None,
            }
        };
        if let Some(entry) = entry {
            let _ = entry.signal.send(CleanupSignal::Complete);
            let _ = tokio::time::timeout(CLEANUP_TIMEOUT, entry.task).await;
        }
    }

    pub(crate) fn composition_owner(&self) -> DesktopStreamCleanupOwner {
        DesktopStreamCleanupOwner {
            runtime: self.clone(),
            owners: Arc::new(()),
        }
    }

    /// Tauri Exit invokes this before runtime teardown. It broadcasts abort,
    /// then waits only a bounded interval for every tracked owner task to drop
    /// its lease and persist Cancelled/OutcomeUnknown.
    pub(crate) async fn shutdown_and_drain(&self, timeout: Duration) {
        self.abort_all();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if lock_unpoisoned(&self.state.entries).is_empty() {
                return;
            }
            let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now())
            else {
                return;
            };
            tokio::time::sleep(remaining.min(Duration::from_millis(10))).await;
        }
    }

    #[cfg(test)]
    pub(super) fn active_count(&self) -> usize {
        lock_unpoisoned(&self.state.entries).len()
    }
}

impl Drop for DesktopStreamCleanupOwner {
    fn drop(&mut self) {
        if Arc::strong_count(&self.owners) == 1 {
            self.runtime.abort_all();
        }
    }
}

impl StreamOperationFinalizer {
    pub(super) async fn disarm(&mut self) {
        if !self.settled {
            self.settled = true;
            self.runtime.complete(self.operation_id).await;
        }
    }
}

impl Drop for StreamOperationFinalizer {
    fn drop(&mut self) {
        if !self.settled {
            self.runtime.abort(self.operation_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration as ChronoDuration, Utc};
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use uuid::Uuid;

    use crate::operations::{
        NewOperation, OperationActor, OperationActorKind, OperationActorProvenance, OperationKind,
        OperationPlanDisposition, OperationRiskLevel, OperationState,
    };
    use crate::store::{Store, TEST_SCHEMA};

    fn operation() -> NewOperation {
        NewOperation {
            id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            account_scope: "personal".into(),
            connection_id: Uuid::new_v4(),
            connection_revision: 1,
            terminal_session_id: None,
            actor: OperationActor {
                kind: OperationActorKind::LocalUser,
                id: "test".into(),
                provenance: OperationActorProvenance {
                    origin_surface: "test".into(),
                    ..OperationActorProvenance::default()
                },
            },
            kind: OperationKind::ReadQuery,
            payload_schema_version: 1,
            payload: json!({"sql":"SELECT 1"}),
            schema_fingerprint: None,
            risk_level: OperationRiskLevel::Low,
            preview: json!({}),
            policy_snapshot: json!({}),
            policy_revision: "test".into(),
            single_use: true,
            idempotency_key: Uuid::new_v4().to_string(),
            expires_at: Some(Utc::now() + ChronoDuration::minutes(1)),
        }
    }

    #[tokio::test]
    async fn aborting_the_owner_task_closes_credit_and_finishes_operation() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::from_str("sqlite::memory:")
                    .unwrap()
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
        let store = Store::from_pool_for_test(pool);
        let (runtime, _) = OperationRuntime::new(&store);
        let planned = runtime
            .plan(operation(), OperationPlanDisposition::Ready)
            .await
            .unwrap();
        runtime.claim(planned.id).await.unwrap();
        let operation_id = OperationId::from(planned.id);
        let streams = DesktopSqlStreamRegistry::default();
        streams
            .reserve(operation_id, "main".into(), "a".repeat(64))
            .unwrap();
        let cleanup = DesktopStreamCleanupRuntime::default();
        let task = tokio::spawn({
            let cleanup = cleanup.clone();
            let runtime = runtime.clone();
            let streams = streams.clone();
            async move {
                let _guard = cleanup.arm(runtime, streams, operation_id);
                std::future::pending::<()>().await;
            }
        });
        tokio::task::yield_now().await;
        assert_eq!(cleanup.active_count(), 1);
        task.abort();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if runtime.get(planned.id).await.unwrap().state != OperationState::Executing {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("owned cleanup must reach a terminal operation state");
        assert_eq!(
            runtime.get(planned.id).await.unwrap().state,
            OperationState::Cancelled
        );
        assert_eq!(streams.active_count(), 0);
        assert_eq!(cleanup.active_count(), 0);
        assert!(!executor::cancel::cancel(planned.id));
    }

    #[tokio::test]
    async fn shutdown_drains_owner_task_before_the_runtime_can_exit() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::from_str("sqlite::memory:")
                    .unwrap()
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
        let store = Store::from_pool_for_test(pool);
        let (runtime, _) = OperationRuntime::new(&store);
        let planned = runtime
            .plan(operation(), OperationPlanDisposition::Ready)
            .await
            .unwrap();
        runtime.claim(planned.id).await.unwrap();
        let operation_id = OperationId::from(planned.id);
        let streams = DesktopSqlStreamRegistry::default();
        streams
            .reserve(operation_id, "main".into(), "b".repeat(64))
            .unwrap();
        let cleanup = DesktopStreamCleanupRuntime::default();
        let cancellation = executor::cancel::register(planned.id);
        let owner = tokio::spawn({
            let cleanup = cleanup.clone();
            let runtime = runtime.clone();
            let streams = streams.clone();
            async move {
                let _guard = cleanup.arm(runtime, streams, operation_id);
                cancellation.cancelled().await;
            }
        });
        tokio::task::yield_now().await;
        cleanup.shutdown_and_drain(Duration::from_secs(3)).await;
        tokio::time::timeout(Duration::from_secs(3), owner)
            .await
            .expect("shutdown must wake and join the stream owner")
            .unwrap();
        assert_eq!(streams.active_count(), 0);
        assert_eq!(cleanup.active_count(), 0);
        assert_ne!(
            runtime.get(planned.id).await.unwrap().state,
            OperationState::Executing
        );
    }

    #[tokio::test]
    async fn dropping_the_composition_owner_requests_the_same_abort_path() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::from_str("sqlite::memory:")
                    .unwrap()
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
        let store = Store::from_pool_for_test(pool);
        let (runtime, _) = OperationRuntime::new(&store);
        let planned = runtime
            .plan(operation(), OperationPlanDisposition::Ready)
            .await
            .unwrap();
        runtime.claim(planned.id).await.unwrap();
        let operation_id = OperationId::from(planned.id);
        let streams = DesktopSqlStreamRegistry::default();
        streams
            .reserve(operation_id, "main".into(), "c".repeat(64))
            .unwrap();
        let cleanup = DesktopStreamCleanupRuntime::default();
        let composition_owner = cleanup.composition_owner();
        let cancellation = executor::cancel::register(planned.id);
        let owner = tokio::spawn({
            let cleanup = cleanup.clone();
            let runtime = runtime.clone();
            let streams = streams.clone();
            async move {
                let _guard = cleanup.arm(runtime, streams, operation_id);
                cancellation.cancelled().await;
            }
        });
        tokio::task::yield_now().await;
        drop(composition_owner);
        tokio::time::timeout(Duration::from_secs(3), owner)
            .await
            .expect("composition drop must wake the stream owner")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while cleanup.active_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("tracked cleanup must reach terminal state after composition drop");
        assert_eq!(streams.active_count(), 0);
        assert_ne!(
            runtime.get(planned.id).await.unwrap().state,
            OperationState::Executing
        );
    }
}
