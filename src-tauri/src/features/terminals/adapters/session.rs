//! One Terminal session's PTY resources, output stream, and lifecycle.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use portable_pty::{ChildKiller, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::broker::BrokerSessionRegistry;
use crate::error::{AppError, AppResult};
use crate::kernel::access::PinnedConnection;
use crate::kernel::identity::{ConnectionId, TerminalSessionId};
use crate::kernel::sync::lock_unpoisoned;

use super::super::domain::{
    TerminalConnectionPin, TerminalExit, TerminalLifecycle, TerminalOutputChunk, TerminalProfile,
    TerminalSessionSummary, TerminalSize, TerminalStateEvent,
};
use super::output::{OutputSanitizer, TerminalOutputStream};
use super::process_tree::ProcessTree;

pub(super) const MAX_INPUT_BYTES: usize = 64 * 1024;
pub(super) const OUTPUT_READ_BYTES: usize = 16 * 1024;
pub(super) const FORCE_KILL_AFTER: Duration = Duration::from_millis(500);

pub(super) struct SessionLaunch {
    pub(super) profile: TerminalProfile,
    pub(super) connection: PinnedConnection,
    pub(super) connection_pin: TerminalConnectionPin,
}

pub(super) struct SessionResources {
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) writer: Box<dyn Write + Send>,
    pub(super) killer: Box<dyn ChildKiller + Send + Sync>,
    pub(super) process_tree: Arc<ProcessTree>,
    pub(super) output: Channel<TerminalOutputChunk>,
}

pub(super) struct TerminalSession {
    id: TerminalSessionId,
    launch: SessionLaunch,
    metadata: Mutex<SessionMetadata>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    process_tree: Mutex<Option<Arc<ProcessTree>>>,
    output: Mutex<TerminalOutputStream>,
}

struct SessionMetadata {
    name: String,
    lifecycle: TerminalLifecycle,
    size: TerminalSize,
    created_at: chrono::DateTime<Utc>,
    last_activity_at: chrono::DateTime<Utc>,
    exit: Option<TerminalExit>,
}

impl TerminalSession {
    pub(super) fn new(
        id: TerminalSessionId,
        launch: SessionLaunch,
        name: String,
        size: TerminalSize,
        resources: SessionResources,
    ) -> Self {
        let now = Utc::now();
        Self {
            id,
            launch,
            metadata: Mutex::new(SessionMetadata {
                name,
                lifecycle: TerminalLifecycle::Running,
                size,
                created_at: now,
                last_activity_at: now,
                exit: None,
            }),
            master: Mutex::new(Some(resources.master)),
            writer: Mutex::new(Some(resources.writer)),
            killer: Mutex::new(Some(resources.killer)),
            process_tree: Mutex::new(Some(resources.process_tree)),
            output: Mutex::new(TerminalOutputStream::new(resources.output)),
        }
    }

    pub(super) fn summary(&self) -> TerminalSessionSummary {
        let metadata = lock_unpoisoned(&self.metadata);
        TerminalSessionSummary {
            id: self.id,
            name: metadata.name.clone(),
            profile: self.launch.profile,
            lifecycle: metadata.lifecycle,
            size: metadata.size,
            connection: self.launch.connection_pin.clone(),
            created_at: metadata.created_at,
            last_activity_at: metadata.last_activity_at,
            exit: metadata.exit.clone(),
        }
    }

    pub(super) fn lifecycle(&self) -> TerminalLifecycle {
        lock_unpoisoned(&self.metadata).lifecycle
    }

    pub(super) fn connection_id(&self) -> ConnectionId {
        ConnectionId::from(self.launch.connection.connection_id)
    }

    pub(super) fn write(&self, bytes: Vec<u8>) -> AppResult<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(AppError::Blocked {
                reason: format!("Terminal input exceeds {MAX_INPUT_BYTES} bytes"),
            });
        }
        if self.lifecycle().is_terminal() {
            return Err(AppError::Blocked {
                reason: "the Terminal session has already exited".into(),
            });
        }
        let mut writer = lock_unpoisoned(&self.writer);
        let writer = writer.as_mut().ok_or_else(|| AppError::Blocked {
            reason: "the Terminal input stream is closed".into(),
        })?;
        writer.write_all(&bytes)?;
        writer.flush()?;
        self.touch();
        Ok(())
    }

    pub(super) fn resize(&self, size: TerminalSize) -> AppResult<()> {
        let size = size
            .validate()
            .map_err(|reason| AppError::Config(reason.into()))?;
        let master = lock_unpoisoned(&self.master);
        let master = master.as_ref().ok_or_else(|| AppError::Blocked {
            reason: "the Terminal PTY is closed".into(),
        })?;
        master
            .resize(to_pty_size(size))
            .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
        lock_unpoisoned(&self.metadata).size = size;
        Ok(())
    }

    pub(super) fn mark_stopping(&self) {
        let mut metadata = lock_unpoisoned(&self.metadata);
        metadata.lifecycle = TerminalLifecycle::Stopping;
        metadata.last_activity_at = Utc::now();
    }

    pub(super) fn request_stop(&self) {
        if let Some(tree) = lock_unpoisoned(&self.process_tree).as_ref() {
            if let Err(error) = tree.terminate() {
                tracing::warn!(session_id = %self.id, "failed to terminate Terminal process tree: {error}");
            }
        }
        if let Some(killer) = lock_unpoisoned(&self.killer).as_mut() {
            let _ = killer.kill();
        }
    }

    pub(super) fn force_stop(&self) {
        if let Some(tree) = lock_unpoisoned(&self.process_tree).as_ref() {
            if let Err(error) = tree.force_terminate() {
                tracing::warn!(session_id = %self.id, "failed to force-terminate Terminal process tree: {error}");
            }
        }
        if let Some(killer) = lock_unpoisoned(&self.killer).as_mut() {
            let _ = killer.kill();
        }
    }

    pub(super) fn spawn_waiter(
        self: &Arc<Self>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        broker_sessions: BrokerSessionRegistry,
        app: AppHandle,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        let session = self.clone();
        std::thread::Builder::new()
            .name(format!("terminal-wait-{}", short_id(self.id)))
            .spawn(move || wait_for_child(session, child, broker_sessions, app))
    }

    pub(super) fn spawn_reader(
        self: &Arc<Self>,
        reader: Box<dyn Read + Send>,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        let session = self.clone();
        std::thread::Builder::new()
            .name(format!("terminal-read-{}", short_id(self.id)))
            .spawn(move || read_output(session, reader))
    }

    fn touch(&self) {
        lock_unpoisoned(&self.metadata).last_activity_at = Utc::now();
    }

    fn publish(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        self.touch();
        lock_unpoisoned(&self.output).publish(self.id, bytes);
    }
}

pub(super) fn emit_state(app: &AppHandle, summary: &TerminalSessionSummary) {
    if let Err(error) = app.emit(
        "terminal:state",
        TerminalStateEvent {
            session: summary.clone(),
        },
    ) {
        tracing::warn!(session_id = %summary.id, "failed to emit terminal:state: {error}");
    }
}

fn wait_for_child(
    session: Arc<TerminalSession>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    broker_sessions: BrokerSessionRegistry,
    app: AppHandle,
) {
    let result = child.wait();
    if let Some(tree) = lock_unpoisoned(&session.process_tree).take() {
        // The leader can exit before its descendants. Closing a Windows Job or
        // force-signaling the Unix process group ensures no helper survives after
        // the session is already terminal and no longer has a graceful-stop window.
        let _ = tree.force_terminate();
    }
    lock_unpoisoned(&session.killer).take();
    lock_unpoisoned(&session.writer).take();
    lock_unpoisoned(&session.master).take();
    broker_sessions.revoke(session.id);

    let wait_succeeded = result.is_ok();
    let exit = match result {
        Ok(status) => TerminalExit {
            success: status.success(),
            code: Some(status.exit_code()),
            signal: status.signal().map(ToOwned::to_owned),
            at: Utc::now(),
        },
        Err(error) => {
            tracing::warn!(session_id = %session.id, "Terminal child wait failed: {error}");
            TerminalExit {
                success: false,
                code: None,
                signal: Some("wait_failed".into()),
                at: Utc::now(),
            }
        }
    };
    {
        let mut metadata = lock_unpoisoned(&session.metadata);
        metadata.lifecycle = if wait_succeeded {
            TerminalLifecycle::Exited
        } else {
            TerminalLifecycle::Failed
        };
        metadata.last_activity_at = exit.at;
        metadata.exit = Some(exit.clone());
    }
    let summary = session.summary();
    emit_state(&app, &summary);
}

fn read_output(session: Arc<TerminalSession>, mut reader: Box<dyn Read + Send>) {
    let mut sanitizer = OutputSanitizer::default();
    let mut buffer = [0_u8; OUTPUT_READ_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => session.publish(sanitizer.push(&buffer[..read])),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                tracing::warn!(session_id = %session.id, "Terminal output reader failed: {error}");
                break;
            }
        }
    }
}

fn to_pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: size.pixel_width,
        pixel_height: size.pixel_height,
    }
}

fn short_id(id: TerminalSessionId) -> String {
    uuid::Uuid::from(id).simple().to_string()[..8].to_string()
}
