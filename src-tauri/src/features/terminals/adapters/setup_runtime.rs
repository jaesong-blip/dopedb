//! Single-writer registry for connectionless, capability-free Skill setup PTYs.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dashmap::{mapref::entry::Entry, DashMap};
use portable_pty::{native_pty_system, PtySize};
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::TerminalSessionId;
use crate::kernel::sync::lock_unpoisoned;

use super::super::domain::{
    SkillSetupTerminalCreateRequest, SkillSetupTerminalSessionSummary, TerminalOutputChunk,
    TerminalSize,
};
use super::environment::{
    command_for_skill_setup, neutral_working_directory, SkillSetupLaunchEnvironment,
};
use super::process_tree::ProcessTree;
use super::session::FORCE_KILL_AFTER;
use super::setup_session::{
    emit_setup_state, SkillSetupSessionResources, SkillSetupTerminalSession,
};

const MAX_SETUP_SESSIONS: usize = 1;

#[derive(Clone, Default)]
pub(super) struct SkillSetupTerminalRuntime {
    setup_sessions: Arc<DashMap<TerminalSessionId, Arc<SkillSetupTerminalSession>>>,
    create_lock: Arc<Mutex<()>>,
}

pub(super) struct SkillSetupCreateContext<'a> {
    pub id: TerminalSessionId,
    pub cli_directory: &'a Path,
    pub output: Channel<TerminalOutputChunk>,
    pub app: &'a AppHandle,
}

impl SkillSetupTerminalRuntime {
    pub(super) fn create(
        &self,
        request: SkillSetupTerminalCreateRequest,
        context: SkillSetupCreateContext<'_>,
    ) -> AppResult<SkillSetupTerminalSessionSummary> {
        let _create_guard = lock_unpoisoned(&self.create_lock);
        self.prune_exited();
        if self.running_count() >= MAX_SETUP_SESSIONS {
            return Err(AppError::Blocked {
                reason: "only one Skill setup Terminal may run at once".into(),
            });
        }
        let size = request
            .size
            .validate()
            .map_err(|reason| AppError::Config(reason.into()))?;
        let working_directory = neutral_working_directory()?;
        let command = command_for_skill_setup(SkillSetupLaunchEnvironment {
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
        let session = Arc::new(SkillSetupTerminalSession::new(
            context.id,
            size,
            SkillSetupSessionResources {
                master: pair.master,
                writer,
                killer,
                process_tree,
                output: context.output,
            },
        ));
        match self.setup_sessions.entry(context.id) {
            Entry::Vacant(entry) => {
                entry.insert(session.clone());
            }
            Entry::Occupied(_) => {
                session.request_stop();
                return Err(AppError::Config(
                    "Skill setup Terminal session identifier collision".into(),
                ));
            }
        }
        if let Err(error) = session.spawn_waiter(child, context.app.clone()) {
            self.setup_sessions.remove(&context.id);
            session.force_stop();
            return Err(error.into());
        }
        if let Err(error) = session.spawn_reader(reader) {
            self.setup_sessions.remove(&context.id);
            session.force_stop();
            return Err(error.into());
        }

        let summary = session.summary();
        emit_setup_state(context.app, &summary);
        Ok(summary)
    }

    pub(super) fn write(&self, id: TerminalSessionId, bytes: Vec<u8>) -> AppResult<()> {
        self.session(id)?.write(bytes)
    }

    pub(super) fn resize(&self, id: TerminalSessionId, size: TerminalSize) -> AppResult<()> {
        self.session(id)?.resize(size)
    }

    pub(super) fn close(&self, id: TerminalSessionId, app: &AppHandle) -> AppResult<()> {
        let session = self.session(id)?;
        if !session.lifecycle().is_terminal() {
            session.mark_stopping();
            emit_setup_state(app, &session.summary());
            session.request_stop();
            let deadline = Instant::now() + FORCE_KILL_AFTER;
            while Instant::now() < deadline && !session.lifecycle().is_terminal() {
                std::thread::sleep(Duration::from_millis(10));
            }
            if !session.lifecycle().is_terminal() {
                session.force_stop();
            }
        }
        self.setup_sessions.remove(&id);
        Ok(())
    }

    pub(super) fn shutdown_all(&self, app: &AppHandle, timeout: Duration) {
        let ids = self
            .setup_sessions
            .iter()
            .map(|entry| *entry.key())
            .collect::<Vec<_>>();
        for id in &ids {
            if let Some(session) = self.setup_sessions.get(id) {
                if !session.lifecycle().is_terminal() {
                    session.mark_stopping();
                    emit_setup_state(app, &session.summary());
                    session.request_stop();
                }
            }
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline
            && ids.iter().any(|id| {
                self.setup_sessions
                    .get(id)
                    .is_some_and(|session| !session.lifecycle().is_terminal())
            })
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        for id in ids {
            if let Some(session) = self.setup_sessions.get(&id) {
                if !session.lifecycle().is_terminal() {
                    session.force_stop();
                }
            }
            self.setup_sessions.remove(&id);
        }
    }

    fn session(&self, id: TerminalSessionId) -> AppResult<Arc<SkillSetupTerminalSession>> {
        self.setup_sessions
            .get(&id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| AppError::NotFound(format!("Skill setup Terminal session {id}")))
    }

    fn running_count(&self) -> usize {
        self.setup_sessions
            .iter()
            .filter(|entry| !entry.lifecycle().is_terminal())
            .count()
    }

    fn prune_exited(&self) {
        let exited = self
            .setup_sessions
            .iter()
            .filter_map(|entry| entry.lifecycle().is_terminal().then_some(*entry.key()))
            .collect::<Vec<_>>();
        for id in exited {
            self.setup_sessions.remove(&id);
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
