//! Explicit connection-pinned advanced Shell use-case entry points.

use std::time::Duration;

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, TerminalSessionId};

use super::domain::{TerminalCreateRequest, TerminalSessionSummary, TerminalSize};
use super::ports::TerminalSessionPort;

#[derive(Clone)]
pub(crate) struct TerminalUseCases<P> {
    sessions: P,
}

impl<P> TerminalUseCases<P>
where
    P: TerminalSessionPort,
{
    pub(crate) fn new(sessions: P) -> Self {
        Self { sessions }
    }

    pub(crate) async fn create(
        &self,
        request: TerminalCreateRequest,
        output: P::OutputSink,
        events: P::EventSink,
    ) -> AppResult<TerminalSessionSummary> {
        self.sessions.create(request, output, events).await
    }

    pub(crate) async fn write(&self, id: TerminalSessionId, bytes: Vec<u8>) -> AppResult<()> {
        self.sessions.write(id, bytes).await
    }

    pub(crate) async fn resize(&self, id: TerminalSessionId, size: TerminalSize) -> AppResult<()> {
        self.sessions.resize(id, size).await
    }

    pub(crate) async fn close(&self, id: TerminalSessionId, events: P::EventSink) -> AppResult<()> {
        self.sessions.close(id, events).await
    }

    pub(crate) fn stop_connection(
        &self,
        connection_id: ConnectionId,
        events: &P::EventSink,
    ) -> usize {
        self.sessions.stop_connection(connection_id, events)
    }

    pub(crate) fn stop_all(&self, events: &P::EventSink) {
        self.sessions.stop_all(events);
    }

    pub(crate) fn shutdown_all(&self, events: &P::EventSink, timeout: Duration) {
        self.sessions.shutdown_all(events, timeout);
    }
}
