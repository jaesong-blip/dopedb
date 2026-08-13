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
    TerminalCreateRequest, TerminalOutputChunk, TerminalSessionSummary, TerminalSize,
};
use super::authority::connection_pin;
use super::environment::{neutral_working_directory, shell_command, LaunchEnvironment};
use super::process_tree::ProcessTree;
use super::session::{
    emit_state, SessionLaunch, SessionResources, TerminalSession, FORCE_KILL_AFTER,
};

const MAX_SESSIONS: usize = 16;

#[derive(Clone)]
pub(super) struct PtyTerminalRuntime {
    sessions: Arc<DashMap<TerminalSessionId, Arc<TerminalSession>>>,
    broker_sessions: BrokerSessionRegistry,
}

pub(super) struct CreateContext<'a> {
    pub id: TerminalSessionId,
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
        if self.running_count() >= MAX_SESSIONS {
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
        let working_directory = neutral_working_directory()?;
        let command = shell_command(LaunchEnvironment {
            session_id: context.id,
            connection_id: ConnectionId::from(context.connection.connection_id),
            session_token: context.session_token,
            runtime_file: context.runtime_file,
            cli_directory: context.cli_directory,
            working_directory: &working_directory,
        })?;
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
            "Shell".into(),
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

    pub(super) fn write(&self, id: TerminalSessionId, bytes: Vec<u8>) -> AppResult<()> {
        self.session(id)?.write(bytes)
    }

    pub(super) fn resize(&self, id: TerminalSessionId, size: TerminalSize) -> AppResult<()> {
        self.session(id)?.resize(size)
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

fn to_pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: size.pixel_width,
        pixel_height: size.pixel_height,
    }
}
