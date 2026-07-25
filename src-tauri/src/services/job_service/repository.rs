//! SQLite projection and append-only ledger for durable import/export jobs.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{AssertSqlSafe, Row, Sqlite, Transaction};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::jobs::{
    valid_sha256_fingerprint, Job, JobArtifact, JobFileCapability, JobFileDirection, JobFormat,
    JobKind, JobPlan, JobState, JobTransition,
};
use crate::kernel::identity::{
    ConnectionId, JobArtifactId, JobFileCapabilityId, JobId, OperationId, WorkspaceId,
};
use crate::operations::canonical_hash;
use crate::store::{PinnedConnection, Store};

#[derive(Clone)]
pub(super) struct JobRepository {
    store: Store,
}

pub(super) struct NewCapability {
    pub connection_id: ConnectionId,
    pub direction: JobFileDirection,
    pub path: PathBuf,
    pub display_name: String,
    pub size_bytes: Option<u64>,
    pub modified_at: Option<String>,
    pub source_sha256: Option<String>,
    pub expires_at: DateTime<Utc>,
}

pub(super) struct ResolvedCapability {
    pub path: PathBuf,
    pub display_name: String,
    pub size_bytes: Option<u64>,
    pub source_sha256: Option<String>,
}

#[derive(Clone)]
pub(super) struct JobRecord {
    pub job: Job,
    pub workspace_id: WorkspaceId,
    pub account_scope: String,
    pub plan: JobPlan,
    pub plan_hash: String,
}

pub(super) struct NewJob {
    pub id: JobId,
    pub operation_id: OperationId,
    pub connection_id: ConnectionId,
    pub kind: JobKind,
    pub format: JobFormat,
    pub plan: JobPlan,
    pub source_summary: String,
    pub target_summary: String,
    pub rows_total: Option<u64>,
    pub bytes_total: Option<u64>,
    pub resumable: bool,
}

impl JobRepository {
    pub(super) fn new(store: Store) -> Self {
        Self { store }
    }

    pub(super) async fn create_capability(
        &self,
        pin: &PinnedConnection,
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
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
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
        .execute(self.store.pool())
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
        &self,
        pin: &PinnedConnection,
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
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(pin.connection_id.to_string())
        .bind(direction.storage_key())
        .fetch_optional(self.store.pool())
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
        &self,
        job_id: JobId,
    ) -> AppResult<Option<PathBuf>> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.store.pool().begin().await?;
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

    pub(super) async fn retire_expired_input_capabilities(&self) -> AppResult<Vec<PathBuf>> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.store.pool().begin().await?;
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

    pub(super) async fn active_input_capability_paths(&self) -> AppResult<Vec<PathBuf>> {
        let paths = sqlx::query_scalar::<_, String>(
            "SELECT local_path FROM job_file_capabilities
             WHERE direction = 'input' AND revoked_at IS NULL",
        )
        .fetch_all(self.store.pool())
        .await?;
        Ok(paths.into_iter().map(PathBuf::from).collect())
    }

    pub(super) async fn insert_job(
        &self,
        pin: &PinnedConnection,
        new: NewJob,
    ) -> AppResult<JobRecord> {
        let plan_value = serde_json::to_value(&new.plan)?;
        let plan_json = serde_json::to_string(&plan_value)?;
        let plan_hash = canonical_hash(&plan_value)?;
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.store.pool().begin().await?;
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
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
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
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
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
        self.get_unscoped(new.id).await
    }

    pub(super) async fn list(&self, pin: &PinnedConnection) -> AppResult<Vec<Job>> {
        let rows = sqlx::query(
            "SELECT * FROM jobs
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3
             ORDER BY created_at DESC, id DESC",
        )
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(pin.connection_id.to_string())
        .fetch_all(self.store.pool())
        .await?;
        rows.iter().map(row_to_job).collect()
    }

    pub(super) async fn detail(
        &self,
        pin: &PinnedConnection,
        job_id: JobId,
    ) -> AppResult<(Job, Vec<JobArtifact>)> {
        let record = self.get_scoped(pin, job_id).await?;
        let rows = sqlx::query(
            "SELECT id, job_id, artifact_type, local_path, size_bytes, sha256, created_at
             FROM job_artifacts WHERE job_id = ?1 ORDER BY created_at ASC, id ASC",
        )
        .bind(job_id.to_string())
        .fetch_all(self.store.pool())
        .await?;
        let artifacts = rows
            .iter()
            .map(row_to_artifact)
            .collect::<AppResult<Vec<_>>>()?;
        Ok((record.job, artifacts))
    }

    pub(super) async fn get_scoped(
        &self,
        pin: &PinnedConnection,
        job_id: JobId,
    ) -> AppResult<JobRecord> {
        let row = sqlx::query(
            "SELECT * FROM jobs
             WHERE id = ?1 AND workspace_id = ?2 AND account_scope = ?3
               AND connection_id = ?4",
        )
        .bind(job_id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(pin.connection_id.to_string())
        .fetch_optional(self.store.pool())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("job {job_id}")))?;
        row_to_record(&row)
    }

    pub(super) async fn get_unscoped(&self, job_id: JobId) -> AppResult<JobRecord> {
        let row = sqlx::query("SELECT * FROM jobs WHERE id = ?1")
            .bind(job_id.to_string())
            .fetch_optional(self.store.pool())
            .await?
            .ok_or_else(|| AppError::NotFound(format!("job {job_id}")))?;
        row_to_record(&row)
    }

    pub(super) async fn queued_records(&self) -> AppResult<Vec<JobRecord>> {
        let rows = sqlx::query("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC")
            .fetch_all(self.store.pool())
            .await?;
        rows.iter().map(row_to_record).collect()
    }

    pub(super) async fn paused_records(&self) -> AppResult<Vec<JobRecord>> {
        let rows = sqlx::query("SELECT * FROM jobs WHERE state = 'paused' ORDER BY created_at ASC")
            .fetch_all(self.store.pool())
            .await?;
        rows.iter().map(row_to_record).collect()
    }

    pub(super) async fn claim_running(
        &self,
        pin: &PinnedConnection,
        job_id: JobId,
    ) -> AppResult<JobRecord> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.store.pool().begin().await?;
        let previous = sqlx::query_scalar::<_, String>(
            "SELECT state FROM jobs
             WHERE id = ?1 AND workspace_id = ?2 AND account_scope = ?3
               AND connection_id = ?4",
        )
        .bind(job_id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(pin.connection_id.to_string())
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
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(pin.connection_id.to_string())
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
        self.get_scoped(pin, job_id).await
    }

    pub(super) async fn update_progress(
        &self,
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
        let mut transaction = self.store.pool().begin().await?;
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
        self.get_unscoped(job_id).await
    }

    pub(super) async fn update_totals(
        &self,
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
        .execute(self.store.pool())
        .await?;
        if update.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "job stopped while totals were being recorded".into(),
            });
        }
        self.get_unscoped(job_id).await
    }

    pub(super) async fn latest_checkpoint(&self, job_id: JobId) -> AppResult<Option<Checkpoint>> {
        let row = sqlx::query(
            "SELECT source_fingerprint, target_fingerprint, checkpoint_json
             FROM job_checkpoints WHERE job_id = ?1 ORDER BY sequence DESC LIMIT 1",
        )
        .bind(job_id.to_string())
        .fetch_optional(self.store.pool())
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

    pub(super) async fn request_pause(&self, job_id: JobId) -> AppResult<JobRecord> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.store.pool().begin().await?;
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
        self.get_unscoped(job_id).await
    }

    pub(super) async fn finish_pause(&self, job_id: JobId) -> AppResult<JobRecord> {
        self.transition_job_state(job_id, JobTransition::PauseCompleted, None, None)
            .await
    }

    pub(super) async fn rollback_initial_start(&self, job_id: JobId) -> AppResult<JobRecord> {
        self.transition_job_state(
            job_id,
            JobTransition::InitialStartRolledBack,
            Some("operation_claim_failed"),
            Some("The exact operation could not be claimed; the job was returned to its queue."),
        )
        .await
    }

    pub(super) async fn request_cancel(&self, job_id: JobId) -> AppResult<JobRecord> {
        let current = self.get_unscoped(job_id).await?;
        if matches!(
            current.job.state,
            JobState::Running | JobState::PauseRequested
        ) {
            self.transition_job_state(
                job_id,
                JobTransition::RunningCancellationRequested,
                None,
                None,
            )
            .await
        } else {
            self.transition_job_state(job_id, JobTransition::WaitingCancelled, None, None)
                .await
        }
    }

    pub(super) async fn finish(
        &self,
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
        self.transition_job_state(job_id, transition, error_code, redacted_error)
            .await
    }

    pub(super) async fn finish_queued(
        &self,
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
        self.transition_job_state(job_id, transition, Some(error_code), Some(redacted_error))
            .await
    }

    pub(super) async fn fail_paused(
        &self,
        job_id: JobId,
        error_code: &str,
        redacted_error: &str,
    ) -> AppResult<JobRecord> {
        self.transition_job_state(
            job_id,
            JobTransition::PausedFailed,
            Some(error_code),
            Some(redacted_error),
        )
        .await
    }

    async fn transition_job_state(
        &self,
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
        let mut transaction = self.store.pool().begin().await?;
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
        self.get_unscoped(job_id).await
    }

    pub(super) async fn record_artifact(
        &self,
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
        .execute(self.store.pool())
        .await?;
        Ok(())
    }

    pub(super) async fn artifact_path(
        &self,
        pin: &PinnedConnection,
        artifact_id: JobArtifactId,
    ) -> AppResult<PathBuf> {
        let path = sqlx::query_scalar::<_, String>(
            "SELECT a.local_path
             FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
             WHERE a.id = ?1 AND j.workspace_id = ?2 AND j.account_scope = ?3
               AND j.connection_id = ?4 AND a.retention_state = 'retained'",
        )
        .bind(artifact_id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(pin.connection_id.to_string())
        .fetch_optional(self.store.pool())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("job artifact {artifact_id}")))?;
        Ok(PathBuf::from(path))
    }

    pub(super) async fn recover_interrupted(&self) -> AppResult<Vec<JobRecord>> {
        let interrupted = sqlx::query(
            "SELECT * FROM jobs
             WHERE state IN ('running', 'cancel_requested')
             ORDER BY created_at ASC",
        )
        .fetch_all(self.store.pool())
        .await?
        .iter()
        .map(row_to_record)
        .collect::<AppResult<Vec<_>>>()?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE jobs
             SET state = CASE WHEN kind = 'export' AND resumable = 1
                              THEN 'paused' ELSE 'failed' END,
                 pause_requested = 0,
                 error_code = CASE WHEN kind = 'export' AND resumable = 1
                                   THEN 'runtime_restarted'
                                   WHEN kind = 'import' THEN 'outcome_unknown'
                                   ELSE 'not_resumable' END,
                 redacted_error = CASE WHEN kind = 'export' AND resumable = 1
                     THEN 'The app restarted. Validate the checkpoint and resume.'
                     WHEN kind = 'import'
                     THEN 'The app restarted during import; the last commit may be ambiguous and is never retried automatically.'
                     ELSE 'The app restarted and this format cannot resume.' END,
                 finished_at = CASE WHEN kind = 'export' AND resumable = 1
                                    THEN NULL ELSE ?1 END,
                 updated_at = ?1
             WHERE state IN ('running', 'cancel_requested')",
        )
        .bind(now)
        .execute(self.store.pool())
        .await?;
        let mut recovered = Vec::with_capacity(interrupted.len());
        for record in interrupted {
            recovered.push(self.get_unscoped(record.job.id).await?);
        }
        Ok(recovered)
    }
}

pub(super) struct Checkpoint {
    pub source_fingerprint: String,
    pub target_fingerprint: String,
    pub value: Value,
}

async fn append_event(
    transaction: &mut Transaction<'_, Sqlite>,
    job_id: JobId,
    event_kind: &str,
    value: &Value,
) -> AppResult<()> {
    let sequence: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM job_events WHERE job_id = ?1",
    )
    .bind(job_id.to_string())
    .fetch_one(&mut **transaction)
    .await?;
    sqlx::query(
        "INSERT INTO job_events
            (id, job_id, sequence, event_kind, event_json, created_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(job_id.to_string())
    .bind(sequence)
    .bind(event_kind)
    .bind(serde_json::to_string(value)?)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn row_to_record(row: &sqlx::sqlite::SqliteRow) -> AppResult<JobRecord> {
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
    Ok(JobRecord {
        job: row_to_job(row)?,
        workspace_id,
        account_scope: row.try_get("account_scope")?,
        plan,
        plan_hash,
    })
}

fn row_to_job(row: &sqlx::sqlite::SqliteRow) -> AppResult<Job> {
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

fn row_to_artifact(row: &sqlx::sqlite::SqliteRow) -> AppResult<JobArtifact> {
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

fn parse_uuid(value: &str, label: &str) -> AppResult<Uuid> {
    Uuid::parse_str(value).map_err(|_| AppError::Config(format!("stored {label} id is invalid")))
}

fn required_u64(value: i64) -> AppResult<u64> {
    u64::try_from(value).map_err(|_| AppError::Config("stored job counter is invalid".into()))
}

fn optional_u64(value: Option<i64>) -> AppResult<Option<u64>> {
    value.map(required_u64).transpose()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::str::FromStr;

    use dopedb_protocol::{
        ObjectKind, ObjectRef, OperationActorKind, OperationKind, OperationRiskLevel,
    };
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::features::jobs::domain::JobConsistency;
    use crate::features::jobs::JobValidation;
    use crate::model::{
        ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
    };
    use crate::operations::{
        NewOperation, OperationActor, OperationActorProvenance, OperationPlanDisposition,
        OperationRuntime,
    };
    use crate::store::{Store, TEST_SCHEMA};

    async fn plan_job_operation(
        store: &Store,
        pin: &PinnedConnection,
        kind: OperationKind,
        key: &str,
    ) -> OperationId {
        let (runtime, _) = OperationRuntime::new(store);
        OperationId::from(
            runtime
                .plan(
                    NewOperation {
                        id: Uuid::new_v4(),
                        workspace_id: pin.scope.workspace_id,
                        account_scope: pin.scope.account_scope.storage_key().into(),
                        connection_id: pin.connection_id,
                        connection_revision: pin.connection_revision,
                        terminal_session_id: None,
                        actor: OperationActor {
                            kind: OperationActorKind::LocalUser,
                            id: "local-owner".into(),
                            provenance: OperationActorProvenance {
                                origin_surface: "job_test".into(),
                                ..OperationActorProvenance::default()
                            },
                        },
                        kind,
                        payload_schema_version: 1,
                        payload: json!({"format": "ndjson"}),
                        schema_fingerprint: Some("a".repeat(64)),
                        risk_level: OperationRiskLevel::Low,
                        preview: json!({}),
                        policy_snapshot: json!({"allowWrites": true}),
                        policy_revision: "test-policy".into(),
                        single_use: true,
                        idempotency_key: key.into(),
                        expires_at: None,
                    },
                    if kind.may_mutate_target() {
                        OperationPlanDisposition::ApprovalRequired
                    } else {
                        OperationPlanDisposition::Ready
                    },
                )
                .await
                .unwrap()
                .id,
        )
    }

    async fn fixture() -> (JobRepository, PinnedConnection, OperationId) {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
        let store = Store::from_pool_for_test(pool);
        let connection_id = Uuid::new_v4();
        store
            .upsert_connection(&ConnectionProfile {
                id: connection_id,
                name: "job fixture".into(),
                engine: Engine::Sqlite,
                provider: Provider::Generic,
                driver_id: Some("sqlx-sqlite".into()),
                host: String::new(),
                port: 0,
                database: ":memory:".into(),
                username: String::new(),
                sslmode: "disable".into(),
                extra_params: HashMap::new(),
                readonly_default: true,
                allow_writes: true,
                secret_ref: None,
                env: Some("test".into()),
                schema_group: None,
                workspace_access: WorkspaceConnectionAccess::Local,
                credential_mode: WorkspaceCredentialMode::Local,
            })
            .await
            .unwrap();
        let pin = store.pin_connection_for_read(connection_id).await.unwrap();
        let operation_id = plan_job_operation(
            &store,
            &pin,
            OperationKind::Export,
            &format!("job-test:{connection_id}"),
        )
        .await;
        (JobRepository::new(store), pin, operation_id)
    }

    #[tokio::test]
    async fn progress_pause_resume_and_cancel_are_durable_and_append_only() {
        let (repository, pin, operation_id) = fixture().await;
        let job_id = JobId::from(Uuid::new_v4());
        let output_directory = tempfile::tempdir().unwrap();
        let capability = repository
            .create_capability(
                &pin,
                NewCapability {
                    connection_id: pin.connection_id.into(),
                    direction: JobFileDirection::Output,
                    path: output_directory.path().join("items.ndjson"),
                    display_name: "items.ndjson".into(),
                    size_bytes: None,
                    modified_at: None,
                    source_sha256: None,
                    expires_at: Utc::now() + chrono::Duration::hours(1),
                },
            )
            .await
            .unwrap();
        let created = repository
            .insert_job(
                &pin,
                NewJob {
                    id: job_id,
                    operation_id,
                    connection_id: pin.connection_id.into(),
                    kind: JobKind::Export,
                    format: JobFormat::Ndjson,
                    plan: JobPlan::Export {
                        capability_id: capability.id,
                        relation: ObjectRef {
                            catalog: None,
                            namespace: Some("main".into()),
                            name: "items".into(),
                            kind: ObjectKind::Table,
                            native_id: None,
                        },
                        consistency: JobConsistency::PerBatchCurrent,
                        columns: vec!["id".into()],
                        field_names: Vec::new(),
                        batch_size: 500,
                    },
                    source_summary: "main.items".into(),
                    target_summary: "items.ndjson".into(),
                    rows_total: Some(1_000),
                    bytes_total: None,
                    resumable: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(created.job.state, JobState::Queued);
        assert!(sqlx::query("UPDATE jobs SET plan_hash = ?1 WHERE id = ?2")
            .bind("f".repeat(64))
            .bind(job_id.to_string())
            .execute(repository.store.pool())
            .await
            .is_err());
        assert!(sqlx::query(
            "UPDATE job_file_capabilities SET local_path = 'replaced' WHERE id = ?1"
        )
        .bind(capability.id.to_string())
        .execute(repository.store.pool())
        .await
        .is_err());

        repository.claim_running(&pin, job_id).await.unwrap();
        assert_eq!(
            repository
                .rollback_initial_start(job_id)
                .await
                .unwrap()
                .job
                .state,
            JobState::Queued
        );
        repository.claim_running(&pin, job_id).await.unwrap();
        repository
            .update_progress(
                job_id,
                500,
                4_096,
                Some(Checkpoint {
                    source_fingerprint: "a".repeat(64),
                    target_fingerprint: "b".repeat(64),
                    value: json!({"rowsProcessed": 500}),
                }),
            )
            .await
            .unwrap();
        assert!(repository
            .update_progress(job_id, 499, 4_095, None)
            .await
            .is_err());
        assert!(repository
            .update_progress(
                job_id,
                500,
                4_096,
                Some(Checkpoint {
                    source_fingerprint: "not-a-hash".into(),
                    target_fingerprint: "b".repeat(64),
                    value: json!({}),
                }),
            )
            .await
            .is_err());
        let requested = repository.request_pause(job_id).await.unwrap();
        assert_eq!(requested.job.state, JobState::PauseRequested);
        assert_eq!(
            repository.finish_pause(job_id).await.unwrap().job.state,
            JobState::Paused
        );

        repository.claim_running(&pin, job_id).await.unwrap();
        assert_eq!(
            repository.request_pause(job_id).await.unwrap().job.state,
            JobState::PauseRequested
        );
        assert_eq!(
            repository.request_cancel(job_id).await.unwrap().job.state,
            JobState::CancelRequested
        );
        repository
            .update_progress(job_id, 750, 6_144, None)
            .await
            .unwrap();
        assert_eq!(
            repository
                .finish(job_id, JobState::Cancelled, None, None)
                .await
                .unwrap()
                .job
                .state,
            JobState::Cancelled
        );

        let events = sqlx::query_scalar::<_, String>(
            "SELECT event_kind FROM job_events WHERE job_id = ?1 ORDER BY sequence",
        )
        .bind(job_id.to_string())
        .fetch_all(repository.store.pool())
        .await
        .unwrap();
        assert_eq!(
            events,
            vec![
                "queued",
                "started",
                "warning",
                "started",
                "progress",
                "warning",
                "paused",
                "resumed",
                "warning",
                "warning",
                "progress",
                "cancelled",
            ]
        );
        assert!(
            sqlx::query("UPDATE job_events SET event_json = '{}' WHERE job_id = ?1")
                .bind(job_id.to_string())
                .execute(repository.store.pool())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn restart_pauses_resumable_export_but_never_retries_import() {
        let (repository, pin, export_operation_id) = fixture().await;
        let directory = tempfile::tempdir().unwrap();
        let export_capability = repository
            .create_capability(
                &pin,
                NewCapability {
                    connection_id: pin.connection_id.into(),
                    direction: JobFileDirection::Output,
                    path: directory.path().join("export.ndjson"),
                    display_name: "export.ndjson".into(),
                    size_bytes: None,
                    modified_at: None,
                    source_sha256: None,
                    expires_at: Utc::now() + chrono::Duration::hours(1),
                },
            )
            .await
            .unwrap();
        let export_id = JobId::from(Uuid::new_v4());
        repository
            .insert_job(
                &pin,
                NewJob {
                    id: export_id,
                    operation_id: export_operation_id,
                    connection_id: pin.connection_id.into(),
                    kind: JobKind::Export,
                    format: JobFormat::Ndjson,
                    plan: JobPlan::Export {
                        capability_id: export_capability.id,
                        relation: ObjectRef {
                            catalog: None,
                            namespace: Some("main".into()),
                            name: "items".into(),
                            kind: ObjectKind::Table,
                            native_id: None,
                        },
                        consistency: JobConsistency::PerBatchCurrent,
                        columns: Vec::new(),
                        field_names: Vec::new(),
                        batch_size: 500,
                    },
                    source_summary: "main.items".into(),
                    target_summary: "export.ndjson".into(),
                    rows_total: None,
                    bytes_total: None,
                    resumable: true,
                },
            )
            .await
            .unwrap();
        repository.claim_running(&pin, export_id).await.unwrap();
        repository
            .update_progress(
                export_id,
                500,
                4_096,
                Some(Checkpoint {
                    source_fingerprint: "c".repeat(64),
                    target_fingerprint: "d".repeat(64),
                    value: json!({"rowsProcessed": 500}),
                }),
            )
            .await
            .unwrap();

        let import_operation_id = plan_job_operation(
            &repository.store,
            &pin,
            OperationKind::Import,
            "job-test:interrupted-import",
        )
        .await;
        let input_path = directory.path().join("input.ndjson");
        std::fs::write(&input_path, "{\"id\":1}\n").unwrap();
        let import_capability = repository
            .create_capability(
                &pin,
                NewCapability {
                    connection_id: pin.connection_id.into(),
                    direction: JobFileDirection::Input,
                    path: input_path,
                    display_name: "input.ndjson".into(),
                    size_bytes: Some(9),
                    modified_at: None,
                    source_sha256: Some("b".repeat(64)),
                    expires_at: Utc::now() + chrono::Duration::hours(1),
                },
            )
            .await
            .unwrap();
        let import_id = JobId::from(Uuid::new_v4());
        repository
            .insert_job(
                &pin,
                NewJob {
                    id: import_id,
                    operation_id: import_operation_id,
                    connection_id: pin.connection_id.into(),
                    kind: JobKind::Import,
                    format: JobFormat::Ndjson,
                    plan: JobPlan::Import {
                        capability_id: import_capability.id,
                        target_relation: Some(ObjectRef {
                            catalog: None,
                            namespace: Some("main".into()),
                            name: "items".into(),
                            kind: ObjectKind::Table,
                            native_id: None,
                        }),
                        mapping: Vec::new(),
                        validation: JobValidation::default(),
                        batch_size: 500,
                    },
                    source_summary: "input.ndjson".into(),
                    target_summary: "main.items".into(),
                    rows_total: None,
                    bytes_total: Some(9),
                    resumable: true,
                },
            )
            .await
            .unwrap();
        repository.claim_running(&pin, import_id).await.unwrap();

        repository.recover_interrupted().await.unwrap();
        let export = repository.get_unscoped(export_id).await.unwrap();
        let import = repository.get_unscoped(import_id).await.unwrap();
        assert_eq!(export.job.state, JobState::Paused);
        assert_eq!(export.job.error_code.as_deref(), Some("runtime_restarted"));
        assert_eq!(import.job.state, JobState::Failed);
        assert_eq!(import.job.error_code.as_deref(), Some("outcome_unknown"));
        assert!(repository
            .latest_checkpoint(export_id)
            .await
            .unwrap()
            .is_some());
    }
}
