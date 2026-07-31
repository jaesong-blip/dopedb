//! Capabilities required by Terminal Dock use cases.

use std::future::Future;
use std::time::Duration;

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, TerminalSessionId};

use super::domain::{
    TerminalCreateRequest, TerminalFocusReceipt, TerminalSessionSummary, TerminalSize,
};

pub(crate) trait TerminalSessionPort: Clone + Send + Sync + 'static {
    type OutputSink: Send + 'static;
    type EventSink: Clone + Send + Sync + 'static;

    fn create(
        &self,
        request: TerminalCreateRequest,
        output: Self::OutputSink,
        events: Self::EventSink,
    ) -> impl Future<Output = AppResult<TerminalSessionSummary>> + Send;

    fn list(&self) -> AppResult<Vec<TerminalSessionSummary>>;

    fn focus(
        &self,
        id: TerminalSessionId,
        after_sequence: Option<u64>,
        output: Self::OutputSink,
    ) -> impl Future<Output = AppResult<TerminalFocusReceipt>> + Send;

    fn write(
        &self,
        id: TerminalSessionId,
        bytes: Vec<u8>,
    ) -> impl Future<Output = AppResult<()>> + Send;

    fn resize(
        &self,
        id: TerminalSessionId,
        size: TerminalSize,
    ) -> impl Future<Output = AppResult<()>> + Send;

    fn kill(
        &self,
        id: TerminalSessionId,
        events: Self::EventSink,
    ) -> impl Future<Output = AppResult<TerminalSessionSummary>> + Send;

    fn close(
        &self,
        id: TerminalSessionId,
        events: Self::EventSink,
    ) -> impl Future<Output = AppResult<()>> + Send;

    fn restart(
        &self,
        id: TerminalSessionId,
        output: Self::OutputSink,
        events: Self::EventSink,
    ) -> impl Future<Output = AppResult<TerminalSessionSummary>> + Send;

    fn rename(
        &self,
        id: TerminalSessionId,
        name: String,
        events: Self::EventSink,
    ) -> impl Future<Output = AppResult<TerminalSessionSummary>> + Send;

    fn stop_connection(&self, connection_id: ConnectionId, events: &Self::EventSink) -> usize;

    fn stop_all(&self, events: &Self::EventSink);

    fn shutdown_all(&self, events: &Self::EventSink, timeout: Duration);
}
