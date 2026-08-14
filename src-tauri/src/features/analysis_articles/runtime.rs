//! Foreground/background scheduler for live Analysis Articles. The control plane
//! leases exact immutable revisions; Desktop keeps credentials, executes bounded
//! reads locally, and uploads only privacy-minimized reviewed block fragments.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dopedb_protocol::{AnalysisRunError, AnalysisRunState, AnalysisRunTrigger};
use uuid::Uuid;

use super::adapters::hosted::{
    analysis_refresh_lease_is_active, analysis_runner_capability_is_missing,
    analysis_runner_registration_guard, claim_analysis_refresh_lease, complete_analysis_run,
    get_analysis_run, register_analysis_runner, release_analysis_refresh_lease, start_analysis_run,
    RemoteAnalysisLease, RemoteAnalysisRun,
};
use crate::error::{AppError, AppResult};
use crate::executor::cancel;
use crate::features::knowledge::KnowledgeFeature;
use crate::kernel::access::{ActiveResourceScope, WorkspaceKind};

use super::runtime_ports::{AnalysisRunnerChanged, AnalysisRuntimeDesktopPort};
use super::{AnalysisDefinitionRunRequest, DesktopAnalysisArticlesFeature};

const POLL_INTERVAL: Duration = Duration::from_secs(20);
const AUTHORITY_POLL_INTERVAL: Duration = Duration::from_secs(1);
const MAX_CLAIMS_PER_TICK: usize = 4;

#[derive(Clone)]
pub(crate) struct AnalysisRunnerRuntime {
    started: Arc<AtomicBool>,
    background_allowed: Arc<AtomicBool>,
    dependencies: AnalysisRunnerDependencies,
}

#[derive(Clone)]
struct AnalysisRunnerDependencies {
    knowledge: KnowledgeFeature,
    analysis: DesktopAnalysisArticlesFeature,
}

impl AnalysisRunnerRuntime {
    pub(crate) fn new(
        background_allowed: bool,
        knowledge: KnowledgeFeature,
        analysis: DesktopAnalysisArticlesFeature,
    ) -> Self {
        Self {
            started: Arc::new(AtomicBool::new(false)),
            background_allowed: Arc::new(AtomicBool::new(background_allowed)),
            dependencies: AnalysisRunnerDependencies {
                knowledge,
                analysis,
            },
        }
    }

    pub(crate) fn set_background_allowed(&self, allowed: bool) {
        self.background_allowed.store(allowed, Ordering::Release);
    }

    pub(crate) fn background_allowed(&self) -> bool {
        self.background_allowed.load(Ordering::Acquire)
    }

    pub(crate) fn start(&self, desktop: Arc<dyn AnalysisRuntimeDesktopPort>) {
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let background_allowed = self.background_allowed.clone();
        let dependencies = self.dependencies.clone();
        let background_launch = std::env::args().any(|argument| {
            crate::features::automation_runner::is_background_launch_argument(&argument)
        });
        tokio::spawn(async move {
            loop {
                let allowed = background_allowed.load(Ordering::Acquire);
                if background_launch && !allowed {
                    emit(desktop.as_ref(), "disabled", None, None, None);
                    break;
                }
                if let Err(error) =
                    poll_active_scope(&dependencies, desktop.as_ref(), allowed, background_launch)
                        .await
                {
                    tracing::warn!(
                        error_kind = error.kind(),
                        "Analysis Article scheduler poll deferred"
                    );
                    emit(desktop.as_ref(), "deferred", None, None, Some(error.kind()));
                }
                tokio::time::sleep(POLL_INTERVAL).await;
            }
        });
    }
}

async fn poll_active_scope(
    dependencies: &AnalysisRunnerDependencies,
    desktop: &dyn AnalysisRuntimeDesktopPort,
    background_allowed: bool,
    background_launch: bool,
) -> AppResult<()> {
    let scope = dependencies.knowledge.active_resource_scope().await?;
    if scope.workspace_kind != WorkspaceKind::Team {
        return Ok(());
    }
    let Some(account_id) = scope.selected_account_id.as_deref() else {
        return Ok(());
    };
    let registration_guard = analysis_runner_registration_guard().await;
    let mut device_id = dependencies
        .analysis
        .runner_device_id(account_id, scope.workspace_id)
        .await?
        .to_string();
    emit(desktop, "registering", None, None, None);
    let runner = match register_analysis_runner(
        account_id,
        scope.workspace_id,
        &device_id,
        background_allowed,
    )
    .await
    {
        Ok(runner) => runner,
        Err(error) if analysis_runner_capability_is_missing(&error) => {
            device_id = dependencies
                .analysis
                .replace_runner_device_id(account_id, scope.workspace_id)
                .await?
                .to_string();
            register_analysis_runner(
                account_id,
                scope.workspace_id,
                &device_id,
                background_allowed,
            )
            .await?
        }
        Err(error) => return Err(error),
    };
    drop(registration_guard);
    for _ in 0..MAX_CLAIMS_PER_TICK {
        let Some(lease) = claim_analysis_refresh_lease(
            account_id,
            scope.workspace_id,
            runner.runner.id,
            &device_id,
            background_launch,
            runner.capability(),
            runner.generation(),
        )
        .await?
        else {
            break;
        };
        let article_id = lease.article_id;
        let run_id = Uuid::new_v4();
        emit(desktop, "running", Some(article_id), Some(run_id), None);
        if let Err(error) =
            execute_lease(dependencies, desktop, &scope, account_id, lease, run_id).await
        {
            tracing::warn!(
                article_id = %article_id,
                error_kind = error.kind(),
                "scheduled Analysis Article refresh failed"
            );
            emit(
                desktop,
                "failed",
                Some(article_id),
                None,
                Some(error.kind()),
            );
        }
    }
    emit(desktop, "ready", None, None, None);
    Ok(())
}

async fn execute_lease(
    dependencies: &AnalysisRunnerDependencies,
    desktop: &dyn AnalysisRuntimeDesktopPort,
    scope: &ActiveResourceScope,
    account_id: &str,
    lease: RemoteAnalysisLease,
    run_id: Uuid,
) -> AppResult<()> {
    if chrono::Utc::now() >= lease.expires_at || lease.scheduled_at > chrono::Utc::now() {
        return Err(AppError::Blocked {
            reason: "Analysis refresh lease is outside its execution window".into(),
        });
    }
    let started = start_analysis_run(
        account_id,
        scope.workspace_id,
        lease.article_id,
        lease.article_revision,
        lease.runner_id,
        run_id,
        AnalysisRunTrigger::Schedule,
        &lease.parameter_values,
        lease.runner_capability.as_str(),
        lease.runner_capability_generation,
        Some(&lease),
    )
    .await;
    let (_, article) = match started {
        Ok(value) => value,
        Err(error) => {
            let _ = release_analysis_refresh_lease(account_id, scope.workspace_id, &lease).await;
            return Err(error);
        }
    };
    if article.id != lease.article.id
        || article.revision != lease.article_revision
        || article.live_revision != Some(lease.article_revision)
    {
        let _ = release_analysis_refresh_lease(account_id, scope.workspace_id, &lease).await;
        return Err(AppError::Blocked {
            reason: "scheduled Analysis Article revision is no longer live".into(),
        });
    }
    let request = AnalysisDefinitionRunRequest {
        workspace_id: Some(scope.workspace_id),
        article_id: article.id,
        article_revision: article.revision,
        definition: article.definition.clone(),
        connections: article.connections.clone(),
        parameter_values: lease.parameter_values.clone(),
        run_id,
        persist_local_result: true,
    };
    let execution = dependencies.analysis.run_definition(request);
    tokio::pin!(execution);
    let mut poll = tokio::time::interval(AUTHORITY_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    poll.tick().await;
    let local = loop {
        tokio::select! {
            result = &mut execution => break result,
            _ = poll.tick() => {
                let active = analysis_refresh_lease_is_active(
                    account_id,
                    scope.workspace_id,
                    &lease,
                ).await.unwrap_or(false);
                let run = get_analysis_run(
                    account_id,
                    scope.workspace_id,
                    article.id,
                    run_id,
                ).await;
                let cancelled = !active || run.as_ref().is_ok_and(|run| {
                    run.cancel_requested_at.is_some() || run.state != AnalysisRunState::Running
                });
                if cancelled {
                    cancel::cancel(run_id);
                }
            }
        }
    };
    if dependencies.knowledge.active_resource_scope().await? != *scope {
        cancel::cancel(run_id);
        let error = AppError::Blocked {
            reason: "active workspace changed during scheduled Analysis refresh".into(),
        };
        let _ = complete_failure(
            account_id,
            scope.workspace_id,
            article.id,
            run_id,
            lease.runner_capability.as_str(),
            &error,
        )
        .await;
        return Err(error);
    }
    match local {
        Ok(result) => {
            let remote =
                get_analysis_run(account_id, scope.workspace_id, article.id, run_id).await?;
            if remote.cancel_requested_at.is_some()
                || !analysis_refresh_lease_is_active(account_id, scope.workspace_id, &lease).await?
            {
                let error = Some(AnalysisRunError {
                    kind: "cancelled".into(),
                    message: "scheduled Analysis Article refresh was cancelled".into(),
                });
                complete_analysis_run(
                    account_id,
                    scope.workspace_id,
                    article.id,
                    run_id,
                    lease.runner_capability.as_str(),
                    AnalysisRunState::Cancelled,
                    &result.query_receipts,
                    &[],
                    &error,
                )
                .await?;
                return Ok(());
            }
            let run = complete_analysis_run(
                account_id,
                scope.workspace_id,
                article.id,
                run_id,
                lease.runner_capability.as_str(),
                AnalysisRunState::Succeeded,
                &result.query_receipts,
                &result.fragments,
                &None,
            )
            .await?;
            if let Err(error) = super::signals::evaluate_analysis_signals(
                super::signals::AnalysisSignalEvaluation {
                    desktop,
                    analysis: &dependencies.analysis,
                    account_id,
                    workspace_id: scope.workspace_id,
                    article: &article,
                    runner_id: lease.runner_id,
                    runner_capability: lease.runner_capability.as_str(),
                    run: &run,
                    fragments: &result.fragments,
                    execution_error: None,
                },
            )
            .await
            {
                tracing::warn!(
                    article_id = %article.id,
                    run_id = %run_id,
                    error_kind = error.kind(),
                    "scheduled Analysis signal evaluation deferred"
                );
            }
            Ok(())
        }
        Err(error) => {
            let run = complete_failure(
                account_id,
                scope.workspace_id,
                article.id,
                run_id,
                lease.runner_capability.as_str(),
                &error,
            )
            .await?;
            if run.state != AnalysisRunState::Cancelled {
                if let Err(signal_error) = super::signals::evaluate_analysis_signals(
                    super::signals::AnalysisSignalEvaluation {
                        desktop,
                        analysis: &dependencies.analysis,
                        account_id,
                        workspace_id: scope.workspace_id,
                        article: &article,
                        runner_id: lease.runner_id,
                        runner_capability: lease.runner_capability.as_str(),
                        run: &run,
                        fragments: &[],
                        execution_error: Some(&error),
                    },
                )
                .await
                {
                    tracing::warn!(
                        article_id = %article.id,
                        run_id = %run_id,
                        error_kind = signal_error.kind(),
                        "scheduled Analysis failure signal evaluation deferred"
                    );
                }
            }
            Err(error)
        }
    }
}

async fn complete_failure(
    account_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
    runner_capability: &str,
    error: &AppError,
) -> AppResult<RemoteAnalysisRun> {
    let cancelled = matches!(
        error,
        AppError::Safety(message) if message.to_ascii_lowercase().contains("cancel")
    );
    let completion_error = Some(AnalysisRunError {
        kind: error.kind().chars().take(128).collect(),
        message: error.to_string().chars().take(2_000).collect(),
    });
    complete_analysis_run(
        account_id,
        workspace_id,
        article_id,
        run_id,
        runner_capability,
        if cancelled {
            AnalysisRunState::Cancelled
        } else if matches!(error, AppError::Blocked { .. } | AppError::NotFound(_)) {
            AnalysisRunState::Stale
        } else {
            AnalysisRunState::Failed
        },
        &[],
        &[],
        &completion_error,
    )
    .await
}

fn emit(
    desktop: &dyn AnalysisRuntimeDesktopPort,
    state: &'static str,
    article_id: Option<Uuid>,
    run_id: Option<Uuid>,
    error_kind: Option<&str>,
) {
    desktop.runner_changed(AnalysisRunnerChanged {
        state,
        article_id,
        run_id,
        error_kind: error_kind.map(str::to_owned),
    });
}
