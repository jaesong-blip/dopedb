use dopedb_protocol::{OperationKind, OperationState};

use crate::error::{AppError, AppResult};
use crate::features::jobs::{JobKind, JobState};

use super::super::ports::{
    JobAuthorityPort, JobCatalogPort, JobExecutionPort, JobFilePort, JobGeneratorPort,
    JobLedgerPort, JobOperationPort, JobRecord,
};
use super::JobUseCases;

impl<L, A, F, C, O, E, G> JobUseCases<L, A, F, C, O, E, G>
where
    L: JobLedgerPort,
    A: JobAuthorityPort,
    F: JobFilePort,
    C: JobCatalogPort,
    O: JobOperationPort,
    E: JobExecutionPort<O::Claim>,
    G: JobGeneratorPort,
{
    pub(crate) async fn recover_interrupted(&self) -> AppResult<u64> {
        match self.ledger.retire_expired_input_capabilities().await {
            Ok(paths) => {
                for path in paths {
                    if let Err(error) = self.files.remove_private_input(path).await {
                        tracing::warn!(
                            error = %error,
                            "could not remove an expired private job input"
                        );
                    }
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, "could not retire expired job inputs");
            }
        }
        match self.ledger.active_input_capability_paths().await {
            Ok(active_paths) => {
                if let Err(error) = self.files.sweep_private_inputs(active_paths).await {
                    tracing::warn!(
                        error = %error,
                        "could not sweep orphaned private job inputs"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, "could not load active private job inputs");
            }
        }
        let interrupted = self.ledger.recover_interrupted().await?;
        for record in &interrupted {
            if record.job.kind == JobKind::Export
                && record.job.state == JobState::Failed
                && record.job.error_code.as_deref() == Some("not_resumable")
            {
                let operation = self.operation.get(record.job.operation_id).await?;
                ensure_job_operation(record, &operation)?;
                self.operation
                    .fail_interrupted_export(operation.id.into(), &operation.payload_hash)
                    .await?;
            }
            if record.job.state.terminal() {
                self.retire_import_source(record).await;
            }
        }
        for record in self.ledger.queued_records().await? {
            let operation = self.operation.get(record.job.operation_id).await?;
            ensure_job_operation(&record, &operation)?;
            if operation.state.is_terminal() {
                let (state, code, message) = match operation.state {
                    OperationState::Rejected
                    | OperationState::Expired
                    | OperationState::Cancelled => (
                        JobState::Cancelled,
                        "operation_cancelled",
                        "The exact job operation was rejected, expired, or cancelled.",
                    ),
                    _ => (
                        JobState::Failed,
                        "operation_projection_mismatch",
                        "The exact job operation finished without this queued job.",
                    ),
                };
                let updated = self
                    .ledger
                    .finish_queued(record.job.id, state, code, message)
                    .await?;
                self.emit(&updated.job);
                self.retire_import_source(&updated).await;
            } else {
                self.operation
                    .rebind_pending_job(operation.id.into(), &operation.payload_hash)
                    .await?;
            }
        }
        for record in self.ledger.paused_records().await? {
            let operation = self.operation.get(record.job.operation_id).await?;
            ensure_job_operation(&record, &operation)?;
            let has_checkpoint = self
                .ledger
                .latest_checkpoint(record.job.id)
                .await?
                .is_some();
            if operation.state == OperationState::Executing && has_checkpoint {
                self.operation
                    .rebind_paused_job(operation.id.into(), &operation.payload_hash)
                    .await?;
                continue;
            }

            let updated = self
                .ledger
                .fail_paused(
                    record.job.id,
                    "invalid_resume_checkpoint",
                    "The paused job no longer has a matching executable operation and durable checkpoint.",
                )
                .await?;
            self.emit(&updated.job);
            self.retire_import_source(&updated).await;
            if operation.state == OperationState::Executing && record.job.kind == JobKind::Export {
                self.operation
                    .fail_interrupted_export(operation.id.into(), &operation.payload_hash)
                    .await?;
            }
        }
        Ok(interrupted.len() as u64)
    }
}

fn ensure_job_operation(
    record: &JobRecord,
    operation: &crate::operations::OperationRecord,
) -> AppResult<()> {
    let expected_kind = match record.job.kind {
        JobKind::Import => OperationKind::Import,
        JobKind::Export => OperationKind::Export,
    };
    let matches = operation.id == uuid::Uuid::from(record.job.operation_id)
        && operation.connection_id == uuid::Uuid::from(record.job.connection_id)
        && operation.workspace_id == uuid::Uuid::from(record.workspace_id)
        && operation.account_scope == record.account_scope.as_str()
        && operation.kind == expected_kind
        && operation
            .payload
            .get("jobId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value == record.job.id.to_string())
        && operation
            .payload
            .get("planHash")
            .and_then(serde_json::Value::as_str)
            == Some(record.plan_hash.as_str());
    if matches {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "job projection does not match its immutable operation".into(),
        })
    }
}
