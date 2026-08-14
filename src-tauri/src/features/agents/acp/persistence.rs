//! Workspace-scoped ACP session persistence port and ordered batch worker.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::error::AppResult;
use crate::kernel::access::{ActiveResourceScope, PinnedConnection};
use crate::kernel::identity::{AcpSessionId, ConnectionId};
use crate::store::Store;

use super::super::domain::{
    AcpSessionEvent, AcpSessionEventPayload, AcpSessionFocus, AcpSessionSummary,
};

const MAX_EVENT_BYTES: usize = 512 * 1024;
const PERSIST_BATCH_DELAY: Duration = Duration::from_millis(40);
const MAX_PERSIST_BATCH_EVENTS: usize = 64;
const MAX_PERSIST_BATCH_BYTES: usize = 256 * 1024;

type PersistenceFuture<'a, T> = Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'a>>;

pub(super) trait AcpSessionPersistencePort: Send + Sync {
    fn active_resource_scope(&self) -> PersistenceFuture<'_, ActiveResourceScope>;
    fn list_sessions(&self) -> PersistenceFuture<'_, Vec<AcpSessionSummary>>;
    fn focus_session(
        &self,
        id: AcpSessionId,
        after_sequence: Option<u64>,
    ) -> PersistenceFuture<'_, AcpSessionFocus>;
    fn pin_connection(&self, id: ConnectionId) -> PersistenceFuture<'_, PinnedConnection>;
    fn persist_session<'a>(
        &'a self,
        scope: &'a ActiveResourceScope,
        summary: &'a AcpSessionSummary,
    ) -> PersistenceFuture<'a, ()>;
    fn persist_events<'a>(
        &'a self,
        scope: &'a ActiveResourceScope,
        summary: &'a AcpSessionSummary,
        events: &'a [AcpSessionEvent],
    ) -> PersistenceFuture<'a, ()>;
    fn discard_events_through<'a>(
        &'a self,
        scope: &'a ActiveResourceScope,
        id: AcpSessionId,
        sequence: u64,
    ) -> PersistenceFuture<'a, ()>;
}

pub(super) struct StoreAcpSessionPersistence {
    store: Store,
}

impl StoreAcpSessionPersistence {
    pub(super) fn new(store: Store) -> Self {
        Self { store }
    }
}

impl AcpSessionPersistencePort for StoreAcpSessionPersistence {
    fn active_resource_scope(&self) -> PersistenceFuture<'_, ActiveResourceScope> {
        Box::pin(self.store.active_resource_scope())
    }

    fn list_sessions(&self) -> PersistenceFuture<'_, Vec<AcpSessionSummary>> {
        Box::pin(self.store.list_agent_acp_sessions())
    }

    fn focus_session(
        &self,
        id: AcpSessionId,
        after_sequence: Option<u64>,
    ) -> PersistenceFuture<'_, AcpSessionFocus> {
        Box::pin(self.store.focus_agent_acp_session(id, after_sequence))
    }

    fn pin_connection(&self, id: ConnectionId) -> PersistenceFuture<'_, PinnedConnection> {
        Box::pin(self.store.pin_connection_for_read(id.into()))
    }

    fn persist_session<'a>(
        &'a self,
        scope: &'a ActiveResourceScope,
        summary: &'a AcpSessionSummary,
    ) -> PersistenceFuture<'a, ()> {
        Box::pin(self.store.persist_agent_acp_session(scope, summary))
    }

    fn persist_events<'a>(
        &'a self,
        scope: &'a ActiveResourceScope,
        summary: &'a AcpSessionSummary,
        events: &'a [AcpSessionEvent],
    ) -> PersistenceFuture<'a, ()> {
        Box::pin(self.store.persist_agent_acp_events(scope, summary, events))
    }

    fn discard_events_through<'a>(
        &'a self,
        scope: &'a ActiveResourceScope,
        id: AcpSessionId,
        sequence: u64,
    ) -> PersistenceFuture<'a, ()> {
        Box::pin(
            self.store
                .discard_agent_acp_events_through(scope, id, sequence),
        )
    }
}

pub(super) struct PersistenceRequest {
    pub(super) summary: AcpSessionSummary,
    pub(super) event: AcpSessionEvent,
    pub(super) bytes: usize,
    pub(super) immediate: bool,
}

pub(super) enum PersistenceCommand {
    Event(Box<PersistenceRequest>),
    Shutdown,
}

#[derive(Default)]
pub(super) struct PersistenceTracker {
    pending: AtomicUsize,
    idle: Notify,
}

impl PersistenceTracker {
    pub(super) fn begin(&self) {
        self.pending.fetch_add(1, Ordering::SeqCst);
    }

    pub(super) fn finish(&self) {
        self.finish_many(1);
    }

    fn finish_many(&self, count: usize) {
        debug_assert!(count > 0);
        if self.pending.fetch_sub(count, Ordering::SeqCst) == count {
            self.idle.notify_waiters();
        }
    }

    pub(super) async fn wait_for_idle(&self) {
        loop {
            let notified = self.idle.notified();
            if self.pending.load(Ordering::SeqCst) == 0 {
                return;
            }
            notified.await;
        }
    }
}

pub(super) async fn run_worker(
    session_id: AcpSessionId,
    persistence: Arc<dyn AcpSessionPersistencePort>,
    scope: ActiveResourceScope,
    tracker: Arc<PersistenceTracker>,
    mut requests: tokio::sync::mpsc::UnboundedReceiver<PersistenceCommand>,
) {
    let mut closed = false;
    while !closed {
        let first = match requests.recv().await {
            Some(PersistenceCommand::Event(request)) => request,
            Some(PersistenceCommand::Shutdown) | None => break,
        };
        let mut events = Vec::with_capacity(MAX_PERSIST_BATCH_EVENTS);
        let mut bytes = first.bytes;
        let mut summary = first.summary;
        let mut immediate = first.immediate;
        events.push(first.event);
        let deadline = tokio::time::Instant::now() + PERSIST_BATCH_DELAY;

        while !immediate
            && events.len() < MAX_PERSIST_BATCH_EVENTS
            && bytes < MAX_PERSIST_BATCH_BYTES
        {
            match tokio::time::timeout_at(deadline, requests.recv()).await {
                Ok(Some(PersistenceCommand::Event(request))) => {
                    bytes = bytes.saturating_add(request.bytes);
                    summary = request.summary;
                    immediate = request.immediate;
                    events.push(request.event);
                }
                Ok(Some(PersistenceCommand::Shutdown)) | Ok(None) => {
                    closed = true;
                    break;
                }
                Err(_) => break,
            }
        }

        let first_sequence = events
            .first()
            .map(|event| event.sequence)
            .unwrap_or_default();
        let last_sequence = events
            .last()
            .map(|event| event.sequence)
            .unwrap_or_default();
        let event_count = events.len();
        if let Err(error) = persistence.persist_events(&scope, &summary, &events).await {
            tracing::warn!(
                %session_id,
                first_sequence,
                last_sequence,
                event_count,
                %error,
                "could not persist ACP session event batch"
            );
        } else {
            tracing::trace!(
                %session_id,
                first_sequence,
                last_sequence,
                event_count,
                immediate,
                "persisted ACP session event batch"
            );
        }
        tracker.finish_many(event_count);
    }
}

pub(super) fn is_boundary(payload: &AcpSessionEventPayload) -> bool {
    !matches!(
        payload,
        AcpSessionEventPayload::SessionUpdate { update }
            if matches!(
                update.get("sessionUpdate").and_then(serde_json::Value::as_str),
                Some("agent_message_chunk" | "agent_thought_chunk")
            )
    )
}

pub(super) fn event_bytes(event: &AcpSessionEvent) -> usize {
    serde_json::to_vec(event)
        .map(|encoded| encoded.len())
        .unwrap_or(MAX_EVENT_BYTES)
}
