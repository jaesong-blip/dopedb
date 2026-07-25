use chrono::Utc;
use serde_json::json;
use sqlx::{AssertSqlSafe, Row};

use crate::error::{AppError, AppResult};
use crate::features::jobs::{valid_sha256_fingerprint, JobState, JobTransition};
use crate::kernel::identity::JobId;

use super::super::super::ports::{Checkpoint, JobAuthority, JobRecord};
use super::events::append_event;
use super::records::{get_scoped, get_unscoped};
use super::JobRepository;

pub(super) async fn claim_running(
    repository: &JobRepository,
    authority: &JobAuthority,
    job_id: JobId,
) -> AppResult<JobRecord> {
    let now = Utc::now().to_rfc3339();
    let mut transaction = repository.store.pool().begin().await?;
    let previous = sqlx::query_scalar::<_, String>(
        "SELECT state FROM jobs
         WHERE id = ?1 AND workspace_id = ?2 AND account_scope = ?3
           AND connection_id = ?4",
    )
    .bind(job_id.to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(authority.resource.connection_id.to_string())
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("job {job_id}")))?;
    if !matches!(previous.as_str(), "queued" | "paused") {
        return Err(AppError::Blocked {
            reason: "job is not queued or paused".into(),
        });
    }
    let update = sqlx::query(
        "UPDATE jobs
         SET state = 'running', started_at = COALESCE(started_at, ?1),
             finished_at = NULL, error_code = NULL, redacted_error = NULL,
             pause_requested = 0, updated_at = ?1
         WHERE id = ?2 AND workspace_id = ?3 AND account_scope = ?4
           AND connection_id = ?5 AND state = ?6",
    )
    .bind(&now)
    .bind(job_id.to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(authority.resource.connection_id.to_string())
    .bind(&previous)
    .execute(&mut *transaction)
    .await?;
    if update.rows_affected() != 1 {
        return Err(AppError::Blocked {
            reason: "job state changed before it could start".into(),
        });
    }
    let event = if previous == "paused" {
        "resumed"
    } else {
        "started"
    };
    append_event(&mut transaction, job_id, event, &json!({})).await?;
    transaction.commit().await?;
    get_scoped(repository, authority, job_id).await
}

pub(super) async fn update_progress(
    repository: &JobRepository,
    job_id: JobId,
    rows_processed: u64,
    bytes_processed: u64,
    checkpoint: Option<Checkpoint>,
) -> AppResult<JobRecord> {
    if checkpoint.as_ref().is_some_and(|checkpoint| {
        !valid_sha256_fingerprint(&checkpoint.source_fingerprint)
            || !valid_sha256_fingerprint(&checkpoint.target_fingerprint)
    }) {
        return Err(AppError::Config(
            "job checkpoint fingerprints must be lowercase SHA-256".into(),
        ));
    }
    let mut transaction = repository.store.pool().begin().await?;
    let now = Utc::now().to_rfc3339();
    let update = sqlx::query(
        "UPDATE jobs SET rows_processed = ?1, bytes_processed = ?2, updated_at = ?3
         WHERE id = ?4 AND state IN ('running', 'cancel_requested')
           AND rows_processed <= ?1 AND bytes_processed <= ?2",
    )
    .bind(i64::try_from(rows_processed).unwrap_or(i64::MAX))
    .bind(i64::try_from(bytes_processed).unwrap_or(i64::MAX))
    .bind(&now)
    .bind(job_id.to_string())
    .execute(&mut *transaction)
    .await?;
    if update.rows_affected() != 1 {
        return Err(AppError::Blocked {
            reason: "job stopped while progress was being recorded".into(),
        });
    }
    if let Some(checkpoint) = checkpoint {
        let sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM job_checkpoints WHERE job_id = ?1",
        )
        .bind(job_id.to_string())
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO job_checkpoints
                (job_id, sequence, source_fingerprint, target_fingerprint,
                 checkpoint_json, created_at)
             VALUES (?1,?2,?3,?4,?5,?6)",
        )
        .bind(job_id.to_string())
        .bind(sequence)
        .bind(checkpoint.source_fingerprint)
        .bind(checkpoint.target_fingerprint)
        .bind(serde_json::to_string(&checkpoint.value)?)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
    }
    append_event(
        &mut transaction,
        job_id,
        "progress",
        &json!({
            "bytesProcessed": bytes_processed,
            "rowsProcessed": rows_processed,
        }),
    )
    .await?;
    transaction.commit().await?;
    get_unscoped(repository, job_id).await
}

pub(super) async fn update_totals(
    repository: &JobRepository,
    job_id: JobId,
    rows_total: Option<u64>,
    bytes_total: Option<u64>,
) -> AppResult<JobRecord> {
    let update = sqlx::query(
        "UPDATE jobs SET rows_total = ?1, bytes_total = ?2, updated_at = ?3
         WHERE id = ?4 AND state = 'running'",
    )
    .bind(rows_total.and_then(|value| i64::try_from(value).ok()))
    .bind(bytes_total.and_then(|value| i64::try_from(value).ok()))
    .bind(Utc::now().to_rfc3339())
    .bind(job_id.to_string())
    .execute(repository.store.pool())
    .await?;
    if update.rows_affected() != 1 {
        return Err(AppError::Blocked {
            reason: "job stopped while totals were being recorded".into(),
        });
    }
    get_unscoped(repository, job_id).await
}

pub(super) async fn latest_checkpoint(
    repository: &JobRepository,
    job_id: JobId,
) -> AppResult<Option<Checkpoint>> {
    let row = sqlx::query(
        "SELECT source_fingerprint, target_fingerprint, checkpoint_json
         FROM job_checkpoints WHERE job_id = ?1 ORDER BY sequence DESC LIMIT 1",
    )
    .bind(job_id.to_string())
    .fetch_optional(repository.store.pool())
    .await?;
    row.map(|row| {
        Ok(Checkpoint {
            source_fingerprint: row.try_get("source_fingerprint")?,
            target_fingerprint: row.try_get("target_fingerprint")?,
            value: serde_json::from_str(&row.try_get::<String, _>("checkpoint_json")?)?,
        })
    })
    .transpose()
}

pub(super) async fn request_pause(
    repository: &JobRepository,
    job_id: JobId,
) -> AppResult<JobRecord> {
    let now = Utc::now().to_rfc3339();
    let mut transaction = repository.store.pool().begin().await?;
    let update = sqlx::query(
        "UPDATE jobs SET pause_requested = 1, updated_at = ?1
         WHERE id = ?2 AND state = 'running' AND pause_requested = 0",
    )
    .bind(&now)
    .bind(job_id.to_string())
    .execute(&mut *transaction)
    .await?;
    if update.rows_affected() != 1 {
        return Err(AppError::Blocked {
            reason: "only a running job can be paused".into(),
        });
    }
    append_event(
        &mut transaction,
        job_id,
        "warning",
        &json!({"reason": "pause_requested"}),
    )
    .await?;
    transaction.commit().await?;
    get_unscoped(repository, job_id).await
}

pub(super) async fn finish_pause(
    repository: &JobRepository,
    job_id: JobId,
) -> AppResult<JobRecord> {
    transition_job_state(
        repository,
        job_id,
        JobTransition::PauseCompleted,
        None,
        None,
    )
    .await
}

pub(super) async fn rollback_initial_start(
    repository: &JobRepository,
    job_id: JobId,
) -> AppResult<JobRecord> {
    transition_job_state(
        repository,
        job_id,
        JobTransition::InitialStartRolledBack,
        Some("operation_claim_failed"),
        Some("The exact operation could not be claimed; the job was returned to its queue."),
    )
    .await
}

pub(super) async fn request_cancel(
    repository: &JobRepository,
    job_id: JobId,
) -> AppResult<JobRecord> {
    let current = get_unscoped(repository, job_id).await?;
    if matches!(
        current.job.state,
        JobState::Running | JobState::PauseRequested
    ) {
        transition_job_state(
            repository,
            job_id,
            JobTransition::RunningCancellationRequested,
            None,
            None,
        )
        .await
    } else {
        transition_job_state(
            repository,
            job_id,
            JobTransition::WaitingCancelled,
            None,
            None,
        )
        .await
    }
}

pub(super) async fn finish(
    repository: &JobRepository,
    job_id: JobId,
    state: JobState,
    error_code: Option<&str>,
    redacted_error: Option<&str>,
) -> AppResult<JobRecord> {
    let transition = match state {
        JobState::Succeeded => JobTransition::ExecutionSucceeded,
        JobState::Cancelled => JobTransition::ExecutionCancelled,
        JobState::Failed => JobTransition::ExecutionFailed,
        _ => {
            return Err(AppError::Config(
                "job finish requires a terminal state".into(),
            ))
        }
    };
    transition_job_state(repository, job_id, transition, error_code, redacted_error).await
}

pub(super) async fn finish_queued(
    repository: &JobRepository,
    job_id: JobId,
    state: JobState,
    error_code: &str,
    redacted_error: &str,
) -> AppResult<JobRecord> {
    if !matches!(state, JobState::Cancelled | JobState::Failed) {
        return Err(AppError::Config(
            "queued reconciliation requires a cancelled or failed state".into(),
        ));
    }
    let transition = if state == JobState::Cancelled {
        JobTransition::QueuedCancelled
    } else {
        JobTransition::QueuedFailed
    };
    transition_job_state(
        repository,
        job_id,
        transition,
        Some(error_code),
        Some(redacted_error),
    )
    .await
}

pub(super) async fn fail_paused(
    repository: &JobRepository,
    job_id: JobId,
    error_code: &str,
    redacted_error: &str,
) -> AppResult<JobRecord> {
    transition_job_state(
        repository,
        job_id,
        JobTransition::PausedFailed,
        Some(error_code),
        Some(redacted_error),
    )
    .await
}

async fn transition_job_state(
    repository: &JobRepository,
    job_id: JobId,
    transition: JobTransition,
    error_code: Option<&str>,
    redacted_error: Option<&str>,
) -> AppResult<JobRecord> {
    let rule = transition.rule();
    let now = Utc::now().to_rfc3339();
    let placeholders = std::iter::repeat_n("?", rule.from.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "UPDATE jobs
         SET state = ?, error_code = ?, redacted_error = ?,
             pause_requested = 0,
             finished_at = CASE WHEN ? IN ('cancelled','succeeded','failed') THEN ? ELSE NULL END,
             updated_at = ?
         WHERE id = ? AND state IN ({placeholders})"
    );
    let mut transaction = repository.store.pool().begin().await?;
    // Only the number of `?` placeholders is dynamic; every value remains bound.
    let mut query = sqlx::query(AssertSqlSafe(sql))
        .bind(rule.to.storage_key())
        .bind(error_code)
        .bind(redacted_error)
        .bind(rule.to.storage_key())
        .bind(&now)
        .bind(&now)
        .bind(job_id.to_string());
    for state in rule.from {
        query = query.bind(state.storage_key());
    }
    let update = query.execute(&mut *transaction).await?;
    if update.rows_affected() != 1 {
        return Err(AppError::Blocked {
            reason: "job state changed before this transition".into(),
        });
    }
    append_event(
        &mut transaction,
        job_id,
        rule.event,
        &json!({"errorCode": error_code}),
    )
    .await?;
    transaction.commit().await?;
    get_unscoped(repository, job_id).await
}
