//! Desktop composition adapter for capability-free Skill setup Terminal sessions.

use std::time::Duration;

use tauri::ipc::Channel;
use tauri::AppHandle;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::TerminalSessionId;

use super::super::domain::{
    SkillSetupTerminalCreateRequest, SkillSetupTerminalSessionSummary, TerminalOutputChunk,
    TerminalSize,
};
use super::super::ports::SkillSetupTerminalSessionPort;
use super::setup_runtime::{SkillSetupCreateContext, SkillSetupTerminalRuntime};

#[derive(Clone, Default)]
pub(in crate::features::terminals) struct DesktopSkillSetupTerminalAdapter {
    runtime: SkillSetupTerminalRuntime,
}

impl DesktopSkillSetupTerminalAdapter {
    pub(in crate::features::terminals) fn new() -> Self {
        Self::default()
    }

    async fn cli_directory() -> AppResult<std::path::PathBuf> {
        tokio::task::spawn_blocking(crate::cli_install::in_app_cli_directory)
            .await
            .map_err(|_| AppError::Config("the in-app CLI resolver stopped unexpectedly".into()))?
    }
}

impl SkillSetupTerminalSessionPort for DesktopSkillSetupTerminalAdapter {
    type OutputSink = Channel<TerminalOutputChunk>;
    type EventSink = AppHandle;

    async fn create(
        &self,
        request: SkillSetupTerminalCreateRequest,
        output: Self::OutputSink,
        events: Self::EventSink,
    ) -> AppResult<SkillSetupTerminalSessionSummary> {
        let cli_directory = Self::cli_directory().await?;
        let session_id = TerminalSessionId::from(Uuid::new_v4());
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || {
            runtime.create(
                request,
                SkillSetupCreateContext {
                    id: session_id,
                    cli_directory: &cli_directory,
                    output,
                    app: &events,
                },
            )
        })
        .await
        .map_err(|_| {
            AppError::Config("the Skill setup Terminal creation worker stopped unexpectedly".into())
        })?
    }

    async fn write(&self, id: TerminalSessionId, bytes: Vec<u8>) -> AppResult<()> {
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || runtime.write(id, bytes))
            .await
            .map_err(|_| {
                AppError::Config(
                    "the Skill setup Terminal input worker stopped unexpectedly".into(),
                )
            })?
    }

    async fn resize(&self, id: TerminalSessionId, size: TerminalSize) -> AppResult<()> {
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || runtime.resize(id, size))
            .await
            .map_err(|_| {
                AppError::Config(
                    "the Skill setup Terminal resize worker stopped unexpectedly".into(),
                )
            })?
    }

    async fn close(&self, id: TerminalSessionId, events: Self::EventSink) -> AppResult<()> {
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || runtime.close(id, &events))
            .await
            .map_err(|_| {
                AppError::Config(
                    "the Skill setup Terminal close worker stopped unexpectedly".into(),
                )
            })?
    }

    fn shutdown_all(&self, events: &Self::EventSink, timeout: Duration) {
        self.runtime.shutdown_all(events, timeout);
    }
}
