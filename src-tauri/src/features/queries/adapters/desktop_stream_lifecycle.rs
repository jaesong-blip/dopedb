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
