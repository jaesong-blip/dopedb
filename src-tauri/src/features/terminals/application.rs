//! Terminal Dock use-case entry points.

use std::time::Duration;

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, TerminalSessionId};

use super::domain::{
    SkillSetupTerminalCreateRequest, SkillSetupTerminalSessionSummary, TerminalCreateRequest,
    TerminalFocusReceipt, TerminalSessionSummary, TerminalSize,
};
use super::ports::{SkillSetupTerminalSessionPort, TerminalSessionPort};

#[derive(Clone)]
pub(crate) struct TerminalUseCases<P> {
    sessions: P,
}

#[derive(Clone)]
pub(crate) struct SkillSetupTerminalUseCases<P> {
    sessions: P,
}

impl<P> SkillSetupTerminalUseCases<P>
where
    P: SkillSetupTerminalSessionPort,
{
    pub(crate) fn new(sessions: P) -> Self {
        Self { sessions }
    }

    pub(crate) async fn create(
        &self,
        request: SkillSetupTerminalCreateRequest,
        output: P::OutputSink,
        events: P::EventSink,
    ) -> AppResult<SkillSetupTerminalSessionSummary> {
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

    pub(crate) fn shutdown_all(&self, events: &P::EventSink, timeout: Duration) {
        self.sessions.shutdown_all(events, timeout);
    }
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

    pub(crate) fn list(&self) -> AppResult<Vec<TerminalSessionSummary>> {
        self.sessions.list()
    }

    pub(crate) async fn focus(
        &self,
        id: TerminalSessionId,
        after_sequence: Option<u64>,
        output: P::OutputSink,
    ) -> AppResult<TerminalFocusReceipt> {
        self.sessions.focus(id, after_sequence, output).await
    }

    pub(crate) async fn write(&self, id: TerminalSessionId, bytes: Vec<u8>) -> AppResult<()> {
        self.sessions.write(id, bytes).await
    }

    pub(crate) async fn resize(&self, id: TerminalSessionId, size: TerminalSize) -> AppResult<()> {
        self.sessions.resize(id, size).await
    }

    pub(crate) async fn kill(
        &self,
        id: TerminalSessionId,
        events: P::EventSink,
    ) -> AppResult<TerminalSessionSummary> {
        self.sessions.kill(id, events).await
    }

    pub(crate) async fn close(&self, id: TerminalSessionId, events: P::EventSink) -> AppResult<()> {
        self.sessions.close(id, events).await
    }

    pub(crate) async fn restart(
        &self,
        id: TerminalSessionId,
        output: P::OutputSink,
        events: P::EventSink,
    ) -> AppResult<TerminalSessionSummary> {
        self.sessions.restart(id, output, events).await
    }

    pub(crate) async fn rename(
        &self,
        id: TerminalSessionId,
        name: String,
        events: P::EventSink,
    ) -> AppResult<TerminalSessionSummary> {
        self.sessions.rename(id, name, events).await
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
