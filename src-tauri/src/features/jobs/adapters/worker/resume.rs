use crate::error::{AppError, AppResult};
use crate::features::jobs::{JobFileDirection, JobPlan, JobState};

use super::super::super::ports::{
    JobAuthorityGuard, JobAuthorityPort, JobCatalogPort, JobLedgerPort, JobPermission, JobRecord,
};
use super::super::format::file_sha256;
use super::files::{partial_path, validate_output_parent};
use super::validation::{
    ensure_record_scope, find_relation, validate_checkpoint_counters, validate_export_checkpoint,
    validate_import_checkpoint,
};
use super::JobWorker;

impl JobWorker {
    /// Validate every durable resume boundary before the Operation runtime issues
    /// a fresh execution grant. The worker repeats these checks after claiming so
    /// a file or catalog change in the small intervening window still fails closed.
    pub(super) async fn validate_resume_inner(&self, record: &JobRecord) -> AppResult<()> {
        if record.job.state != JobState::Paused || !record.job.resumable {
            return Err(AppError::Blocked {
                reason: "only a resumable paused job can be validated for resume".into(),
            });
        }
        let checkpoint = self
            .repository
            .latest_checkpoint(record.job.id)
            .await?
            .ok_or_else(|| AppError::Blocked {
                reason: "paused job has no durable checkpoint".into(),
            })?;
        validate_checkpoint_counters(&checkpoint, record)?;

        match &record.plan {
            JobPlan::Export {
                capability_id,
                relation,
                ..
            } => {
                let guard = self
                    .authority
                    .authorize(record.job.connection_id, JobPermission::Read)
                    .await?;
                ensure_record_scope(record, guard.authority())?;
                let capability = self
                    .repository
                    .resolve_capability(
                        guard.authority(),
                        *capability_id,
                        JobFileDirection::Output,
                        Some(record.job.id),
                    )
                    .await?;
                validate_output_parent(&capability.path)?;
                let snapshot = self.catalog.refresh(record.job.connection_id).await?;
                find_relation(&snapshot, relation)?;
                let partial = partial_path(&capability.path, record.job.id)?;
                let partial_hash = tokio::task::spawn_blocking(move || file_sha256(&partial))
                    .await
                    .map_err(|_| {
                        AppError::Config("partial output validation stopped unexpectedly".into())
                    })??;
                validate_export_checkpoint(
                    Some(&checkpoint),
                    snapshot.fingerprint(),
                    Some(&partial_hash),
                )
            }
            JobPlan::Import {
                capability_id,
                target_relation,
                ..
            } => {
                let guard = self
                    .authority
                    .authorize(record.job.connection_id, JobPermission::Write)
                    .await?;
                ensure_record_scope(record, guard.authority())?;
                if !guard.authority().workspace_access.can_write() {
                    return Err(AppError::Blocked {
                        reason: "your workspace role grants read-only database access".into(),
                    });
                }
                let capability = self
                    .repository
                    .resolve_capability(
                        guard.authority(),
                        *capability_id,
                        JobFileDirection::Input,
                        Some(record.job.id),
                    )
                    .await?;
                let expected_source = capability.source_sha256.ok_or_else(|| {
                    AppError::Config("input capability has no source hash".into())
                })?;
                let source_path = capability.path;
                let actual_source = tokio::task::spawn_blocking(move || file_sha256(&source_path))
                    .await
                    .map_err(|_| {
                        AppError::Config("input validation stopped unexpectedly".into())
                    })??;
                if actual_source != expected_source {
                    return Err(AppError::Blocked {
                        reason: "the selected input file changed after the job was reviewed".into(),
                    });
                }
                let snapshot = self.catalog.refresh(record.job.connection_id).await?;
                if let Some(reference) = target_relation {
                    find_relation(&snapshot, reference)?;
                }
                validate_import_checkpoint(
                    Some(&checkpoint),
                    &actual_source,
                    snapshot.fingerprint(),
                )
            }
        }
    }
}
