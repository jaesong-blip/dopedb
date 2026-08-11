//! Local evaluation for live Analysis Article signals. Metric values and
//! baselines stay in local SQLite; the hosted control plane receives only a
//! categorical observation bound to one immutable Article run and block schema.

use chrono::{DateTime, Duration, Utc};
use dopedb_protocol::{
    AnalysisArticleDefinition, AnalysisArticleRecord, AnalysisBlock, AnalysisColumn,
    AnalysisColumnMasking, AnalysisColumnSensitivity, AnalysisColumnType, AnalysisResultFragment,
    AnalysisRunState,
};
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::workspaces::adapters::control_plane::{
    list_analysis_signals, submit_analysis_signal_receipt, AnalysisSignalChannel,
    AnalysisSignalCondition, AnalysisSignalObservedState, AnalysisSignalReceiptRequest,
    RemoteAnalysisRun, RemoteAnalysisSignal,
};
use crate::operations::canonical_hash;
use crate::state::AppState;
use crate::store::{LocalAnalysisSignalMetricSample, LocalAnalysisSignalState};

const MAX_BASELINE_SAMPLES: usize = 1_000;

struct MetricContract {
    columns: Vec<AnalysisColumn>,
    value_column: String,
    sample_count_column: Option<String>,
}

struct MetricObservation {
    value: Option<f64>,
    sample_count: u64,
    observed: AnalysisSignalObservedState,
    local_state: LocalAnalysisSignalState,
    error_kind: Option<String>,
}

pub(crate) async fn evaluate_analysis_signals(
    app: Option<&AppHandle>,
    state: &AppState,
    account_id: &str,
    workspace_id: Uuid,
    article: &AnalysisArticleRecord,
    runner_id: Uuid,
    run: &RemoteAnalysisRun,
    fragments: &[AnalysisResultFragment],
    execution_error: Option<&AppError>,
) -> AppResult<()> {
    if article.live_revision != Some(run.article_revision)
        || article.id != run.article_id
        || !matches!(
            run.state,
            AnalysisRunState::Succeeded | AnalysisRunState::Failed | AnalysisRunState::Stale
        )
    {
        return Ok(());
    }
    let signals = list_analysis_signals(account_id, workspace_id, article.id).await?;
    for signal in signals.into_iter().filter(|signal| {
        signal.enabled
            && signal.deleted_at.is_none()
            && signal.article_revision == run.article_revision
    }) {
        if let Err(error) = evaluate_one(
            app,
            state,
            account_id,
            workspace_id,
            article,
            runner_id,
            run,
            fragments,
            execution_error,
            &signal,
        )
        .await
        {
            tracing::warn!(
                article_id = %article.id,
                signal_id = %signal.id,
                run_id = %run.id,
                error_kind = error.kind(),
                "Analysis signal evaluation deferred"
            );
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn evaluate_one(
    app: Option<&AppHandle>,
    state: &AppState,
    account_id: &str,
    workspace_id: Uuid,
    article: &AnalysisArticleRecord,
    runner_id: Uuid,
    run: &RemoteAnalysisRun,
    fragments: &[AnalysisResultFragment],
    execution_error: Option<&AppError>,
    signal: &RemoteAnalysisSignal,
) -> AppResult<()> {
    let block = article
        .definition
        .blocks
        .iter()
        .find(|block| block.id == signal.block_id)
        .ok_or_else(|| AppError::Blocked {
            reason: "Analysis signal metric block disappeared".into(),
        })?;
    let contract = metric_contract(&article.definition, block)?;
    let schema_fingerprint = canonical_hash(&serde_json::to_value(&contract.columns)?)?;
    let observed = observe_metric(
        state,
        account_id,
        workspace_id,
        run,
        fragments,
        execution_error,
        signal,
        &contract,
    )
    .await?;
    let evaluated_at = run.finished_at.unwrap_or_else(Utc::now);
    let scheduled_at = run.started_at.unwrap_or(run.created_at);
    let revision = u64::try_from(signal.revision)
        .map_err(|_| AppError::Config("Analysis signal revision exceeds local storage".into()))?;
    state
        .knowledge_store()
        .record_analysis_signal_metric_sample(
            workspace_id,
            account_id,
            signal.id,
            revision,
            scheduled_at,
            evaluated_at,
            observed.value,
            observed.sample_count,
            observed.local_state,
            &schema_fingerprint,
        )
        .await?;
    let result_hash = if matches!(
        observed.observed,
        AnalysisSignalObservedState::Normal
            | AnalysisSignalObservedState::Firing
            | AnalysisSignalObservedState::NoData
    ) {
        Some(run.result_hash.clone().ok_or_else(|| {
            AppError::Network("successful Analysis run omitted its result hash".into())
        })?)
    } else {
        None
    };
    let receipt = AnalysisSignalReceiptRequest {
        id: Uuid::new_v4(),
        signal_revision: signal.revision,
        run_id: run.id,
        observed_state: observed.observed,
        result_hash,
        schema_fingerprint,
        dedupe_key: format!(
            "analysis-signal:{}:{}:{}",
            signal.id, signal.revision, run.id
        ),
        error_kind: observed.error_kind,
        evaluated_at,
    };
    let remote = submit_analysis_signal_receipt(
        account_id,
        workspace_id,
        article.id,
        signal.id,
        runner_id,
        &receipt,
    )
    .await?;
    if remote.notification_count > 0
        && signal
            .definition
            .channels
            .contains(&AnalysisSignalChannel::Desktop)
    {
        if let Some(app) = app {
            let _ = app
                .notification()
                .builder()
                .title(format!("DopeDB · {}", remote.state.replace('_', " ")))
                .body(format!(
                    "{} · Open the Article Signals tab for exact run evidence.",
                    block.title
                ))
                .show();
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn observe_metric(
    state: &AppState,
    account_id: &str,
    workspace_id: Uuid,
    run: &RemoteAnalysisRun,
    fragments: &[AnalysisResultFragment],
    execution_error: Option<&AppError>,
    signal: &RemoteAnalysisSignal,
    contract: &MetricContract,
) -> AppResult<MetricObservation> {
    if run.state != AnalysisRunState::Succeeded {
        let stale = execution_error
            .is_some_and(|error| matches!(error, AppError::Blocked { .. } | AppError::NotFound(_)))
            || run.state == AnalysisRunState::Stale;
        return Ok(MetricObservation {
            value: None,
            sample_count: 0,
            observed: if stale {
                AnalysisSignalObservedState::Stale
            } else {
                AnalysisSignalObservedState::Error
            },
            local_state: if stale {
                LocalAnalysisSignalState::Stale
            } else {
                LocalAnalysisSignalState::Error
            },
            error_kind: (!stale).then(|| {
                execution_error
                    .map(AppError::kind)
                    .unwrap_or("analysis_run_failed")
                    .chars()
                    .take(128)
                    .collect()
            }),
        });
    }
    let mut matching = fragments
        .iter()
        .filter(|fragment| fragment.block_id == signal.block_id)
        .collect::<Vec<_>>();
    matching.sort_by_key(|fragment| fragment.ordinal);
    let first = matching
        .first()
        .ok_or_else(|| AppError::Network("Analysis signal run omitted its metric block".into()))?;
    if first.columns != contract.columns
        || matching.iter().any(|fragment| {
            fragment.columns != contract.columns
                || fragment
                    .rows
                    .iter()
                    .any(|row| row.len() != contract.columns.len())
        })
    {
        return Err(AppError::Blocked {
            reason: "Analysis signal metric schema changed".into(),
        });
    }
    let rows = matching
        .iter()
        .flat_map(|fragment| fragment.rows.iter())
        .collect::<Vec<_>>();
    let value_index = contract
        .columns
        .iter()
        .position(|column| column.name == contract.value_column)
        .ok_or_else(|| AppError::Config("Analysis signal value column is unavailable".into()))?;
    let value = rows
        .first()
        .and_then(|row| row.get(value_index))
        .and_then(json_f64);
    let sample_count = contract
        .sample_count_column
        .as_ref()
        .and_then(|name| {
            contract
                .columns
                .iter()
                .position(|column| column.name == *name)
        })
        .and_then(|index| rows.first().and_then(|row| row.get(index)))
        .and_then(json_u64)
        .unwrap_or_else(|| u64::try_from(rows.len()).unwrap_or(u64::MAX));
    let missing = value.is_none() || sample_count < signal.definition.minimum_sample_count;
    if missing {
        return Ok(MetricObservation {
            value,
            sample_count,
            observed: AnalysisSignalObservedState::NoData,
            local_state: LocalAnalysisSignalState::NoData,
            error_kind: None,
        });
    }
    let value = value.expect("validated finite metric");
    let recent = state
        .knowledge_store()
        .recent_analysis_signal_metric_samples(
            workspace_id,
            account_id,
            signal.id,
            u64::try_from(signal.revision).map_err(|_| {
                AppError::Config("Analysis signal revision exceeds local storage".into())
            })?,
            MAX_BASELINE_SAMPLES,
        )
        .await?;
    let firing = match signal.definition.condition {
        AnalysisSignalCondition::ThresholdAbove { value: threshold } => value > threshold,
        AnalysisSignalCondition::ThresholdBelow { value: threshold } => value < threshold,
        AnalysisSignalCondition::AbsoluteChange { value: threshold } => {
            let Some(baseline) = baseline_mean(
                &recent,
                signal.definition.baseline_window_seconds,
                run.started_at.unwrap_or(run.created_at),
            ) else {
                return Ok(no_baseline(value, sample_count));
            };
            (value - baseline).abs() >= threshold
        }
        AnalysisSignalCondition::PercentageChange { percentage } => {
            let Some(baseline) = baseline_mean(
                &recent,
                signal.definition.baseline_window_seconds,
                run.started_at.unwrap_or(run.created_at),
            ) else {
                return Ok(no_baseline(value, sample_count));
            };
            if baseline == 0.0 {
                return Ok(no_baseline(value, sample_count));
            }
            ((value - baseline).abs() / baseline.abs()) * 100.0 >= percentage
        }
        AnalysisSignalCondition::MissingData { .. }
        | AnalysisSignalCondition::ConsecutiveFailure { .. } => false,
    };
    Ok(MetricObservation {
        value: Some(value),
        sample_count,
        observed: if firing {
            AnalysisSignalObservedState::Firing
        } else {
            AnalysisSignalObservedState::Normal
        },
        local_state: if firing {
            LocalAnalysisSignalState::Firing
        } else {
            LocalAnalysisSignalState::Normal
        },
        error_kind: None,
    })
}

fn metric_contract(
    definition: &AnalysisArticleDefinition,
    block: &AnalysisBlock,
) -> AppResult<MetricContract> {
    if block.kind != dopedb_protocol::AnalysisBlockKind::Metric {
        return Err(AppError::Config(
            "Analysis signal must target a metric block".into(),
        ));
    }
    let metric_id = block
        .config
        .get("metricId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("Analysis signal metric id is invalid".into()))?;
    let metric = definition
        .metrics
        .iter()
        .find(|metric| metric.id == metric_id)
        .ok_or_else(|| AppError::Config("Analysis signal metric disappeared".into()))?;
    if block.source_node_id.as_deref() != Some(metric.source_node_id.as_str()) {
        return Err(AppError::Blocked {
            reason: "Analysis signal metric source changed".into(),
        });
    }
    let node_columns = definition
        .queries
        .iter()
        .find(|node| node.id == metric.source_node_id)
        .map(|node| node.columns.as_slice())
        .or_else(|| {
            definition
                .transforms
                .iter()
                .find(|node| node.id == metric.source_node_id)
                .map(|node| node.columns.as_slice())
        })
        .ok_or_else(|| AppError::Blocked {
            reason: "Analysis signal metric node changed".into(),
        })?;
    let sample_count_column = optional_config_string(&block.config, "sampleCountColumn")?;
    let comparison_column = optional_config_string(&block.config, "comparisonColumn")?;
    let sparkline_column = optional_config_string(&block.config, "sparklineColumn")?;
    let names = [
        Some(metric.value_column.as_str()),
        comparison_column.as_deref(),
        sparkline_column.as_deref(),
        sample_count_column.as_deref(),
    ];
    let mut columns = Vec::new();
    for name in names.into_iter().flatten() {
        if columns
            .iter()
            .any(|column: &AnalysisColumn| column.name == name)
        {
            continue;
        }
        let column = node_columns
            .iter()
            .find(|column| column.name == name)
            .cloned()
            .ok_or_else(|| AppError::Blocked {
                reason: "Analysis signal metric column changed".into(),
            })?;
        columns.push(column);
    }
    let value_column = columns
        .iter()
        .find(|column| column.name == metric.value_column)
        .ok_or_else(|| AppError::Config("Analysis signal value column is unavailable".into()))?;
    if !matches!(
        value_column.column_type,
        AnalysisColumnType::Number
            | AnalysisColumnType::Duration
            | AnalysisColumnType::Currency
            | AnalysisColumnType::Percent
    ) || value_column.masking != AnalysisColumnMasking::None
        || !matches!(
            value_column.sensitivity,
            AnalysisColumnSensitivity::Public | AnalysisColumnSensitivity::Internal
        )
    {
        return Err(AppError::Blocked {
            reason: "Analysis signals require an unmasked public or internal numeric metric".into(),
        });
    }
    if let Some(name) = sample_count_column.as_deref() {
        let sample = columns
            .iter()
            .find(|column| column.name == name)
            .ok_or_else(|| {
                AppError::Config("Analysis signal sample count is unavailable".into())
            })?;
        if sample.column_type != AnalysisColumnType::Number
            || sample.masking != AnalysisColumnMasking::None
            || !matches!(
                sample.sensitivity,
                AnalysisColumnSensitivity::Public | AnalysisColumnSensitivity::Internal
            )
        {
            return Err(AppError::Blocked {
                reason: "Analysis signal sample count must be an unmasked numeric column".into(),
            });
        }
    }
    Ok(MetricContract {
        columns,
        value_column: metric.value_column.clone(),
        sample_count_column,
    })
}

fn optional_config_string(config: &Value, key: &str) -> AppResult<Option<String>> {
    match config.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(Value::Null) => Ok(None),
        _ => Err(AppError::Config(format!(
            "Analysis metric block has invalid {key}"
        ))),
    }
}

fn baseline_mean(
    recent: &[LocalAnalysisSignalMetricSample],
    window_seconds: Option<u64>,
    now: DateTime<Utc>,
) -> Option<f64> {
    let window = i64::try_from(window_seconds?).ok()?;
    let after = now - Duration::seconds(window);
    let values = recent
        .iter()
        .filter(|sample| sample.evaluated_at >= after)
        .filter(|sample| {
            sample.sample_count > 0
                && matches!(
                    sample.observed_state,
                    LocalAnalysisSignalState::Normal | LocalAnalysisSignalState::Firing
                )
        })
        .filter_map(|sample| sample.metric_value)
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn no_baseline(value: f64, sample_count: u64) -> MetricObservation {
    MetricObservation {
        value: Some(value),
        sample_count,
        observed: AnalysisSignalObservedState::NoData,
        local_state: LocalAnalysisSignalState::NoData,
        error_kind: None,
    }
}

fn json_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.parse::<f64>().ok()))
        .filter(|value| value.is_finite())
}

fn json_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
        .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()))
}
