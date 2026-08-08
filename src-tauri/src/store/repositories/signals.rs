//! Local-only Signal runner state. Metric values never enter a sync outbox.

use super::super::*;

#[derive(Debug, Clone)]
pub(crate) struct LocalSignalMetricSample {
    pub(crate) metric_value: Option<f64>,
    pub(crate) sample_count: u64,
    pub(crate) evaluated_at: DateTime<Utc>,
    pub(crate) observed_state: dopedb_protocol::SignalEvaluationState,
}

impl Store {
    pub(crate) async fn signal_runner_background_allowed(&self) -> AppResult<bool> {
        let value: Option<String> = sqlx::query_scalar(
            "SELECT value FROM app_settings WHERE key = 'signal_runner_background_allowed'",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(value.as_deref() == Some("1"))
    }

    pub(crate) async fn set_signal_runner_background_allowed(
        &self,
        allowed: bool,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO app_settings (key, value)
             VALUES ('signal_runner_background_allowed', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(if allowed { "1" } else { "0" })
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub(crate) async fn signal_runner_device_id(&self) -> AppResult<Uuid> {
        let generated = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO app_settings (key, value)
             VALUES ('signal_runner_device_id', ?1)
             ON CONFLICT(key) DO NOTHING",
        )
        .bind(generated.to_string())
        .execute(&self.pool)
        .await?;
        let value: String = sqlx::query_scalar(
            "SELECT value FROM app_settings WHERE key = 'signal_runner_device_id'",
        )
        .fetch_one(&self.pool)
        .await?;
        Uuid::parse_str(&value)
            .map_err(|_| AppError::Config("stored Signal runner id is invalid".into()))
    }

    pub(crate) async fn recent_signal_metric_samples(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        rule_id: Uuid,
        rule_revision: u64,
        limit: usize,
    ) -> AppResult<Vec<LocalSignalMetricSample>> {
        let limit = limit.clamp(1, 1_000) as i64;
        let rows = sqlx::query(
            "SELECT metric_value, sample_count, evaluated_at, observed_state
             FROM signal_metric_samples
             WHERE workspace_id = ?1 AND account_user_id = ?2
               AND rule_id = ?3 AND rule_revision = ?4
             ORDER BY evaluated_at DESC
             LIMIT ?5",
        )
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .bind(rule_id.to_string())
        .bind(i64::try_from(rule_revision).map_err(|_| {
            AppError::Config("Signal rule revision exceeds local storage range".into())
        })?)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let evaluated_at: String = row.try_get("evaluated_at")?;
                let sample_count: i64 = row.try_get("sample_count")?;
                Ok(LocalSignalMetricSample {
                    metric_value: row.try_get("metric_value")?,
                    sample_count: u64::try_from(sample_count).map_err(|_| {
                        AppError::Config("stored Signal sample count is invalid".into())
                    })?,
                    evaluated_at: DateTime::parse_from_rfc3339(&evaluated_at)
                        .map_err(|_| {
                            AppError::Config("stored Signal sample timestamp is invalid".into())
                        })?
                        .with_timezone(&Utc),
                    observed_state: match row.try_get::<&str, _>("observed_state")? {
                        "normal" => dopedb_protocol::SignalEvaluationState::Normal,
                        "firing" => dopedb_protocol::SignalEvaluationState::Firing,
                        "no_data" => dopedb_protocol::SignalEvaluationState::NoData,
                        "error" => dopedb_protocol::SignalEvaluationState::Error,
                        "stale" => dopedb_protocol::SignalEvaluationState::Stale,
                        _ => {
                            return Err(AppError::Config(
                                "stored Signal sample state is invalid".into(),
                            ))
                        }
                    },
                })
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn record_signal_metric_sample(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        rule_id: Uuid,
        rule_revision: u64,
        scheduled_at: DateTime<Utc>,
        evaluated_at: DateTime<Utc>,
        metric_value: Option<f64>,
        sample_count: u64,
        observed_state: dopedb_protocol::SignalEvaluationState,
        schema_fingerprint: &str,
    ) -> AppResult<()> {
        if metric_value.is_some_and(|value| !value.is_finite())
            || schema_fingerprint.len() != 64
            || !schema_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(AppError::Config("Signal metric sample is invalid".into()));
        }
        sqlx::query(
            "INSERT INTO signal_metric_samples
               (workspace_id, account_user_id, rule_id, rule_revision, scheduled_at,
                evaluated_at, metric_value, sample_count, observed_state, schema_fingerprint)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(workspace_id, account_user_id, rule_id, rule_revision, scheduled_at)
             DO NOTHING",
        )
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .bind(rule_id.to_string())
        .bind(i64::try_from(rule_revision).map_err(|_| {
            AppError::Config("Signal rule revision exceeds local storage range".into())
        })?)
        .bind(scheduled_at.to_rfc3339())
        .bind(evaluated_at.to_rfc3339())
        .bind(metric_value)
        .bind(i64::try_from(sample_count).map_err(|_| {
            AppError::Config("Signal sample count exceeds local storage range".into())
        })?)
        .bind(match observed_state {
            dopedb_protocol::SignalEvaluationState::Normal => "normal",
            dopedb_protocol::SignalEvaluationState::Firing => "firing",
            dopedb_protocol::SignalEvaluationState::NoData => "no_data",
            dopedb_protocol::SignalEvaluationState::Error => "error",
            dopedb_protocol::SignalEvaluationState::Stale => "stale",
            dopedb_protocol::SignalEvaluationState::Recovered
            | dopedb_protocol::SignalEvaluationState::RunnerOffline => {
                return Err(AppError::Config(
                    "derived Signal state cannot be stored as an observation".into(),
                ))
            }
        })
        .bind(schema_fingerprint)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
