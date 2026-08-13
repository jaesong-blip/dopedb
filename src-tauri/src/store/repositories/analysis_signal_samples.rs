//! Device-local samples used to evaluate live Analysis Article signals.
//!
//! Metric values never enter workspace synchronization. Hosted receipts contain
//! only categorical state, hashes, and immutable run identities.

use super::super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalAnalysisSignalState {
    Normal,
    Firing,
    NoData,
    Error,
    Stale,
}

impl LocalAnalysisSignalState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Firing => "firing",
            Self::NoData => "no_data",
            Self::Error => "error",
            Self::Stale => "stale",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "normal" => Ok(Self::Normal),
            "firing" => Ok(Self::Firing),
            "no_data" => Ok(Self::NoData),
            "error" => Ok(Self::Error),
            "stale" => Ok(Self::Stale),
            _ => Err(AppError::Config(
                "stored Analysis signal sample state is invalid".into(),
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LocalAnalysisSignalMetricSample {
    pub(crate) metric_value: Option<f64>,
    pub(crate) sample_count: u64,
    pub(crate) evaluated_at: DateTime<Utc>,
    pub(crate) observed_state: LocalAnalysisSignalState,
}

impl Store {
    pub(crate) async fn automation_runner_background_allowed(&self) -> AppResult<bool> {
        let value: Option<String> = sqlx::query_scalar(
            "SELECT value FROM app_settings
             WHERE key = 'analysis_runner_background_allowed'",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(value.as_deref() == Some("1"))
    }

    pub(crate) async fn set_automation_runner_background_allowed(
        &self,
        allowed: bool,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO app_settings (key, value)
             VALUES ('analysis_runner_background_allowed', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(if allowed { "1" } else { "0" })
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    fn automation_runner_device_key(
        account_user_id: &str,
        workspace_id: Uuid,
    ) -> AppResult<String> {
        let account_user_id = Uuid::parse_str(account_user_id)
            .map_err(|_| AppError::Config("workspace account id is invalid".into()))?;
        Ok(format!(
            "analysis_runner_capability_device_id_v1:{account_user_id}:{workspace_id}"
        ))
    }

    pub(crate) async fn automation_runner_device_id(
        &self,
        account_user_id: &str,
        workspace_id: Uuid,
    ) -> AppResult<Uuid> {
        let key = Self::automation_runner_device_key(account_user_id, workspace_id)?;
        let generated = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO app_settings (key, value)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO NOTHING",
        )
        .bind(&key)
        .bind(generated.to_string())
        .execute(&self.pool)
        .await?;
        let value: String = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?1")
            .bind(key)
            .fetch_one(&self.pool)
            .await?;
        Uuid::parse_str(&value)
            .map_err(|_| AppError::Config("stored Analysis runner id is invalid".into()))
    }

    pub(crate) async fn replace_automation_runner_device_id(
        &self,
        account_user_id: &str,
        workspace_id: Uuid,
    ) -> AppResult<Uuid> {
        let key = Self::automation_runner_device_key(account_user_id, workspace_id)?;
        let device_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO app_settings (key, value)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(device_id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(device_id)
    }

    pub(crate) async fn recent_analysis_signal_metric_samples(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        signal_id: Uuid,
        signal_revision: u64,
        limit: usize,
    ) -> AppResult<Vec<LocalAnalysisSignalMetricSample>> {
        let limit = limit.clamp(1, 1_000) as i64;
        let revision = i64::try_from(signal_revision).map_err(|_| {
            AppError::Config("Analysis signal revision exceeds local storage range".into())
        })?;
        let rows = sqlx::query(
            "SELECT metric_value, sample_count, evaluated_at, observed_state
             FROM analysis_signal_metric_samples
             WHERE workspace_id = ?1 AND account_user_id = ?2
               AND signal_id = ?3 AND signal_revision = ?4
             ORDER BY evaluated_at DESC
             LIMIT ?5",
        )
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .bind(signal_id.to_string())
        .bind(revision)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let evaluated_at: String = row.try_get("evaluated_at")?;
                let sample_count: i64 = row.try_get("sample_count")?;
                Ok(LocalAnalysisSignalMetricSample {
                    metric_value: row.try_get("metric_value")?,
                    sample_count: u64::try_from(sample_count).map_err(|_| {
                        AppError::Config("stored Analysis signal sample count is invalid".into())
                    })?,
                    evaluated_at: DateTime::parse_from_rfc3339(&evaluated_at)
                        .map_err(|_| {
                            AppError::Config(
                                "stored Analysis signal sample timestamp is invalid".into(),
                            )
                        })?
                        .with_timezone(&Utc),
                    observed_state: LocalAnalysisSignalState::parse(
                        row.try_get::<&str, _>("observed_state")?,
                    )?,
                })
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn record_analysis_signal_metric_sample(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        signal_id: Uuid,
        signal_revision: u64,
        scheduled_at: DateTime<Utc>,
        evaluated_at: DateTime<Utc>,
        metric_value: Option<f64>,
        sample_count: u64,
        observed_state: LocalAnalysisSignalState,
        schema_fingerprint: &str,
    ) -> AppResult<()> {
        if metric_value.is_some_and(|value| !value.is_finite())
            || schema_fingerprint.len() != 64
            || !schema_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(AppError::Config(
                "Analysis signal metric sample is invalid".into(),
            ));
        }
        let revision = i64::try_from(signal_revision).map_err(|_| {
            AppError::Config("Analysis signal revision exceeds local storage range".into())
        })?;
        let sample_count = i64::try_from(sample_count).map_err(|_| {
            AppError::Config("Analysis signal sample count exceeds local storage range".into())
        })?;
        sqlx::query(
            "INSERT INTO analysis_signal_metric_samples
               (workspace_id, account_user_id, signal_id, signal_revision, scheduled_at,
                evaluated_at, metric_value, sample_count, observed_state, schema_fingerprint)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(
               workspace_id, account_user_id, signal_id, signal_revision, scheduled_at
             ) DO NOTHING",
        )
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .bind(signal_id.to_string())
        .bind(revision)
        .bind(scheduled_at.to_rfc3339())
        .bind(evaluated_at.to_rfc3339())
        .bind(metric_value)
        .bind(sample_count)
        .bind(observed_state.as_str())
        .bind(schema_fingerprint)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
