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

use adapters::{DesktopSkillSetupTerminalAdapter, DesktopTerminalAdapter};
use application::{SkillSetupTerminalUseCases, TerminalUseCases};
pub(crate) use domain::{
    SkillSetupTerminalCreateRequest, SkillSetupTerminalDraft, SkillSetupTerminalSessionSummary,
    TerminalCreateRequest, TerminalFocusReceipt, TerminalOutputChunk, TerminalSessionSummary,
    TerminalSize,
};

type ComposedTerminalApplication = TerminalUseCases<DesktopTerminalAdapter>;
type ComposedSkillSetupTerminalApplication =
    SkillSetupTerminalUseCases<DesktopSkillSetupTerminalAdapter>;

#[derive(Clone)]
pub(crate) struct TerminalsFeature {
    application: ComposedTerminalApplication,
    skill_setup: ComposedSkillSetupTerminalApplication,
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

    pub(crate) async fn create_skill_setup(
        &self,
        request: SkillSetupTerminalCreateRequest,
        output: Channel<TerminalOutputChunk>,
        events: AppHandle,
    ) -> AppResult<SkillSetupTerminalSessionSummary> {
        self.skill_setup.create(request, output, events).await
    }

    pub(crate) async fn write_skill_setup(
        &self,
        id: TerminalSessionId,
        bytes: Vec<u8>,
    ) -> AppResult<()> {
        self.skill_setup.write(id, bytes).await
    }

    pub(crate) async fn draft_skill_setup(
        &self,
        id: TerminalSessionId,
        draft: SkillSetupTerminalDraft,
    ) -> AppResult<()> {
        self.skill_setup.draft(id, draft).await
    }

    pub(crate) async fn resize_skill_setup(
        &self,
        id: TerminalSessionId,
        size: TerminalSize,
    ) -> AppResult<()> {
        self.skill_setup.resize(id, size).await
    }

    pub(crate) async fn close_skill_setup(
        &self,
        id: TerminalSessionId,
        events: AppHandle,
    ) -> AppResult<()> {
        self.skill_setup.close(id, events).await
    }

    pub(crate) fn stop_connection(&self, connection_id: ConnectionId, events: &AppHandle) -> usize {
        self.application.stop_connection(connection_id, events)
    }

    pub(crate) fn stop_all(&self, events: &AppHandle) {
        self.application.stop_all(events);
    }

    pub(crate) fn shutdown_all(&self, events: &AppHandle, timeout: Duration) {
        self.application.shutdown_all(events, timeout);
        self.skill_setup.shutdown_all(events, timeout);
    }
}

pub(crate) fn compose(store: Store, broker: BrokerRuntime) -> TerminalsFeature {
    TerminalsFeature {
        application: TerminalUseCases::new(DesktopTerminalAdapter::new(store, broker)),
        skill_setup: SkillSetupTerminalUseCases::new(DesktopSkillSetupTerminalAdapter::new()),
    }
}
