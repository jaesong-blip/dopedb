//! Desktop composition adapter for Terminal sessions.

use std::time::Duration;

use tauri::ipc::Channel;
use tauri::AppHandle;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::broker::{BrokerCapability, BrokerRuntime};
use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, TerminalSessionId};
use crate::store::Store;

use super::super::domain::{
    TerminalCreateRequest, TerminalFocusReceipt, TerminalOutputChunk, TerminalSessionSummary,
    TerminalSize,
};
use super::super::ports::TerminalSessionPort;
use super::authority::connection_pin_matches;
use super::runtime::{CreateContext, PtyTerminalRuntime};

// Capabilities are memory-only and revoked as soon as the PTY leader exits. The
// seven-day ceiling is a leak backstop, not a user-visible reauthentication timer.
const TERMINAL_CAPABILITY_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone)]
pub(in crate::features::terminals) struct DesktopTerminalAdapter {
    store: Store,
    broker: BrokerRuntime,
    runtime: PtyTerminalRuntime,
    enabled: bool,
}

impl DesktopTerminalAdapter {
    pub(in crate::features::terminals) fn new(
        store: Store,
        broker: BrokerRuntime,
        enabled: bool,
    ) -> Self {
        Self {
            store,
            runtime: PtyTerminalRuntime::new(broker.sessions().clone()),
            broker,
            enabled,
        }
    }

    fn require_enabled(&self) -> AppResult<()> {
        if self.enabled {
            Ok(())
        } else {
            Err(AppError::Blocked {
                reason: "the Terminal Dock feature is disabled for this app runtime".into(),
            })
        }
    }

    async fn cli_directory() -> AppResult<std::path::PathBuf> {
        tokio::task::spawn_blocking(crate::cli_install::in_app_cli_directory)
            .await
            .map_err(|_| AppError::Config("the in-app CLI resolver stopped unexpectedly".into()))?
    }
}

impl TerminalSessionPort for DesktopTerminalAdapter {
    type OutputSink = Channel<TerminalOutputChunk>;
    type EventSink = AppHandle;

    async fn create(
        &self,
        request: TerminalCreateRequest,
        output: Self::OutputSink,
        events: Self::EventSink,
    ) -> AppResult<TerminalSessionSummary> {
        self.require_enabled()?;
        let cli_directory = Self::cli_directory().await?;
        let connection = self
            .store
            .pin_connection_for_read(request.connection_id.into())
            .await?;
        let session_id = TerminalSessionId::from(Uuid::new_v4());
        let issued = self.broker.sessions().issue(
            session_id,
            &connection,
            BrokerCapability::ALL,
            TERMINAL_CAPABILITY_TTL,
        )?;
        let token = Zeroizing::new(issued.token().to_owned());
        let runtime_file = self.broker.runtime_file();
        let runtime = self.runtime.clone();
        let broker_sessions = self.broker.sessions().clone();
        let result = tokio::task::spawn_blocking(move || {
            runtime.create(
                request,
                CreateContext {
                    id: session_id,
                    replacement_id: None,
                    connection,
                    session_token: token.as_str(),
                    runtime_file: runtime_file.as_deref(),
                    cli_directory: &cli_directory,
                    output,
                    app: &events,
                },
            )
        })
        .await
        .map_err(|_| {
            AppError::Config("the Terminal creation worker stopped unexpectedly".into())
        })?;
        if result.is_err() {
            broker_sessions.revoke(session_id);
        }
        result
    }

    fn list(&self) -> AppResult<Vec<TerminalSessionSummary>> {
        self.require_enabled()?;
        Ok(self.runtime.list())
    }

    async fn focus(
        &self,
        id: TerminalSessionId,
        after_sequence: Option<u64>,
        output: Self::OutputSink,
    ) -> AppResult<TerminalFocusReceipt> {
        self.require_enabled()?;
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || runtime.focus(id, after_sequence, output))
            .await
            .map_err(|_| {
                AppError::Config("the Terminal replay worker stopped unexpectedly".into())
            })?
    }

    async fn write(&self, id: TerminalSessionId, bytes: Vec<u8>) -> AppResult<()> {
        self.require_enabled()?;
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || runtime.write(id, bytes))
            .await
            .map_err(|_| {
                AppError::Config("the Terminal input worker stopped unexpectedly".into())
            })?
    }

    async fn resize(&self, id: TerminalSessionId, size: TerminalSize) -> AppResult<()> {
        self.require_enabled()?;
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || runtime.resize(id, size))
            .await
            .map_err(|_| {
                AppError::Config("the Terminal resize worker stopped unexpectedly".into())
            })?
    }

    async fn kill(
        &self,
        id: TerminalSessionId,
        events: Self::EventSink,
    ) -> AppResult<TerminalSessionSummary> {
        self.require_enabled()?;
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || runtime.kill(id, &events))
            .await
            .map_err(|_| AppError::Config("the Terminal stop worker stopped unexpectedly".into()))?
    }

    async fn close(&self, id: TerminalSessionId, events: Self::EventSink) -> AppResult<()> {
        self.require_enabled()?;
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || runtime.close(id, &events))
            .await
            .map_err(|_| {
                AppError::Config("the Terminal close worker stopped unexpectedly".into())
            })?
    }

    async fn restart(
        &self,
        id: TerminalSessionId,
        output: Self::OutputSink,
        events: Self::EventSink,
    ) -> AppResult<TerminalSessionSummary> {
        self.require_enabled()?;
        let seed = self.runtime.restart_seed(id)?;
        let current = self
            .store
            .pin_connection_for_read(seed.connection.connection_id)
            .await?;
        if !connection_pin_matches(&seed.connection_pin, &current) {
            return Err(AppError::Blocked {
                reason:
                    "the pinned connection changed; create a new Terminal session instead of retargeting"
                        .into(),
            });
        }
        let cli_directory = Self::cli_directory().await?;
        let _ = self.runtime.kill(id, &events)?;

        let next_id = TerminalSessionId::from(Uuid::new_v4());
        let issued = self.broker.sessions().issue(
            next_id,
            &current,
            BrokerCapability::ALL,
            TERMINAL_CAPABILITY_TTL,
        )?;
        let token = Zeroizing::new(issued.token().to_owned());
        let runtime_file = self.broker.runtime_file();
        let broker_sessions = self.broker.sessions().clone();
        let create_runtime = self.runtime.clone();
        let request = TerminalCreateRequest {
            connection_id: ConnectionId::from(current.connection_id),
            profile: seed.profile,
            size: seed.size,
            name: Some(seed.name),
        };
        let result = tokio::task::spawn_blocking(move || {
            create_runtime.create(
                request,
                CreateContext {
                    id: next_id,
                    replacement_id: Some(id),
                    connection: current,
                    session_token: token.as_str(),
                    runtime_file: runtime_file.as_deref(),
                    cli_directory: &cli_directory,
                    output,
                    app: &events,
                },
            )
        })
        .await
        .map_err(|_| AppError::Config("the Terminal restart worker stopped unexpectedly".into()))?;
        if result.is_err() {
            broker_sessions.revoke(next_id);
        } else {
            self.runtime.forget(id);
        }
        result
    }

    async fn rename(
        &self,
        id: TerminalSessionId,
        name: String,
        events: Self::EventSink,
    ) -> AppResult<TerminalSessionSummary> {
        self.require_enabled()?;
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || runtime.rename(id, &name, &events))
            .await
            .map_err(|_| {
                AppError::Config("the Terminal rename worker stopped unexpectedly".into())
            })?
    }

    fn stop_connection(&self, connection_id: ConnectionId, events: &Self::EventSink) -> usize {
        self.runtime.stop_connection(connection_id, events)
    }

    fn stop_all(&self, events: &Self::EventSink) {
        self.runtime.stop_all(events);
    }

    fn shutdown_all(&self, events: &Self::EventSink, timeout: Duration) {
        self.runtime.shutdown_all(events, timeout);
    }
}
