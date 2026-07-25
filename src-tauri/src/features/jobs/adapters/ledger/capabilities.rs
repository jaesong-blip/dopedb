use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use sqlx::Row;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::jobs::{JobFileCapability, JobFileDirection};
use crate::kernel::identity::{JobArtifactId, JobFileCapabilityId, JobId};

use super::super::super::ports::{JobAuthority, NewCapability, ResolvedCapability};
use super::mapping::{optional_u64, parse_uuid};
use super::JobRepository;

pub(super) async fn create_capability(
    repository: &JobRepository,
    authority: &JobAuthority,
    capability: NewCapability,
) -> AppResult<JobFileCapability> {
    let id = JobFileCapabilityId::from(Uuid::new_v4());
    let created_at = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO job_file_capabilities
            (id, workspace_id, account_scope, connection_id, direction, local_path,
             display_name, size_bytes, modified_at, source_sha256, claimed_by_job_id,
             expires_at, revoked_at, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,?11,NULL,?12)",
    )
    .bind(id.to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(capability.connection_id.to_string())
    .bind(capability.direction.storage_key())
    .bind(capability.path.to_string_lossy().into_owned())
    .bind(&capability.display_name)
    .bind(
        capability
            .size_bytes
            .and_then(|value| i64::try_from(value).ok()),
    )
    .bind(&capability.modified_at)
    .bind(&capability.source_sha256)
    .bind(capability.expires_at.to_rfc3339())
    .bind(&created_at)
    .execute(repository.store.pool())
    .await?;
    Ok(JobFileCapability {
        id,
        connection_id: capability.connection_id,
        direction: capability.direction,
        display_name: capability.display_name,
        size_bytes: capability.size_bytes,
        modified_at: capability.modified_at,
        source_sha256: capability.source_sha256,
        expires_at: capability.expires_at.to_rfc3339(),
    })
}

pub(super) async fn resolve_capability(
    repository: &JobRepository,
    authority: &JobAuthority,
    capability_id: JobFileCapabilityId,
    direction: JobFileDirection,
    job_id: Option<JobId>,
) -> AppResult<ResolvedCapability> {
    let row = sqlx::query(
        "SELECT id, local_path, display_name, size_bytes, source_sha256,
                claimed_by_job_id, expires_at
         FROM job_file_capabilities
         WHERE id = ?1 AND workspace_id = ?2 AND account_scope = ?3
           AND connection_id = ?4 AND direction = ?5 AND revoked_at IS NULL",
    )
    .bind(capability_id.to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(authority.resource.connection_id.to_string())
    .bind(direction.storage_key())
    .fetch_optional(repository.store.pool())
    .await?
    .ok_or_else(|| AppError::NotFound(format!("job file capability {capability_id}")))?;
    let expires_at = DateTime::parse_from_rfc3339(&row.try_get::<String, _>("expires_at")?)
        .map_err(|_| AppError::Config("stored job capability expiry is invalid".into()))?
        .with_timezone(&Utc);
    if expires_at <= Utc::now() {
        return Err(AppError::Blocked {
            reason: "the file permission expired; choose the file again".into(),
        });
    }
    let claimed_by: Option<String> = row.try_get("claimed_by_job_id")?;
    if let Some(claimed_by) = claimed_by {
        let claimed_by = parse_uuid(&claimed_by, "job capability owner")?;
        if job_id != Some(JobId::from(claimed_by)) {
            return Err(AppError::Blocked {
                reason: "the file permission is already bound to another job".into(),
            });
        }
    }
    let path = PathBuf::from(row.try_get::<String, _>("local_path")?);
    Ok(ResolvedCapability {
        path,
        display_name: row.try_get("display_name")?,
        size_bytes: optional_u64(row.try_get("size_bytes")?)?,
        source_sha256: row.try_get("source_sha256")?,
    })
}

pub(super) async fn retire_input_capability(
    repository: &JobRepository,
    job_id: JobId,
) -> AppResult<Option<PathBuf>> {
    let now = Utc::now().to_rfc3339();
    let mut transaction = repository.store.pool().begin().await?;
    let path = sqlx::query_scalar::<_, String>(
        "SELECT local_path FROM job_file_capabilities
         WHERE claimed_by_job_id = ?1 AND direction = 'input' AND revoked_at IS NULL",
    )
    .bind(job_id.to_string())
    .fetch_optional(&mut *transaction)
    .await?;
    if path.is_some() {
        sqlx::query(
            "UPDATE job_file_capabilities SET revoked_at = ?1
             WHERE claimed_by_job_id = ?2 AND direction = 'input' AND revoked_at IS NULL",
        )
        .bind(&now)
        .bind(job_id.to_string())
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(path.map(PathBuf::from))
}

pub(super) async fn retire_expired_input_capabilities(
    repository: &JobRepository,
) -> AppResult<Vec<PathBuf>> {
    let now = Utc::now().to_rfc3339();
    let mut transaction = repository.store.pool().begin().await?;
    let rows = sqlx::query(
        "SELECT c.id, c.local_path
         FROM job_file_capabilities c
         LEFT JOIN jobs j ON j.id = c.claimed_by_job_id
         WHERE c.direction = 'input' AND c.revoked_at IS NULL AND c.expires_at <= ?1
           AND (
             c.claimed_by_job_id IS NULL
             OR j.state IN ('cancelled', 'succeeded', 'failed')
           )",
    )
    .bind(&now)
    .fetch_all(&mut *transaction)
    .await?;
    let mut paths = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.try_get("id")?;
        let path: String = row.try_get("local_path")?;
        let update = sqlx::query(
            "UPDATE job_file_capabilities SET revoked_at = ?1
             WHERE id = ?2 AND revoked_at IS NULL",
        )
        .bind(&now)
        .bind(id)
        .execute(&mut *transaction)
        .await?;
        if update.rows_affected() == 1 {
            paths.push(PathBuf::from(path));
        }
    }
    transaction.commit().await?;
    Ok(paths)
}

pub(super) async fn active_input_capability_paths(
    repository: &JobRepository,
) -> AppResult<Vec<PathBuf>> {
    let paths = sqlx::query_scalar::<_, String>(
        "SELECT local_path FROM job_file_capabilities
         WHERE direction = 'input' AND revoked_at IS NULL",
    )
    .fetch_all(repository.store.pool())
    .await?;
    Ok(paths.into_iter().map(PathBuf::from).collect())
}

pub(super) async fn record_artifact(
    repository: &JobRepository,
    job_id: JobId,
    artifact_type: &str,
    path: &Path,
    size_bytes: u64,
    sha256: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO job_artifacts
            (id, job_id, artifact_type, local_path, size_bytes, sha256,
             retention_state, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,'retained',?7)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(job_id.to_string())
    .bind(artifact_type)
    .bind(path.to_string_lossy().into_owned())
    .bind(i64::try_from(size_bytes).unwrap_or(i64::MAX))
    .bind(sha256)
    .bind(Utc::now().to_rfc3339())
    .execute(repository.store.pool())
    .await?;
    Ok(())
}

pub(super) async fn artifact_path(
    repository: &JobRepository,
    authority: &JobAuthority,
    artifact_id: JobArtifactId,
) -> AppResult<PathBuf> {
    let path = sqlx::query_scalar::<_, String>(
        "SELECT a.local_path
         FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
         WHERE a.id = ?1 AND j.workspace_id = ?2 AND j.account_scope = ?3
           AND j.connection_id = ?4 AND a.retention_state = 'retained'",
    )
    .bind(artifact_id.to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(authority.resource.connection_id.to_string())
    .fetch_optional(repository.store.pool())
    .await?
    .ok_or_else(|| AppError::NotFound(format!("job artifact {artifact_id}")))?;
    Ok(PathBuf::from(path))
}
