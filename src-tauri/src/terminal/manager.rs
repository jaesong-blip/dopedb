//! In-memory PTY session owner. Nothing here is persisted: output, process handles,
//! and broker capabilities all die with the desktop runtime.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;
use dashmap::DashMap;
use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::broker::BrokerSessionRegistry;
use crate::error::{AppError, AppResult};
use crate::store::PinnedConnection;

use super::environment::{command_for_profile, neutral_working_directory, LaunchEnvironment};
use super::model::{
    TerminalConnectionPin, TerminalCreateRequest, TerminalExit, TerminalExitEvent,
    TerminalFocusReceipt, TerminalLifecycle, TerminalOutputChunk, TerminalProfile,
    TerminalSessionSummary, TerminalSize, TerminalStateEvent,
};
use super::output::OutputSanitizer;
use super::process_tree::ProcessTree;

const MAX_SESSIONS: usize = 16;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const OUTPUT_READ_BYTES: usize = 16 * 1024;
const REPLAY_BYTES: usize = 512 * 1024;
const FORCE_KILL_AFTER: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub(crate) struct TerminalManager {
    sessions: Arc<DashMap<Uuid, Arc<TerminalSession>>>,
    broker_sessions: BrokerSessionRegistry,
}

struct TerminalSession {
    id: Uuid,
    launch: LaunchSpec,
    metadata: Mutex<SessionMetadata>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    process_tree: Mutex<Option<Arc<ProcessTree>>>,
    output: Mutex<OutputState>,
}

#[derive(Clone)]
struct LaunchSpec {
    profile: TerminalProfile,
    connection: PinnedConnection,
    connection_pin: TerminalConnectionPin,
}

struct SessionMetadata {
    name: String,
    lifecycle: TerminalLifecycle,
    size: TerminalSize,
    created_at: chrono::DateTime<Utc>,
    last_activity_at: chrono::DateTime<Utc>,
    exit: Option<TerminalExit>,
}

struct ReplayEntry {
    sequence: u64,
    bytes: Vec<u8>,
}

struct OutputState {
    next_sequence: u64,
    dropped_through: u64,
    replay_bytes: usize,
    replay: VecDeque<ReplayEntry>,
    subscriber: Option<Channel<TerminalOutputChunk>>,
}

pub(super) struct RestartSeed {
    pub connection: PinnedConnection,
    pub connection_pin: TerminalConnectionPin,
    pub profile: TerminalProfile,
    pub size: TerminalSize,
    pub name: String,
}

pub(super) struct CreateContext<'a> {
    pub id: Uuid,
    pub replacement_id: Option<Uuid>,
    pub connection: PinnedConnection,
    pub session_token: &'a str,
    pub runtime_file: Option<&'a Path>,
    pub cli_directory: &'a Path,
    pub output: Channel<TerminalOutputChunk>,
    pub app: &'a AppHandle,
}

impl TerminalManager {
    pub(crate) fn new(broker_sessions: BrokerSessionRegistry) -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            broker_sessions,
        }
    }

    pub(super) fn create(
        &self,
        request: TerminalCreateRequest,
        context: CreateContext<'_>,
    ) -> AppResult<TerminalSessionSummary> {
        self.prune_exited();
        let replacement_is_running = context.replacement_id.is_some_and(|id| {
            self.sessions
                .get(&id)
                .is_some_and(|session| !session.lifecycle().is_terminal())
        });
        if session_limit_reached(self.running_count(), replacement_is_running) {
            return Err(AppError::Blocked {
                reason: format!("at most {MAX_SESSIONS} Terminal sessions may run at once"),
            });
        }
        if request.connection_id != context.connection.connection_id {
            return Err(AppError::Config(
                "Terminal request and pinned connection do not match".into(),
            ));
        }
        let size = request
            .size
            .validate()
            .map_err(|reason| AppError::Config(reason.into()))?;
        let name = normalize_name(request.name.as_deref(), request.profile)?;
        let working_directory = neutral_working_directory()?;
        let command = command_for_profile(
            request.profile,
            LaunchEnvironment {
                session_id: context.id,
                connection_id: context.connection.connection_id,
                session_token: context.session_token,
                runtime_file: context.runtime_file,
                cli_directory: context.cli_directory,
                working_directory: &working_directory,
            },
        )?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(to_pty_size(size))
            .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
        let process_tree = match ProcessTree::attach(child.as_ref()) {
            Ok(tree) => Arc::new(tree),
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = process_tree.force_terminate();
                let _ = child.kill();
                return Err(AppError::Io(std::io::Error::other(error.to_string())));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = process_tree.force_terminate();
                let _ = child.kill();
                return Err(AppError::Io(std::io::Error::other(error.to_string())));
            }
        };
        let killer = child.clone_killer();
        drop(pair.slave);
        let now = Utc::now();
        let connection_pin = TerminalConnectionPin::from_connection(&context.connection);
        let session = Arc::new(TerminalSession {
            id: context.id,
            launch: LaunchSpec {
                profile: request.profile,
                connection: context.connection,
                connection_pin,
            },
            metadata: Mutex::new(SessionMetadata {
                name,
                lifecycle: TerminalLifecycle::Running,
                size,
                created_at: now,
                last_activity_at: now,
                exit: None,
            }),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(Some(killer)),
            process_tree: Mutex::new(Some(process_tree)),
            output: Mutex::new(OutputState::new(context.output)),
        });
        if self.sessions.insert(context.id, session.clone()).is_some() {
            session.request_stop();
            return Err(AppError::Config(
                "Terminal session identifier collision".into(),
            ));
        }

        let wait_session = session.clone();
        let wait_registry = self.broker_sessions.clone();
        let wait_app = context.app.clone();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("terminal-wait-{}", short_id(context.id)))
            .spawn(move || wait_for_child(wait_session, child, wait_registry, wait_app))
        {
            self.sessions.remove(&context.id);
            session.request_stop();
            self.broker_sessions.revoke(context.id);
            return Err(error.into());
        }

        let read_session = session.clone();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("terminal-read-{}", short_id(context.id)))
            .spawn(move || read_output(read_session, reader))
        {
            session.request_stop();
            self.broker_sessions.revoke(context.id);
            return Err(error.into());
        }

        let summary = session.summary();
        emit_state(context.app, &summary);
        Ok(summary)
    }

    pub(super) fn list(&self) -> Vec<TerminalSessionSummary> {
        let mut sessions = self
            .sessions
            .iter()
            .map(|entry| entry.value().summary())
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| session.created_at);
        sessions
    }

    pub(super) fn focus(
        &self,
        id: Uuid,
        after_sequence: Option<u64>,
        output: Channel<TerminalOutputChunk>,
    ) -> AppResult<TerminalFocusReceipt> {
        let session = self.session(id)?;
        let replay = session.attach(after_sequence, output)?;
        Ok(TerminalFocusReceipt {
            session: session.summary(),
            replay_from: replay.replay_from,
            replay_through: replay.replay_through,
            replay_truncated: replay.truncated,
        })
    }

    pub(super) fn write(&self, id: Uuid, bytes: Vec<u8>) -> AppResult<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(AppError::Blocked {
                reason: format!("Terminal input exceeds {MAX_INPUT_BYTES} bytes"),
            });
        }
        let session = self.session(id)?;
        if session.lifecycle().is_terminal() {
            return Err(AppError::Blocked {
                reason: "the Terminal session has already exited".into(),
            });
        }
        let mut writer = session.writer.lock().unwrap();
        let writer = writer.as_mut().ok_or_else(|| AppError::Blocked {
            reason: "the Terminal input stream is closed".into(),
        })?;
        writer.write_all(&bytes)?;
        writer.flush()?;
        session.touch();
        Ok(())
    }

    pub(super) fn resize(&self, id: Uuid, size: TerminalSize) -> AppResult<()> {
        let size = size
            .validate()
            .map_err(|reason| AppError::Config(reason.into()))?;
        let session = self.session(id)?;
        let master = session.master.lock().unwrap();
        let master = master.as_ref().ok_or_else(|| AppError::Blocked {
            reason: "the Terminal PTY is closed".into(),
        })?;
        master
            .resize(to_pty_size(size))
            .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
        session.metadata.lock().unwrap().size = size;
        Ok(())
    }

    pub(super) fn rename(
        &self,
        id: Uuid,
        name: &str,
        app: &AppHandle,
    ) -> AppResult<TerminalSessionSummary> {
        let session = self.session(id)?;
        let name = normalize_explicit_name(name)?;
        session.metadata.lock().unwrap().name = name;
        let summary = session.summary();
        emit_state(app, &summary);
        Ok(summary)
    }

    pub(super) fn kill(&self, id: Uuid, app: &AppHandle) -> AppResult<TerminalSessionSummary> {
        let session = self.session(id)?;
        if !session.lifecycle().is_terminal() {
            {
                let mut metadata = session.metadata.lock().unwrap();
                metadata.lifecycle = TerminalLifecycle::Stopping;
                metadata.last_activity_at = Utc::now();
            }
            self.broker_sessions.revoke(id);
            session.request_stop();
            let force_session = session.clone();
            std::thread::spawn(move || {
                std::thread::sleep(FORCE_KILL_AFTER);
                if !force_session.lifecycle().is_terminal() {
                    force_session.force_stop();
                }
            });
        }
        let summary = session.summary();
        emit_state(app, &summary);
        Ok(summary)
    }

    pub(super) fn close(&self, id: Uuid, app: &AppHandle) -> AppResult<()> {
        let session = self.session(id)?;
        if !session.lifecycle().is_terminal() {
            let _ = self.kill(id, app)?;
            let deadline = Instant::now() + FORCE_KILL_AFTER;
            while Instant::now() < deadline && !session.lifecycle().is_terminal() {
                std::thread::sleep(Duration::from_millis(10));
            }
            if !session.lifecycle().is_terminal() {
                session.force_stop();
            }
        }
        self.broker_sessions.revoke(id);
        self.sessions.remove(&id);
        Ok(())
    }

    pub(super) fn restart_seed(&self, id: Uuid) -> AppResult<RestartSeed> {
        let session = self.session(id)?;
        let metadata = session.metadata.lock().unwrap();
        Ok(RestartSeed {
            connection: session.launch.connection.clone(),
            connection_pin: session.launch.connection_pin.clone(),
            profile: session.launch.profile,
            size: metadata.size,
            name: metadata.name.clone(),
        })
    }

    pub(super) fn forget(&self, id: Uuid) {
        self.sessions.remove(&id);
    }

    pub(crate) fn stop_connection(&self, connection_id: Uuid, app: &AppHandle) -> usize {
        self.broker_sessions.revoke_connection(connection_id);
        let ids = self
            .sessions
            .iter()
            .filter_map(|entry| {
                (entry.launch.connection.connection_id == connection_id
                    && !entry.lifecycle().is_terminal())
                .then_some(*entry.key())
            })
            .collect::<Vec<_>>();
        for id in &ids {
            let _ = self.kill(*id, app);
        }
        ids.len()
    }

    pub(crate) fn stop_all(&self, app: &AppHandle) {
        self.broker_sessions.revoke_all();
        let ids = self
            .sessions
            .iter()
            .filter_map(|entry| (!entry.lifecycle().is_terminal()).then_some(*entry.key()))
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.kill(id, app);
        }
    }

    pub(crate) fn shutdown_all(&self, app: &AppHandle, timeout: Duration) {
        let ids = self
            .sessions
            .iter()
            .map(|entry| *entry.key())
            .collect::<Vec<_>>();
        self.stop_all(app);
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if ids.iter().all(|id| {
                self.sessions
                    .get(id)
                    .is_none_or(|session| session.lifecycle().is_terminal())
            }) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        for id in ids {
            if let Some(session) = self.sessions.get(&id) {
                if !session.lifecycle().is_terminal() {
                    session.force_stop();
                }
            }
            self.broker_sessions.revoke(id);
        }
    }

    fn session(&self, id: Uuid) -> AppResult<Arc<TerminalSession>> {
        self.sessions
            .get(&id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| AppError::NotFound(format!("Terminal session {id}")))
    }

    fn running_count(&self) -> usize {
        self.sessions
            .iter()
            .filter(|entry| !entry.lifecycle().is_terminal())
            .count()
    }

    fn prune_exited(&self) {
        let mut exited = self
            .sessions
            .iter()
            .filter_map(|entry| {
                let summary = entry.summary();
                summary
                    .lifecycle
                    .is_terminal()
                    .then_some((summary.created_at, *entry.key()))
            })
            .collect::<Vec<_>>();
        exited.sort_by_key(|(created_at, _)| *created_at);
        let keep = MAX_SESSIONS / 2;
        let remove = exited.len().saturating_sub(keep);
        for (_, id) in exited.into_iter().take(remove) {
            self.sessions.remove(&id);
        }
    }
}

impl TerminalSession {
    fn summary(&self) -> TerminalSessionSummary {
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

    fn lifecycle(&self) -> TerminalLifecycle {
        self.metadata.lock().unwrap().lifecycle
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

    fn attach(
        &self,
        after_sequence: Option<u64>,
        subscriber: Channel<TerminalOutputChunk>,
    ) -> AppResult<ReplayReceipt> {
        self.output
            .lock()
            .unwrap()
            .attach(self.id, after_sequence, subscriber)
    }

    fn request_stop(&self) {
        if let Some(tree) = self.process_tree.lock().unwrap().as_ref() {
            if let Err(error) = tree.terminate() {
                tracing::warn!(session_id = %self.id, "failed to terminate Terminal process tree: {error}");
            }
        }
        if let Some(killer) = self.killer.lock().unwrap().as_mut() {
            let _ = killer.kill();
        }
    }

    fn force_stop(&self) {
        if let Some(tree) = self.process_tree.lock().unwrap().as_ref() {
            if let Err(error) = tree.force_terminate() {
                tracing::warn!(session_id = %self.id, "failed to force-terminate Terminal process tree: {error}");
            }
        }
        if let Some(killer) = self.killer.lock().unwrap().as_mut() {
            let _ = killer.kill();
        }
    }
}

impl OutputState {
    fn new(subscriber: Channel<TerminalOutputChunk>) -> Self {
        Self {
            next_sequence: 1,
            dropped_through: 0,
            replay_bytes: 0,
            replay: VecDeque::new(),
            subscriber: Some(subscriber),
        }
    }

    fn publish(&mut self, session_id: Uuid, bytes: Vec<u8>) {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.replay_bytes = self.replay_bytes.saturating_add(bytes.len());
        self.replay.push_back(ReplayEntry {
            sequence,
            bytes: bytes.clone(),
        });
        while self.replay_bytes > REPLAY_BYTES {
            let Some(entry) = self.replay.pop_front() else {
                break;
            };
            self.replay_bytes = self.replay_bytes.saturating_sub(entry.bytes.len());
            self.dropped_through = entry.sequence;
        }
        let Some(subscriber) = self.subscriber.clone() else {
            return;
        };
        if subscriber
            .send(TerminalOutputChunk {
                session_id,
                sequence,
                bytes,
                replay: false,
            })
            .is_err()
        {
            self.subscriber = None;
        }
    }

    fn attach(
        &mut self,
        session_id: Uuid,
        after_sequence: Option<u64>,
        subscriber: Channel<TerminalOutputChunk>,
    ) -> AppResult<ReplayReceipt> {
        let after = after_sequence.unwrap_or(0);
        let replay = self
            .replay
            .iter()
            .filter(|entry| entry.sequence > after)
            .collect::<Vec<_>>();
        let replay_from = replay.first().map(|entry| entry.sequence);
        for entry in replay {
            subscriber
                .send(TerminalOutputChunk {
                    session_id,
                    sequence: entry.sequence,
                    bytes: entry.bytes.clone(),
                    replay: true,
                })
                .map_err(|_| {
                    AppError::Config("the Terminal output channel is unavailable".into())
                })?;
        }
        self.subscriber = Some(subscriber);
        Ok(ReplayReceipt {
            replay_from,
            replay_through: self.next_sequence.saturating_sub(1),
            truncated: after < self.dropped_through,
        })
    }
}

struct ReplayReceipt {
    replay_from: Option<u64>,
    replay_through: u64,
    truncated: bool,
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

fn emit_state(app: &AppHandle, summary: &TerminalSessionSummary) {
    if let Err(error) = app.emit(
        "terminal:state",
        TerminalStateEvent {
            session: summary.clone(),
        },
    ) {
        tracing::warn!(session_id = %summary.id, "failed to emit terminal:state: {error}");
    }
}

fn normalize_name(name: Option<&str>, profile: TerminalProfile) -> AppResult<String> {
    match name {
        Some(name) => normalize_explicit_name(name),
        None => Ok(profile.default_name().into()),
    }
}

fn normalize_explicit_name(name: &str) -> AppResult<String> {
    let normalized = name
        .chars()
        .filter(|character| !character.is_control())
        .take(64)
        .collect::<String>();
    let normalized = normalized.trim();
    if normalized.is_empty() {
        Err(AppError::Config(
            "Terminal session name cannot be empty".into(),
        ))
    } else {
        Ok(normalized.into())
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

fn short_id(id: Uuid) -> String {
    id.simple().to_string()[..8].to_string()
}

fn session_limit_reached(running: usize, replacement_is_running: bool) -> bool {
    running.saturating_sub(usize::from(replacement_is_running)) >= MAX_SESSIONS
}

#[cfg(test)]
mod tests {
    use tauri::ipc::InvokeResponseBody;

    use super::*;

    fn channel() -> Channel<TerminalOutputChunk> {
        Channel::new(|_body: InvokeResponseBody| Ok(()))
    }

    #[test]
    fn replay_is_byte_bounded_and_reports_truncation() {
        let session_id = Uuid::new_v4();
        let mut output = OutputState::new(channel());
        for _ in 0..40 {
            output.publish(session_id, vec![b'x'; 16 * 1024]);
        }
        assert!(output.replay_bytes <= REPLAY_BYTES);
        assert!(output.dropped_through > 0);
        let receipt = output.attach(session_id, Some(0), channel()).unwrap();
        assert!(receipt.truncated);
        assert!(receipt.replay_from.is_some());
        assert_eq!(receipt.replay_through, 40);
    }

    #[test]
    fn names_strip_controls_and_enforce_a_bound() {
        let name = normalize_explicit_name(&format!("  hello\u{0}{}  ", "x".repeat(100))).unwrap();
        assert!(name.starts_with("hello"));
        assert!(name.chars().count() <= 64);
        assert!(normalize_explicit_name("\n\t").is_err());
    }

    #[test]
    fn dimensions_are_bounded() {
        assert!(TerminalSize::default().validate().is_ok());
        assert!(TerminalSize {
            cols: 0,
            ..TerminalSize::default()
        }
        .validate()
        .is_err());
    }

    #[test]
    fn restart_can_replace_one_session_at_the_limit() {
        assert!(session_limit_reached(MAX_SESSIONS, false));
        assert!(!session_limit_reached(MAX_SESSIONS, true));
        assert!(session_limit_reached(MAX_SESSIONS + 1, true));
    }
}
