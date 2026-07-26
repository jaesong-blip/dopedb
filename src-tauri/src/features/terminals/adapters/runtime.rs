//! In-memory PTY session owner. Nothing here is persisted: output, process handles,
//! and broker capabilities all die with the desktop runtime.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use portable_pty::{native_pty_system, PtySize};
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::broker::BrokerSessionRegistry;
use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, TerminalSessionId};
use crate::store::PinnedConnection;

use super::super::domain::{
    TerminalCreateRequest, TerminalFocusReceipt, TerminalOutputChunk, TerminalProfile,
    TerminalSessionSummary, TerminalSize,
};
use super::authority::connection_pin;
use super::environment::{command_for_profile, neutral_working_directory, LaunchEnvironment};
use super::process_tree::ProcessTree;
use super::session::{
    emit_state, RestartSeed, SessionLaunch, SessionResources, TerminalSession, FORCE_KILL_AFTER,
};

const MAX_SESSIONS: usize = 16;

#[derive(Clone)]
pub(super) struct PtyTerminalRuntime {
    sessions: Arc<DashMap<TerminalSessionId, Arc<TerminalSession>>>,
    broker_sessions: BrokerSessionRegistry,
}

pub(super) struct CreateContext<'a> {
    pub id: TerminalSessionId,
    pub replacement_id: Option<TerminalSessionId>,
    pub connection: PinnedConnection,
    pub session_token: &'a str,
    pub runtime_file: Option<&'a Path>,
    pub cli_directory: &'a Path,
    pub output: Channel<TerminalOutputChunk>,
    pub app: &'a AppHandle,
}

impl PtyTerminalRuntime {
    pub(super) fn new(broker_sessions: BrokerSessionRegistry) -> Self {
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
        if request.connection_id != ConnectionId::from(context.connection.connection_id) {
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
                connection_id: ConnectionId::from(context.connection.connection_id),
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
        let connection_pin = connection_pin(&context.connection);
        let session = Arc::new(TerminalSession::new(
            context.id,
            SessionLaunch {
                profile: request.profile,
                connection: context.connection,
                connection_pin,
            },
            name,
            size,
            SessionResources {
                master: pair.master,
                writer,
                killer,
                process_tree,
                output: context.output,
            },
        ));
        if self.sessions.insert(context.id, session.clone()).is_some() {
            session.request_stop();
            return Err(AppError::Config(
                "Terminal session identifier collision".into(),
            ));
        }

        if let Err(error) =
            session.spawn_waiter(child, self.broker_sessions.clone(), context.app.clone())
        {
            self.sessions.remove(&context.id);
            session.request_stop();
            self.broker_sessions.revoke(context.id);
            return Err(error.into());
        }

        if let Err(error) = session.spawn_reader(reader) {
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
        id: TerminalSessionId,
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

    pub(super) fn write(&self, id: TerminalSessionId, bytes: Vec<u8>) -> AppResult<()> {
        self.session(id)?.write(bytes)
    }

    pub(super) fn resize(&self, id: TerminalSessionId, size: TerminalSize) -> AppResult<()> {
        self.session(id)?.resize(size)
    }

    pub(super) fn rename(
        &self,
        id: TerminalSessionId,
        name: &str,
        app: &AppHandle,
    ) -> AppResult<TerminalSessionSummary> {
        let session = self.session(id)?;
        let name = normalize_explicit_name(name)?;
        let summary = session.rename(name);
        emit_state(app, &summary);
        Ok(summary)
    }

    pub(super) fn kill(
        &self,
        id: TerminalSessionId,
        app: &AppHandle,
    ) -> AppResult<TerminalSessionSummary> {
        let session = self.session(id)?;
        if !session.lifecycle().is_terminal() {
            session.mark_stopping();
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

    pub(super) fn close(&self, id: TerminalSessionId, app: &AppHandle) -> AppResult<()> {
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

    pub(super) fn restart_seed(&self, id: TerminalSessionId) -> AppResult<RestartSeed> {
        Ok(self.session(id)?.restart_seed())
    }

    pub(super) fn forget(&self, id: TerminalSessionId) {
        self.sessions.remove(&id);
    }

    pub(super) fn stop_connection(&self, connection_id: ConnectionId, app: &AppHandle) -> usize {
        self.broker_sessions.revoke_connection(connection_id);
        let ids = self
            .sessions
            .iter()
            .filter_map(|entry| {
                (entry.connection_id() == connection_id && !entry.lifecycle().is_terminal())
                    .then_some(*entry.key())
            })
            .collect::<Vec<_>>();
        for id in &ids {
            let _ = self.kill(*id, app);
        }
        ids.len()
    }

    pub(super) fn stop_all(&self, app: &AppHandle) {
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

    pub(super) fn shutdown_all(&self, app: &AppHandle, timeout: Duration) {
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

    fn session(&self, id: TerminalSessionId) -> AppResult<Arc<TerminalSession>> {
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

fn session_limit_reached(running: usize, replacement_is_running: bool) -> bool {
    running.saturating_sub(usize::from(replacement_is_running)) >= MAX_SESSIONS
}

#[cfg(test)]
mod tests {
    use super::*;

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
