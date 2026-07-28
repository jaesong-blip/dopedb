//! One connectionless Skill setup PTY session and its bounded lifecycle.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use portable_pty::{ChildKiller, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::kernel::identity::TerminalSessionId;
use crate::kernel::sync::lock_unpoisoned;

use super::super::domain::{
    SkillSetupTerminalExitEvent, SkillSetupTerminalSessionSummary, SkillSetupTerminalStateEvent,
    TerminalExit, TerminalLifecycle, TerminalOutputChunk, TerminalSize,
};
use super::output::OutputSanitizer;
use super::process_tree::ProcessTree;
use super::replay::OutputReplay;
use super::session::{MAX_INPUT_BYTES, OUTPUT_READ_BYTES};

pub(super) struct SkillSetupSessionResources {
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) writer: Box<dyn Write + Send>,
    pub(super) killer: Box<dyn ChildKiller + Send + Sync>,
    pub(super) process_tree: Arc<ProcessTree>,
    pub(super) output: Channel<TerminalOutputChunk>,
}

pub(super) struct SkillSetupTerminalSession {
    id: TerminalSessionId,
    metadata: Mutex<SessionMetadata>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    process_tree: Mutex<Option<Arc<ProcessTree>>>,
    output: Mutex<OutputReplay>,
}

struct SessionMetadata {
    lifecycle: TerminalLifecycle,
    size: TerminalSize,
    created_at: chrono::DateTime<Utc>,
    last_activity_at: chrono::DateTime<Utc>,
    exit: Option<TerminalExit>,
}

impl SkillSetupTerminalSession {
    pub(super) fn new(
        id: TerminalSessionId,
        size: TerminalSize,
        resources: SkillSetupSessionResources,
    ) -> Self {
        let now = Utc::now();
        Self {
            id,
            metadata: Mutex::new(SessionMetadata {
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

    pub(super) fn summary(&self) -> SkillSetupTerminalSessionSummary {
        let metadata = lock_unpoisoned(&self.metadata);
        SkillSetupTerminalSessionSummary {
            id: self.id,
            lifecycle: metadata.lifecycle,
            size: metadata.size,
            created_at: metadata.created_at,
            last_activity_at: metadata.last_activity_at,
            exit: metadata.exit.clone(),
        }
    }

    pub(super) fn lifecycle(&self) -> TerminalLifecycle {
        lock_unpoisoned(&self.metadata).lifecycle
    }

    pub(super) fn write(&self, bytes: Vec<u8>) -> AppResult<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(AppError::Blocked {
                reason: format!("Skill setup Terminal input exceeds {MAX_INPUT_BYTES} bytes"),
            });
        }
        if self.lifecycle().is_terminal() {
            return Err(AppError::Blocked {
                reason: "the Skill setup Terminal has already exited".into(),
            });
        }
        let mut writer = lock_unpoisoned(&self.writer);
        let writer = writer.as_mut().ok_or_else(|| AppError::Blocked {
            reason: "the Skill setup Terminal input stream is closed".into(),
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
            reason: "the Skill setup Terminal PTY is closed".into(),
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
                tracing::warn!(
                    session_id = %self.id,
                    "failed to terminate Skill setup Terminal process tree: {error}"
                );
            }
        }
        if let Some(killer) = lock_unpoisoned(&self.killer).as_mut() {
            let _ = killer.kill();
        }
    }

    pub(super) fn force_stop(&self) {
        if let Some(tree) = lock_unpoisoned(&self.process_tree).as_ref() {
            if let Err(error) = tree.force_terminate() {
                tracing::warn!(
                    session_id = %self.id,
                    "failed to force-terminate Skill setup Terminal process tree: {error}"
                );
            }
        }
        if let Some(killer) = lock_unpoisoned(&self.killer).as_mut() {
            let _ = killer.kill();
        }
    }

    pub(super) fn spawn_waiter(
        self: &Arc<Self>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        app: AppHandle,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        let session = self.clone();
        std::thread::Builder::new()
            .name(format!("skill-setup-wait-{}", short_id(self.id)))
            .spawn(move || wait_for_child(session, child, app))
    }

    pub(super) fn spawn_reader(
        self: &Arc<Self>,
        reader: Box<dyn Read + Send>,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        let session = self.clone();
        std::thread::Builder::new()
            .name(format!("skill-setup-read-{}", short_id(self.id)))
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

pub(super) fn emit_setup_state(app: &AppHandle, summary: &SkillSetupTerminalSessionSummary) {
    if let Err(error) = app.emit(
        "skill-setup-terminal:state",
        SkillSetupTerminalStateEvent {
            session: summary.clone(),
        },
    ) {
        tracing::warn!(
            session_id = %summary.id,
            "failed to emit skill-setup-terminal:state: {error}"
        );
    }
}

fn wait_for_child(
    session: Arc<SkillSetupTerminalSession>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    app: AppHandle,
) {
    let result = child.wait();
    if let Some(tree) = lock_unpoisoned(&session.process_tree).take() {
        let _ = tree.force_terminate();
    }
    lock_unpoisoned(&session.killer).take();
    lock_unpoisoned(&session.writer).take();
    lock_unpoisoned(&session.master).take();

    let wait_succeeded = result.is_ok();
    let exit = match result {
        Ok(status) => TerminalExit {
            success: status.success(),
            code: Some(status.exit_code()),
            signal: status.signal().map(ToOwned::to_owned),
            at: Utc::now(),
        },
        Err(error) => {
            tracing::warn!(
                session_id = %session.id,
                "Skill setup Terminal child wait failed: {error}"
            );
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
    emit_setup_state(&app, &summary);
    if let Err(error) = app.emit(
        "skill-setup-terminal:exit",
        SkillSetupTerminalExitEvent {
            session_id: session.id,
            exit,
        },
    ) {
        tracing::warn!(
            session_id = %session.id,
            "failed to emit skill-setup-terminal:exit: {error}"
        );
    }
}

fn read_output(session: Arc<SkillSetupTerminalSession>, mut reader: Box<dyn Read + Send>) {
    let mut sanitizer = OutputSanitizer::default();
    let mut buffer = [0_u8; OUTPUT_READ_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => session.publish(sanitizer.push(&buffer[..read])),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                tracing::warn!(
                    session_id = %session.id,
                    "Skill setup Terminal output reader failed: {error}"
                );
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
