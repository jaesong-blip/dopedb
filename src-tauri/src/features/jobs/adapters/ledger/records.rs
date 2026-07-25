use chrono::Utc;
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::features::jobs::{Job, JobArtifact};
use crate::kernel::identity::JobId;
use crate::operations::canonical_hash;

use super::super::super::ports::{JobAuthority, JobRecord, NewJob};
use super::events::append_event;
use super::mapping::{row_to_artifact, row_to_job, row_to_record};
use super::JobRepository;

pub(super) async fn insert_job(
    repository: &JobRepository,
    authority: &JobAuthority,
    new: NewJob,
) -> AppResult<JobRecord> {
    let plan_value = serde_json::to_value(&new.plan)?;
    let plan_json = serde_json::to_string(&plan_value)?;
    let plan_hash = canonical_hash(&plan_value)?;
    let now = Utc::now().to_rfc3339();
    let mut transaction = repository.store.pool().begin().await?;
    sqlx::query(
        "INSERT INTO jobs
            (id, operation_id, workspace_id, account_scope, connection_id, kind,
             format, plan_json, plan_hash, state, source_summary, target_summary,
             rows_processed, bytes_processed, rows_total, bytes_total, resumable,
             error_code, redacted_error, created_at, started_at, finished_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'queued',?10,?11,0,0,?12,?13,?14,
                 NULL,NULL,?15,NULL,NULL,?15)",
    )
    .bind(new.id.to_string())
    .bind(new.operation_id.to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(new.connection_id.to_string())
    .bind(new.kind.storage_key())
    .bind(new.format.storage_key())
    .bind(&plan_json)
    .bind(&plan_hash)
    .bind(&new.source_summary)
    .bind(&new.target_summary)
    .bind(new.rows_total.and_then(|value| i64::try_from(value).ok()))
    .bind(new.bytes_total.and_then(|value| i64::try_from(value).ok()))
    .bind(i64::from(new.resumable))
    .bind(&now)
    .execute(&mut *transaction)
    .await?;
    let claimed = sqlx::query(
        "UPDATE job_file_capabilities
         SET claimed_by_job_id = ?1
         WHERE id = ?2 AND workspace_id = ?3 AND account_scope = ?4
           AND connection_id = ?5 AND claimed_by_job_id IS NULL
           AND revoked_at IS NULL AND expires_at > ?6",
    )
    .bind(new.id.to_string())
    .bind(new.plan.capability_id().to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(new.connection_id.to_string())
    .bind(&now)
    .execute(&mut *transaction)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(AppError::Blocked {
            reason: "the selected file permission is expired or already in use".into(),
        });
    }
    append_event(
        &mut transaction,
        new.id,
        "queued",
        &json!({"planHash": plan_hash}),
    )
    .await?;
    transaction.commit().await?;
    get_unscoped(repository, new.id).await
}

pub(super) async fn list(
    repository: &JobRepository,
    authority: &JobAuthority,
) -> AppResult<Vec<Job>> {
    let rows = sqlx::query(
        "SELECT * FROM jobs
         WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3
         ORDER BY created_at DESC, id DESC",
    )
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(authority.resource.connection_id.to_string())
    .fetch_all(repository.store.pool())
    .await?;
    rows.iter().map(row_to_job).collect()
}

pub(super) async fn detail(
    repository: &JobRepository,
    authority: &JobAuthority,
    job_id: JobId,
) -> AppResult<(Job, Vec<JobArtifact>)> {
    let record = get_scoped(repository, authority, job_id).await?;
    let rows = sqlx::query(
        "SELECT id, job_id, artifact_type, local_path, size_bytes, sha256, created_at
         FROM job_artifacts WHERE job_id = ?1 ORDER BY created_at ASC, id ASC",
    )
    .bind(job_id.to_string())
    .fetch_all(repository.store.pool())
    .await?;
    let artifacts = rows
        .iter()
        .map(row_to_artifact)
        .collect::<AppResult<Vec<_>>>()?;
    Ok((record.job, artifacts))
}

pub(super) async fn get_scoped(
    repository: &JobRepository,
    authority: &JobAuthority,
    job_id: JobId,
) -> AppResult<JobRecord> {
    let row = sqlx::query(
        "SELECT * FROM jobs
         WHERE id = ?1 AND workspace_id = ?2 AND account_scope = ?3
           AND connection_id = ?4",
    )
    .bind(job_id.to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(authority.resource.connection_id.to_string())
    .fetch_optional(repository.store.pool())
    .await?
    .ok_or_else(|| AppError::NotFound(format!("job {job_id}")))?;
    row_to_record(&row)
}

pub(super) async fn get_unscoped(
    repository: &JobRepository,
    job_id: JobId,
) -> AppResult<JobRecord> {
    let row = sqlx::query("SELECT * FROM jobs WHERE id = ?1")
        .bind(job_id.to_string())
        .fetch_optional(repository.store.pool())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("job {job_id}")))?;
    row_to_record(&row)
}

pub(super) async fn queued_records(repository: &JobRepository) -> AppResult<Vec<JobRecord>> {
    let rows = sqlx::query("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC")
        .fetch_all(repository.store.pool())
        .await?;
    rows.iter().map(row_to_record).collect()
}

pub(super) async fn paused_records(repository: &JobRepository) -> AppResult<Vec<JobRecord>> {
    let rows = sqlx::query("SELECT * FROM jobs WHERE state = 'paused' ORDER BY created_at ASC")
        .fetch_all(repository.store.pool())
        .await?;
    rows.iter().map(row_to_record).collect()
}
