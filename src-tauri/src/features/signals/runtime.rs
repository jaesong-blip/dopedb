//! Foreground Signal runner. Shared control-plane rules are claimed with a
//! short capability, but query results and baseline values stay local.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dopedb_protocol::{
    SignalCondition, SignalEvaluationErrorKind, SignalEvaluationReceiptV1, SignalEvaluationState,
    SignalNotificationChannel, SignalRowCountCategory,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::knowledge::transport::{
    list_funnel_analysis_artifacts_inner, run_funnel_analysis_artifact_inner, FunnelTileRunRequest,
    FunnelTileRunStatus,
};
use crate::features::workspaces::adapters::control_plane::{
    claim_signal_lease, register_signal_runner, submit_signal_receipt, RemoteSignalLease,
};
use crate::features::workspaces::WorkspaceKind;
use crate::kernel::identity::QueryExecutionId;
use crate::model::QueryResult;
use crate::state::AppState;

const POLL_INTERVAL: Duration = Duration::from_secs(20);
const MAX_CLAIMS_PER_TICK: usize = 4;
const MAX_BASELINE_SAMPLES: usize = 1_000;

#[derive(Clone, Default)]
pub(crate) struct SignalRunnerRuntime {
    started: Arc<AtomicBool>,
    background_allowed: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalRunnerChanged {
    state: &'static str,
    rule_id: Option<Uuid>,
    error_kind: Option<String>,
}

struct LocalEvaluation {
    metric_value: Option<f64>,
    sample_count: u64,
    schema_fingerprint: String,
    query_run_ids: Vec<Uuid>,
    sample_state: SignalEvaluationState,
    receipt_state: SignalEvaluationState,
    error_kind: Option<SignalEvaluationErrorKind>,
}

impl SignalRunnerRuntime {
    pub(crate) fn new(background_allowed: bool) -> Self {
        Self {
            started: Arc::new(AtomicBool::new(false)),
            background_allowed: Arc::new(AtomicBool::new(background_allowed)),
        }
    }

    pub(crate) fn background_allowed(&self) -> bool {
        self.background_allowed.load(Ordering::Acquire)
    }

    pub(crate) fn set_background_allowed(&self, allowed: bool) {
        self.background_allowed.store(allowed, Ordering::Release);
    }

    pub(crate) fn start(&self, app: AppHandle) {
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let background_allowed = self.background_allowed.clone();
        let background_launch =
            std::env::args().any(|argument| argument == "--signal-runner-background");
        tauri::async_runtime::spawn(async move {
            loop {
                let allowed = background_allowed.load(Ordering::Acquire);
                if background_launch && !allowed {
                    emit(&app, "disabled", None, None);
                    break;
                }
                if let Err(error) = poll_active_scope(&app, allowed, background_launch).await {
                    tracing::warn!(
                        error_kind = error.kind(),
                        "foreground Signal runner poll deferred"
                    );
                    emit(&app, "deferred", None, Some(error.kind()));
                }
                tokio::time::sleep(POLL_INTERVAL).await;
            }
        });
    }
}

async fn poll_active_scope(
    app: &AppHandle,
    background_allowed: bool,
    background_launch: bool,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let scope = state.knowledge_store().active_resource_scope().await?;
    if scope.workspace_kind != WorkspaceKind::Team {
        return Ok(());
    }
    let Some(account_id) = scope.selected_account_id.as_deref() else {
        return Ok(());
    };
    let device_id = state.knowledge_store().signal_runner_device_id().await?;
    emit(app, "registering", None, None);
    let runner = register_signal_runner(
        account_id,
        scope.workspace_id,
        &device_id.to_string(),
        background_allowed,
    )
    .await?;
    for _ in 0..MAX_CLAIMS_PER_TICK {
        let Some(lease) = claim_signal_lease(
            account_id,
            scope.workspace_id,
            runner.id,
            &device_id.to_string(),
            background_launch,
        )
        .await?
        else {
            break;
        };
        emit(app, "evaluating", Some(lease.rule.rule_id), None);
        evaluate_and_submit(
            app,
            &state,
            &scope,
            account_id,
            &device_id.to_string(),
            lease,
        )
        .await?;
    }
    emit(app, "ready", None, None);
    Ok(())
}

async fn evaluate_and_submit(
    app: &AppHandle,
    state: &AppState,
    scope: &crate::store::ActiveResourceScope,
    account_id: &str,
    device_id: &str,
    lease: RemoteSignalLease,
) -> AppResult<()> {
    if scope.workspace_id != lease.workspace_id || chrono::Utc::now() >= lease.expires_at {
        return Err(AppError::Blocked {
            reason: "Signal lease no longer belongs to the active workspace".into(),
        });
    }
    let started = Instant::now();
    let evaluation = evaluate_metric(state, scope, account_id, &lease).await;
    let evaluated_at = chrono::Utc::now();
    let evaluation = match evaluation {
        Ok(value) => value,
        Err(error) => LocalEvaluation {
            metric_value: None,
            sample_count: 0,
            schema_fingerprint: fallback_schema_fingerprint(&lease),
            query_run_ids: Vec::new(),
            sample_state: if matches!(error, AppError::Blocked { .. } | AppError::NotFound(_)) {
                SignalEvaluationState::Stale
            } else {
                SignalEvaluationState::Error
            },
            receipt_state: if matches!(error, AppError::Blocked { .. } | AppError::NotFound(_)) {
                SignalEvaluationState::Stale
            } else {
                SignalEvaluationState::Error
            },
            error_kind: (!matches!(error, AppError::Blocked { .. } | AppError::NotFound(_)))
                .then_some(SignalEvaluationErrorKind::RunnerError),
        },
    };
    if state.knowledge_store().active_resource_scope().await? != *scope {
        return Err(AppError::Blocked {
            reason: "active workspace changed during Signal evaluation".into(),
        });
    }
    state
        .knowledge_store()
        .record_signal_metric_sample(
            scope.workspace_id,
            account_id,
            lease.rule.rule_id,
            lease.rule.revision,
            lease.scheduled_at,
            evaluated_at,
            evaluation.metric_value,
            evaluation.sample_count,
            evaluation.sample_state,
            &evaluation.schema_fingerprint,
        )
        .await?;
    let receipt = SignalEvaluationReceiptV1 {
        receipt_id: Uuid::new_v4(),
        rule_id: lease.rule.rule_id,
        rule_revision: lease.rule.revision,
        project_environment_id: lease.rule.project_environment_id,
        environment_revision: lease.rule.environment_revision,
        runner_device_id: device_id.to_owned(),
        scheduled_at: lease.scheduled_at,
        evaluated_at,
        state: evaluation.receipt_state,
        query_run_ids: evaluation.query_run_ids,
        connection_ids: lease.rule.connection_ids.clone(),
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        row_count_category: row_count_category(evaluation.sample_count),
        schema_fingerprint: evaluation.schema_fingerprint,
        dedupe_key: format!(
            "{}:{}:{}",
            lease.rule.rule_id,
            lease.rule.revision,
            lease.scheduled_at.to_rfc3339()
        ),
        transition_sequence: lease.next_transition_sequence,
        error_kind: evaluation.error_kind,
    };
    let remote = submit_signal_receipt(account_id, scope.workspace_id, &lease, &receipt).await?;
    if remote.notification_state == "pending"
        && lease
            .rule
            .channels
            .contains(&SignalNotificationChannel::Desktop)
    {
        let _ = app
            .notification()
            .builder()
            .title(format!("DopeDB · {}", remote.state.replace('_', " ")))
            .body(format!(
                "{} · Open Monitoring to inspect the local result.",
                lease.rule.metric_semantic_id
            ))
            .show();
    }
    Ok(())
}

async fn evaluate_metric(
    state: &AppState,
    scope: &crate::store::ActiveResourceScope,
    account_id: &str,
    lease: &RemoteSignalLease,
) -> AppResult<LocalEvaluation> {
    let artifacts =
        list_funnel_analysis_artifacts_inner(state, lease.rule.project_environment_id).await?;
    let artifact = artifacts
        .into_iter()
        .find(|artifact| {
            artifact.id == lease.rule.source_analysis_id
                && u64::try_from(artifact.revision).ok()
                    == Some(lease.rule.source_analysis_revision)
                && artifact.project_environment_id == lease.rule.project_environment_id
                && artifact.environment_revision == lease.rule.environment_revision
                && artifact.state == "published"
        })
        .ok_or_else(|| AppError::NotFound("the exact published Signal analysis".into()))?;
    let bindings = state
        .knowledge_store()
        .environment_connections(scope.workspace_id, lease.rule.project_environment_id)
        .await?;
    if lease.rule.connection_ids.iter().any(|connection_id| {
        !bindings.iter().any(|binding| {
            binding.connection_id == *connection_id
                && binding.environment_revision == lease.rule.environment_revision
                && binding.connection_revision == binding.current_connection_revision
        })
    }) || !lease.analysis_definition.is_object()
        || !artifact
            .tiles
            .iter()
            .any(|tile| tile.definition.id == lease.rule.source_tile_id)
    {
        return Err(AppError::Blocked {
            reason: "Signal analysis or connection revision changed".into(),
        });
    }
    let requests = artifact
        .tiles
        .iter()
        .filter(|tile| tile.dashboard.is_some())
        .map(|tile| FunnelTileRunRequest {
            tile_id: tile.definition.id.clone(),
            query_id: QueryExecutionId::from(Uuid::new_v4()),
        })
        .collect::<Vec<_>>();
    let query_run_ids = requests
        .iter()
        .map(|request| Uuid::from(request.query_id))
        .collect::<Vec<_>>();
    let run = run_funnel_analysis_artifact_inner(
        state,
        lease.rule.project_environment_id,
        artifact.id,
        requests,
    )
    .await?;
    if u64::try_from(run.artifact_revision).ok() != Some(lease.rule.source_analysis_revision) {
        return Err(AppError::Blocked {
            reason: "Signal analysis revision changed during execution".into(),
        });
    }
    let target = run
        .tiles
        .into_iter()
        .find(|tile| tile.tile_id == lease.rule.source_tile_id)
        .ok_or_else(|| AppError::NotFound("the monitored metric tile result".into()))?;
    if target.status != FunnelTileRunStatus::Ok {
        let state_kind = match target.status {
            FunnelTileRunStatus::MissingGrant | FunnelTileRunStatus::Stale => {
                SignalEvaluationState::Stale
            }
            FunnelTileRunStatus::Error => SignalEvaluationState::Error,
            FunnelTileRunStatus::Ok => unreachable!(),
        };
        return condition_for_missing_or_error(
            state,
            scope,
            account_id,
            lease,
            state_kind,
            query_run_ids,
        )
        .await;
    }
    let result: QueryResult = serde_json::from_value(
        target
            .result
            .ok_or_else(|| AppError::Config("metric tile omitted its local result".into()))?,
    )?;
    let schema_fingerprint = hex::encode(Sha256::digest(result.columns.join("\0").as_bytes()));
    let sample_count = result
        .columns
        .iter()
        .position(|column| column == "sample_count")
        .and_then(|index| result.rows.first().and_then(|row| row.get(index)))
        .and_then(json_u64)
        .unwrap_or(result.row_count as u64);
    let metric_value = result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(json_f64);
    let missing = metric_value.is_none() || sample_count < lease.rule.minimum_sample_count;
    if missing {
        return condition_for_missing_or_error(
            state,
            scope,
            account_id,
            lease,
            SignalEvaluationState::NoData,
            query_run_ids,
        )
        .await
        .map(|mut evaluation| {
            evaluation.schema_fingerprint = schema_fingerprint;
            evaluation.sample_count = sample_count;
            evaluation
        });
    }
    let metric_value = metric_value.expect("checked scalar value");
    let recent = state
        .knowledge_store()
        .recent_signal_metric_samples(
            scope.workspace_id,
            account_id,
            lease.rule.rule_id,
            lease.rule.revision,
            MAX_BASELINE_SAMPLES,
        )
        .await?;
    let firing = match lease.rule.condition {
        SignalCondition::ThresholdAbove { value } => metric_value > value,
        SignalCondition::ThresholdBelow { value } => metric_value < value,
        SignalCondition::AbsoluteChange { value } => {
            let Some(baseline) = baseline_mean(&recent, lease) else {
                return Ok(no_baseline_evaluation(
                    metric_value,
                    sample_count,
                    schema_fingerprint,
                    query_run_ids,
                ));
            };
            (metric_value - baseline).abs() >= value
        }
        SignalCondition::PercentageChange { percentage } => {
            let Some(baseline) = baseline_mean(&recent, lease) else {
                return Ok(no_baseline_evaluation(
                    metric_value,
                    sample_count,
                    schema_fingerprint,
                    query_run_ids,
                ));
            };
            if baseline == 0.0 {
                return Ok(LocalEvaluation {
                    metric_value: Some(metric_value),
                    sample_count,
                    schema_fingerprint,
                    query_run_ids,
                    sample_state: SignalEvaluationState::NoData,
                    receipt_state: SignalEvaluationState::NoData,
                    error_kind: None,
                });
            }
            ((metric_value - baseline).abs() / baseline.abs()) * 100.0 >= percentage
        }
        SignalCondition::ConsecutiveFailure { .. } | SignalCondition::MissingData { .. } => false,
    };
    let state_kind = if firing {
        SignalEvaluationState::Firing
    } else {
        SignalEvaluationState::Normal
    };
    Ok(LocalEvaluation {
        metric_value: Some(metric_value),
        sample_count,
        schema_fingerprint,
        query_run_ids,
        sample_state: state_kind,
        receipt_state: state_kind,
        error_kind: None,
    })
}

async fn condition_for_missing_or_error(
    state: &AppState,
    scope: &crate::store::ActiveResourceScope,
    account_id: &str,
    lease: &RemoteSignalLease,
    observed: SignalEvaluationState,
    query_run_ids: Vec<Uuid>,
) -> AppResult<LocalEvaluation> {
    let recent = state
        .knowledge_store()
        .recent_signal_metric_samples(
            scope.workspace_id,
            account_id,
            lease.rule.rule_id,
            lease.rule.revision,
            MAX_BASELINE_SAMPLES,
        )
        .await?;
    let threshold = match lease.rule.condition {
        SignalCondition::ConsecutiveFailure { count }
            if observed == SignalEvaluationState::Error =>
        {
            Some(usize::from(count))
        }
        SignalCondition::MissingData { count } if observed == SignalEvaluationState::NoData => {
            Some(usize::from(count))
        }
        _ => None,
    };
    let receipt_state = if let Some(threshold) = threshold {
        let prior = recent
            .iter()
            .take_while(|sample| sample.observed_state == observed)
            .count();
        if prior + 1 >= threshold {
            SignalEvaluationState::Firing
        } else {
            SignalEvaluationState::Normal
        }
    } else {
        observed
    };
    Ok(LocalEvaluation {
        metric_value: None,
        sample_count: 0,
        schema_fingerprint: fallback_schema_fingerprint(lease),
        query_run_ids,
        sample_state: observed,
        receipt_state,
        error_kind: (receipt_state == SignalEvaluationState::Error)
            .then_some(SignalEvaluationErrorKind::QueryFailed),
    })
}

fn baseline_mean(
    samples: &[crate::store::LocalSignalMetricSample],
    lease: &RemoteSignalLease,
) -> Option<f64> {
    let Some(window_seconds) = lease.rule.baseline_window_seconds else {
        return None;
    };
    let start = lease.scheduled_at - chrono::Duration::seconds(window_seconds as i64);
    let values = samples
        .iter()
        .filter(|sample| sample.evaluated_at >= start && sample.evaluated_at < lease.scheduled_at)
        .filter(|sample| sample.sample_count >= lease.rule.minimum_sample_count)
        .filter_map(|sample| sample.metric_value)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    Some(values.iter().sum::<f64>() / values.len() as f64)
}

fn no_baseline_evaluation(
    metric_value: f64,
    sample_count: u64,
    schema_fingerprint: String,
    query_run_ids: Vec<Uuid>,
) -> LocalEvaluation {
    LocalEvaluation {
        metric_value: Some(metric_value),
        sample_count,
        schema_fingerprint,
        query_run_ids,
        sample_state: SignalEvaluationState::NoData,
        receipt_state: SignalEvaluationState::NoData,
        error_kind: None,
    }
}

fn json_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse::<f64>().ok())
        .filter(|value| value.is_finite())
}

fn json_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse::<u64>().ok())
}

fn fallback_schema_fingerprint(lease: &RemoteSignalLease) -> String {
    hex::encode(Sha256::digest(
        format!(
            "{}:{}:{}",
            lease.rule.source_analysis_id, lease.rule.revision, lease.rule.source_tile_id
        )
        .as_bytes(),
    ))
}

fn row_count_category(count: u64) -> SignalRowCountCategory {
    match count {
        0 => SignalRowCountCategory::Zero,
        1 => SignalRowCountCategory::One,
        2..=100 => SignalRowCountCategory::Small,
        101..=10_000 => SignalRowCountCategory::Medium,
        _ => SignalRowCountCategory::Large,
    }
}

fn emit(app: &AppHandle, state: &'static str, rule_id: Option<Uuid>, error_kind: Option<&str>) {
    let _ = app.emit(
        "signal-runner:changed",
        SignalRunnerChanged {
            state,
            rule_id,
            error_kind: error_kind.map(str::to_owned),
        },
    );
}
