use std::path::Path;

use sqlx::Row;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::jobs::{Job, JobArtifact, JobFormat, JobKind, JobPlan, JobState};
use crate::kernel::identity::{
    AccountScopeId, ConnectionId, JobArtifactId, JobId, OperationId, WorkspaceId,
};
use crate::operations::canonical_hash;

use super::super::super::ports::JobRecord;

pub(super) fn row_to_record(row: &sqlx::sqlite::SqliteRow) -> AppResult<JobRecord> {
    let workspace_id = WorkspaceId::from(parse_uuid(
        &row.try_get::<String, _>("workspace_id")?,
        "job workspace",
    )?);
    let plan_json: String = row.try_get("plan_json")?;
    let plan: JobPlan = serde_json::from_str(&plan_json)?;
    let plan_hash: String = row.try_get("plan_hash")?;
    if canonical_hash(&serde_json::to_value(&plan)?)? != plan_hash {
        return Err(AppError::Blocked {
            reason: "stored job plan hash does not match its canonical payload".into(),
        });
    }
    let account_scope = AccountScopeId::new(row.try_get::<String, _>("account_scope")?)
        .ok_or_else(|| AppError::Config("stored job account scope is invalid".into()))?;
    Ok(JobRecord {
        job: row_to_job(row)?,
        workspace_id,
        account_scope,
        plan,
        plan_hash,
    })
}

pub(super) fn row_to_job(row: &sqlx::sqlite::SqliteRow) -> AppResult<Job> {
    let stored_state = row.try_get::<String, _>("state")?;
    let pause_requested = row.try_get::<i64, _>("pause_requested")? != 0;
    let state = if stored_state == "running" && pause_requested {
        JobState::PauseRequested
    } else {
        JobState::parse(&stored_state)
            .ok_or_else(|| AppError::Config("stored job state is invalid".into()))?
    };
    Ok(Job {
        id: JobId::from(parse_uuid(&row.try_get::<String, _>("id")?, "job")?),
        operation_id: OperationId::from(parse_uuid(
            &row.try_get::<String, _>("operation_id")?,
            "job operation",
        )?),
        connection_id: ConnectionId::from(parse_uuid(
            &row.try_get::<String, _>("connection_id")?,
            "job connection",
        )?),
        kind: JobKind::parse(&row.try_get::<String, _>("kind")?)
            .ok_or_else(|| AppError::Config("stored job kind is invalid".into()))?,
        format: JobFormat::parse(&row.try_get::<String, _>("format")?)
            .ok_or_else(|| AppError::Config("stored job format is invalid".into()))?,
        state,
        source_summary: row.try_get("source_summary")?,
        target_summary: row.try_get("target_summary")?,
        rows_processed: required_u64(row.try_get("rows_processed")?)?,
        bytes_processed: required_u64(row.try_get("bytes_processed")?)?,
        rows_total: optional_u64(row.try_get("rows_total")?)?,
        bytes_total: optional_u64(row.try_get("bytes_total")?)?,
        resumable: row.try_get::<i64, _>("resumable")? != 0,
        error_code: row.try_get("error_code")?,
        redacted_error: row.try_get("redacted_error")?,
        created_at: row.try_get("created_at")?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub(super) fn row_to_artifact(row: &sqlx::sqlite::SqliteRow) -> AppResult<JobArtifact> {
    let local_path: String = row.try_get("local_path")?;
    Ok(JobArtifact {
        id: JobArtifactId::from(parse_uuid(
            &row.try_get::<String, _>("id")?,
            "job artifact",
        )?),
        job_id: JobId::from(parse_uuid(
            &row.try_get::<String, _>("job_id")?,
            "job artifact owner",
        )?),
        artifact_type: row.try_get("artifact_type")?,
        display_name: Path::new(&local_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("artifact")
            .to_owned(),
        size_bytes: required_u64(row.try_get("size_bytes")?)?,
        sha256: row.try_get("sha256")?,
        created_at: row.try_get("created_at")?,
    })
}

pub(super) fn parse_uuid(value: &str, label: &str) -> AppResult<Uuid> {
    Uuid::parse_str(value).map_err(|_| AppError::Config(format!("stored {label} id is invalid")))
}

fn required_u64(value: i64) -> AppResult<u64> {
    u64::try_from(value).map_err(|_| AppError::Config("stored job counter is invalid".into()))
}

pub(super) fn optional_u64(value: Option<i64>) -> AppResult<Option<u64>> {
    value.map(required_u64).transpose()
}
