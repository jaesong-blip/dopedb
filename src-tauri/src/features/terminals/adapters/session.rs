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
use crate::kernel::identity::{ConnectionId, TerminalSessionId};
use crate::store::PinnedConnection;

use super::super::domain::{
    TerminalConnectionPin, TerminalExit, TerminalExitEvent, TerminalLifecycle, TerminalOutputChunk,
    TerminalProfile, TerminalSessionSummary, TerminalSize, TerminalStateEvent,
};
use super::output::OutputSanitizer;
use super::process_tree::ProcessTree;
use super::replay::{OutputReplay, ReplayReceipt};

const MAX_INPUT_BYTES: usize = 64 * 1024;
const OUTPUT_READ_BYTES: usize = 16 * 1024;
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

pub(super) struct RestartSeed {
    pub(super) connection: PinnedConnection,
    pub(super) connection_pin: TerminalConnectionPin,
    pub(super) profile: TerminalProfile,
    pub(super) size: TerminalSize,
    pub(super) name: String,
}

pub(super) struct TerminalSession {
    id: TerminalSessionId,
    launch: SessionLaunch,
    metadata: Mutex<SessionMetadata>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    process_tree: Mutex<Option<Arc<ProcessTree>>>,
    output: Mutex<OutputReplay>,
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
            output: Mutex::new(OutputReplay::new(resources.output)),
        }
    }

    pub(super) fn summary(&self) -> TerminalSessionSummary {
        let metadata = self.metadata.lock().unwrap();
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
        self.metadata.lock().unwrap().lifecycle
    }

    pub(super) fn connection_id(&self) -> ConnectionId {
        ConnectionId::from(self.launch.connection.connection_id)
    }

    pub(super) fn restart_seed(&self) -> RestartSeed {
        let metadata = self.metadata.lock().unwrap();
        RestartSeed {
            connection: self.launch.connection.clone(),
            connection_pin: self.launch.connection_pin.clone(),
            profile: self.launch.profile,
            size: metadata.size,
            name: metadata.name.clone(),
        }
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
        let mut writer = self.writer.lock().unwrap();
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
        let master = self.master.lock().unwrap();
        let master = master.as_ref().ok_or_else(|| AppError::Blocked {
            reason: "the Terminal PTY is closed".into(),
        })?;
        master
            .resize(to_pty_size(size))
            .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
        self.metadata.lock().unwrap().size = size;
        Ok(())
    }

    pub(super) fn rename(&self, name: String) -> TerminalSessionSummary {
        self.metadata.lock().unwrap().name = name;
        self.summary()
    }

    pub(super) fn mark_stopping(&self) {
        let mut metadata = self.metadata.lock().unwrap();
        metadata.lifecycle = TerminalLifecycle::Stopping;
        metadata.last_activity_at = Utc::now();
    }

    pub(super) fn attach(
        &self,
        after_sequence: Option<u64>,
        subscriber: Channel<TerminalOutputChunk>,
    ) -> AppResult<ReplayReceipt> {
        self.output
            .lock()
            .unwrap()
            .attach(self.id, after_sequence, subscriber)
    }

    pub(super) fn request_stop(&self) {
        if let Some(tree) = self.process_tree.lock().unwrap().as_ref() {
            if let Err(error) = tree.terminate() {
                tracing::warn!(session_id = %self.id, "failed to terminate Terminal process tree: {error}");
            }
        }
        if let Some(killer) = self.killer.lock().unwrap().as_mut() {
            let _ = killer.kill();
        }
    }

    pub(super) fn force_stop(&self) {
        if let Some(tree) = self.process_tree.lock().unwrap().as_ref() {
            if let Err(error) = tree.force_terminate() {
                tracing::warn!(session_id = %self.id, "failed to force-terminate Terminal process tree: {error}");
            }
        }
        if let Some(killer) = self.killer.lock().unwrap().as_mut() {
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
        self.metadata.lock().unwrap().last_activity_at = Utc::now();
    }

    fn publish(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        self.touch();
        self.output.lock().unwrap().publish(self.id, bytes);
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
    if let Some(tree) = session.process_tree.lock().unwrap().take() {
        // The leader can exit before its descendants. Closing a Windows Job or
        // force-signaling the Unix process group ensures no helper survives after
        // the session is already terminal and no longer has a graceful-stop window.
        let _ = tree.force_terminate();
    }
    session.killer.lock().unwrap().take();
    session.writer.lock().unwrap().take();
    session.master.lock().unwrap().take();
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
        let mut metadata = session.metadata.lock().unwrap();
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
    if let Err(error) = app.emit(
        "terminal:exit",
        TerminalExitEvent {
            session_id: session.id,
            exit,
        },
    ) {
        tracing::warn!(session_id = %session.id, "failed to emit terminal:exit: {error}");
    }
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
