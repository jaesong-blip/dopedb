//! Structured process-start telemetry and the post-paint recovery readiness gate.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tokio::sync::watch;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupStage {
    name: String,
    classification: &'static str,
    started_ms: u64,
    duration_ms: u64,
    status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupSummary {
    elapsed_ms: u64,
    stages: Vec<StartupStage>,
}

struct StartupTraceInner {
    process_started: Instant,
    stages: Mutex<Vec<StartupStage>>,
}

#[derive(Clone)]
pub(crate) struct StartupTrace {
    inner: Arc<StartupTraceInner>,
}

impl StartupTrace {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(StartupTraceInner {
                process_started: Instant::now(),
                stages: Mutex::new(vec![StartupStage {
                    name: "process_started".into(),
                    classification: "critical",
                    started_ms: 0,
                    duration_ms: 0,
                    status: "ready",
                }]),
            }),
        }
    }

    pub(crate) fn stage_started(&self) -> Duration {
        self.inner.process_started.elapsed()
    }

    pub(crate) fn finish(
        &self,
        name: &'static str,
        classification: &'static str,
        started: Duration,
        succeeded: bool,
    ) {
        let finished = self.inner.process_started.elapsed();
        let stage = StartupStage {
            name: name.into(),
            classification,
            started_ms: millis(started),
            duration_ms: millis(finished.saturating_sub(started)),
            status: if succeeded { "ready" } else { "failed" },
        };
        tracing::info!(
            target: "dopedb::startup",
            stage = name,
            classification,
            started_ms = stage.started_ms,
            duration_ms = stage.duration_ms,
            status = stage.status,
            "desktop startup stage"
        );
        self.inner
            .stages
            .lock()
            .expect("startup trace mutex poisoned")
            .push(stage);
    }

    pub(crate) fn mark_once(
        &self,
        name: &'static str,
        classification: &'static str,
        succeeded: bool,
    ) {
        let elapsed = self.inner.process_started.elapsed();
        let mut stages = self
            .inner
            .stages
            .lock()
            .expect("startup trace mutex poisoned");
        if stages.iter().any(|stage| stage.name == name) {
            return;
        }
        let elapsed_ms = millis(elapsed);
        stages.push(StartupStage {
            name: name.into(),
            classification,
            started_ms: elapsed_ms,
            duration_ms: 0,
            status: if succeeded { "ready" } else { "failed" },
        });
        drop(stages);
        tracing::info!(
            target: "dopedb::startup",
            stage = name,
            classification,
            started_ms = elapsed_ms,
            duration_ms = 0_u64,
            status = if succeeded { "ready" } else { "failed" },
            "desktop startup mark"
        );
    }

    pub(crate) fn summary(&self) -> StartupSummary {
        StartupSummary {
            elapsed_ms: millis(self.inner.process_started.elapsed()),
            stages: self
                .inner
                .stages
                .lock()
                .expect("startup trace mutex poisoned")
                .clone(),
        }
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[derive(Clone)]
enum RecoveryState {
    Pending,
    Ready,
    Failed,
}

#[derive(Clone)]
pub(crate) struct PostPaintRecoveryGate {
    started: Arc<AtomicBool>,
    state: watch::Sender<RecoveryState>,
}

impl PostPaintRecoveryGate {
    pub(crate) fn new() -> Self {
        let (state, _) = watch::channel(RecoveryState::Pending);
        Self {
            started: Arc::new(AtomicBool::new(false)),
            state,
        }
    }

    pub(crate) fn claim_start(&self) -> bool {
        !self.started.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn finish(&self, succeeded: bool) {
        self.state.send_replace(if succeeded {
            RecoveryState::Ready
        } else {
            RecoveryState::Failed
        });
    }

    pub(crate) async fn wait(&self) -> AppResult<()> {
        let mut receiver = self.state.subscribe();
        loop {
            match receiver.borrow().clone() {
                RecoveryState::Ready => return Ok(()),
                RecoveryState::Failed => {
                    return Err(AppError::Config(
                        "startup recovery failed; restart DopeDB before running Agent or Job work"
                            .into(),
                    ));
                }
                RecoveryState::Pending => {}
            }
            receiver.changed().await.map_err(|_| {
                AppError::Config("startup recovery readiness channel closed".into())
            })?;
        }
    }
}

#[tauri::command]
pub(crate) fn record_startup_mark(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    mark: String,
    succeeded: Option<bool>,
) -> AppResult<()> {
    let succeeded = succeeded.unwrap_or(true);
    match mark.as_str() {
        "first_shell_commit" => {
            state
                .startup_trace
                .mark_once("first_shell_commit", "post_paint", succeeded);
            state.start_post_paint_recovery(app);
        }
        "selected_connection_restored" => {
            state
                .startup_trace
                .mark_once("selected_connection_restored", "post_paint", succeeded)
        }
        _ => {
            return Err(AppError::Config("unknown startup trace mark".into()));
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn runtime_startup_summary(state: State<'_, AppState>) -> StartupSummary {
    state.startup_trace.summary()
}
