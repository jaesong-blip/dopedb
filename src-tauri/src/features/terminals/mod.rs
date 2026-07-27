//! Connection-pinned, PTY-backed Terminal Dock vertical slice.

mod adapters;
mod application;
mod domain;
mod ports;
pub(crate) mod transport;

use std::time::Duration;

use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::broker::BrokerRuntime;
use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, TerminalSessionId};
use crate::store::Store;

use adapters::DesktopTerminalAdapter;
use application::TerminalUseCases;
pub(crate) use domain::{
    TerminalCreateRequest, TerminalFocusReceipt, TerminalOutputChunk, TerminalSessionSummary,
    TerminalSize,
};

type ComposedTerminalApplication = TerminalUseCases<DesktopTerminalAdapter>;

#[derive(Clone)]
pub(crate) struct TerminalsFeature {
    application: ComposedTerminalApplication,
}

impl TerminalsFeature {
    pub(crate) async fn create(
        &self,
        request: TerminalCreateRequest,
        output: Channel<TerminalOutputChunk>,
        events: AppHandle,
    ) -> AppResult<TerminalSessionSummary> {
        self.application.create(request, output, events).await
    }

    pub(crate) fn list(&self) -> AppResult<Vec<TerminalSessionSummary>> {
        self.application.list()
    }

    pub(crate) async fn focus(
        &self,
        id: TerminalSessionId,
        after_sequence: Option<u64>,
        output: Channel<TerminalOutputChunk>,
    ) -> AppResult<TerminalFocusReceipt> {
        self.application.focus(id, after_sequence, output).await
    }

    pub(crate) async fn write(&self, id: TerminalSessionId, bytes: Vec<u8>) -> AppResult<()> {
        self.application.write(id, bytes).await
    }

    pub(crate) async fn resize(&self, id: TerminalSessionId, size: TerminalSize) -> AppResult<()> {
        self.application.resize(id, size).await
    }

    pub(crate) async fn kill(
        &self,
        id: TerminalSessionId,
        events: AppHandle,
    ) -> AppResult<TerminalSessionSummary> {
        self.application.kill(id, events).await
    }

    pub(crate) async fn close(&self, id: TerminalSessionId, events: AppHandle) -> AppResult<()> {
        self.application.close(id, events).await
    }

    pub(crate) async fn restart(
        &self,
        id: TerminalSessionId,
        output: Channel<TerminalOutputChunk>,
        events: AppHandle,
    ) -> AppResult<TerminalSessionSummary> {
        self.application.restart(id, output, events).await
    }

    pub(crate) async fn rename(
        &self,
        id: TerminalSessionId,
        name: String,
        events: AppHandle,
    ) -> AppResult<TerminalSessionSummary> {
        self.application.rename(id, name, events).await
    }

    pub(crate) fn stop_connection(&self, connection_id: ConnectionId, events: &AppHandle) -> usize {
        self.application.stop_connection(connection_id, events)
    }

    pub(crate) fn stop_all(&self, events: &AppHandle) {
        self.application.stop_all(events);
    }

    pub(crate) fn shutdown_all(&self, events: &AppHandle, timeout: Duration) {
        self.application.shutdown_all(events, timeout);
    }
}

pub(crate) fn compose(store: Store, broker: BrokerRuntime) -> TerminalsFeature {
    TerminalsFeature {
        application: TerminalUseCases::new(DesktopTerminalAdapter::new(store, broker)),
    }
}
