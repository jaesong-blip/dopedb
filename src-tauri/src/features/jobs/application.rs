//! Durable, scope-aware import/export Job application use cases.
//!
//! Native file dialogs mint opaque capabilities, immutable plans are bound to an
//! exact Operation, and bounded workers persist progress/checkpoints so interruption
//! becomes an explicit pause rather than an ambiguous retry.

use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;
use dopedb_protocol::{OperationKind, OperationRiskLevel, OperationState};
use serde_json::json;
use tokio::sync::{broadcast, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::features::jobs::{
    summaries, validate_mapping_sources, validate_plan, validate_required_target_columns,
};
use crate::features::jobs::{
    CreateJobRequest, Job, JobChangedEvent, JobDetail, JobFileCapability, JobFileDirection,
    JobFormat, JobInputInspection, JobKind, JobPlan, JobProposal, JobState,
};
use crate::kernel::identity::{
    ConnectionId, ConnectionJobId, JobArtifactId, JobFileCapabilityId, JobId,
};
use crate::operations::{
    canonical_hash, required_confirmation, NewOperation, OperationPlanDisposition,
};

use super::ports::{
    JobAuthorityGuard, JobAuthorityPort, JobCatalogPort, JobExecutionPort, JobFilePort,
    JobGeneratorPort, JobLedgerPort, JobOperationPort, JobPermission, JobRecord, NewCapability,
    NewJob, WorkerOutcome,
};

const MAX_CONCURRENT_JOBS: usize = 2;

pub(crate) struct JobDependencies<L, A, F, C, O, E, G> {
    pub(crate) ledger: L,
    pub(crate) authority: A,
    pub(crate) files: F,
    pub(crate) catalog: C,
    pub(crate) operation: O,
    pub(crate) execution: E,
    pub(crate) generator: G,
}

#[derive(Clone)]
pub(crate) struct JobUseCases<L, A, F, C, O, E, G> {
    ledger: L,
    authority: A,
    files: F,
    catalog: C,
    operation: O,
    execution: E,
    generator: G,
    running: Arc<DashMap<JobId, CancellationToken>>,
    concurrency: Arc<Semaphore>,
    events: broadcast::Sender<JobChangedEvent>,
}

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
    pub(crate) fn new(
        dependencies: JobDependencies<L, A, F, C, O, E, G>,
        events: broadcast::Sender<JobChangedEvent>,
    ) -> Self {
        let JobDependencies {
            ledger,
            authority,
            files,
            catalog,
            operation,
            execution,
            generator,
        } = dependencies;
        Self {
            ledger,
            authority,
            files,
            catalog,
            operation,
            execution,
            generator,
            running: Arc::new(DashMap::new()),
            concurrency: Arc::new(Semaphore::new(MAX_CONCURRENT_JOBS)),
            events,
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<JobChangedEvent> {
        self.events.subscribe()
    }

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

    pub(crate) async fn register_input(
        &self,
        connection_id: ConnectionId,
        path: PathBuf,
    ) -> AppResult<JobFileCapability> {
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let canonical = self.files.snapshot_input(path).await?;
        let snapshot_path = canonical.path.clone();
        let result = self
            .ledger
            .create_capability(
                guard.authority(),
                NewCapability {
                    connection_id,
                    direction: JobFileDirection::Input,
                    path: canonical.path,
                    display_name: canonical.display_name,
                    size_bytes: Some(canonical.size_bytes),
                    modified_at: canonical.modified_at,
                    source_sha256: canonical.source_sha256,
                    expires_at: self.generator.capability_expires_at(),
                },
            )
            .await;
        if result.is_err() {
            let _ = self.files.remove_private_input(snapshot_path).await;
        }
        result
    }

    pub(crate) async fn register_output(
        &self,
        connection_id: ConnectionId,
        path: PathBuf,
    ) -> AppResult<JobFileCapability> {
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let canonical = self.files.prepare_output(path).await?;
        self.ledger
            .create_capability(
                guard.authority(),
                NewCapability {
                    connection_id,
                    direction: JobFileDirection::Output,
                    path: canonical.path,
                    display_name: canonical.display_name,
                    size_bytes: None,
                    modified_at: None,
                    source_sha256: None,
                    expires_at: self.generator.capability_expires_at(),
                },
            )
            .await
    }

    pub(crate) async fn inspect_input(
        &self,
        connection_id: ConnectionId,
        capability_id: JobFileCapabilityId,
        format: JobFormat,
    ) -> AppResult<JobInputInspection> {
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let capability = self
            .ledger
            .resolve_capability(
                guard.authority(),
                capability_id,
                JobFileDirection::Input,
                None,
            )
            .await?;
        let path = capability.path;
        let engine = guard.authority().engine;
        let expected_hash = capability
            .source_sha256
            .ok_or_else(|| AppError::Config("input capability has no source hash".into()))?;
        self.files
            .inspect_input(path, format, engine, expected_hash)
            .await
    }

    pub(crate) async fn create(&self, request: CreateJobRequest) -> AppResult<JobProposal> {
        let kind = request.plan.kind();
        let permission = if kind == JobKind::Import {
            JobPermission::Write
        } else {
            JobPermission::Read
        };
        let guard = self
            .authority
            .authorize(request.connection_id, permission)
            .await?;
        let authority = guard.authority();
        if authority.engine.is_document() {
            return Err(AppError::Blocked {
                reason:
                    "document databases require the typed document job adapter; SQL-family jobs cannot be used for this connection"
                        .into(),
            });
        }
        let operation_context = self
            .authority
            .operation_context(&guard, "job_engine")
            .await?;
        if kind == JobKind::Import {
            if !authority.workspace_access.can_write() {
                return Err(AppError::Blocked {
                    reason: "your workspace role grants read-only database access".into(),
                });
            }
            if !operation_context.safety.allow_writes {
                return Err(AppError::Blocked {
                    reason: "writes are disabled for this connection; enable them before importing"
                        .into(),
                });
            }
        }
        let direction = if kind == JobKind::Import {
            JobFileDirection::Input
        } else {
            JobFileDirection::Output
        };
        let capability = self
            .ledger
            .resolve_capability(authority, request.plan.capability_id(), direction, None)
            .await?;
        let (input_inspection, sql_audit) = if kind == JobKind::Import {
            let path = capability.path.clone();
            let format = request.format;
            let engine = authority.engine;
            let expected_hash = capability
                .source_sha256
                .clone()
                .ok_or_else(|| AppError::Config("input capability has no source hash".into()))?;
            let review = self
                .files
                .review_input(path, format, engine, expected_hash)
                .await?;
            (Some(review.inspection), review.sql_audit)
        } else {
            (None, None)
        };
        let snapshot = self.catalog.refresh(request.connection_id).await?;
        validate_plan(&request, &snapshot)?;
        if let (
            Some(inspection),
            JobPlan::Import {
                mapping,
                target_relation: Some(_),
                ..
            },
        ) = (&input_inspection, &request.plan)
        {
            validate_mapping_sources(mapping, &inspection.fields)?;
            validate_required_target_columns(&request.plan, &snapshot, &inspection.fields)?;
        }
        let plan_value = serde_json::to_value(&request.plan)?;
        let plan_hash = canonical_hash(&plan_value)?;
        let job_id = self.generator.next_job_id();
        let operation_id = self.generator.next_operation_id();
        let (source_summary, target_summary) = summaries(&request.plan, &capability.display_name);
        let operation_kind = if kind == JobKind::Import {
            OperationKind::Import
        } else {
            OperationKind::Export
        };
        let risk = if kind == JobKind::Export {
            OperationRiskLevel::Low
        } else if request.format.base() == JobFormat::Sql {
            OperationRiskLevel::Critical
        } else {
            OperationRiskLevel::High
        };
        let operation = self
            .operation
            .plan(
                NewOperation {
                    id: operation_id.into(),
                    workspace_id: authority.resource.workspace_id.into(),
                    account_scope: authority.account_scope.as_str().into(),
                    connection_id: request.connection_id.into(),
                    connection_revision: authority.connection_revision,
                    terminal_session_id: None,
                    actor: operation_context.actor,
                    kind: operation_kind,
                    payload_schema_version: 1,
                    payload: json!({
                        "format": request.format,
                        "jobId": job_id,
                        "plan": plan_value,
                        "planHash": plan_hash,
                        "sourceSha256": capability.source_sha256,
                        "sqlAudit": sql_audit.as_ref().map(|audit| json!({
                            "ddlCount": audit.ddl_count,
                            "readCount": audit.read_count,
                            "statementCount": audit.statement_count,
                            "writeCount": audit.write_count,
                        })),
                        "inputInspection": input_inspection.as_ref().map(|inspection| json!({
                            "fieldCount": inspection.fields.len(),
                            "itemCount": inspection.item_count,
                            "resumable": inspection.resumable,
                        })),
                    }),
                    schema_fingerprint: Some(snapshot.fingerprint().to_owned()),
                    risk_level: risk,
                    preview: json!({
                        "format": request.format,
                        "source": source_summary,
                        "target": target_summary,
                        "sqlAudit": sql_audit.as_ref().map(|audit| json!({
                            "ddlCount": audit.ddl_count,
                            "readCount": audit.read_count,
                            "statementCount": audit.statement_count,
                            "writeCount": audit.write_count,
                        })),
                        "inputInspection": input_inspection.as_ref().map(|inspection| json!({
                            "fieldCount": inspection.fields.len(),
                            "itemCount": inspection.item_count,
                            "resumable": inspection.resumable,
                        })),
                    }),
                    policy_snapshot: operation_context.policy_snapshot,
                    policy_revision: operation_context.policy_revision,
                    single_use: true,
                    idempotency_key: format!("job:{job_id}"),
                    expires_at: (kind == JobKind::Import)
                        .then(|| self.generator.import_operation_expires_at()),
                },
                if kind == JobKind::Import {
                    OperationPlanDisposition::ApprovalRequired
                } else {
                    OperationPlanDisposition::Ready
                },
            )
            .await?;
        let resumable = request.format.resumable()
            && !(kind == JobKind::Import && request.format.base() == JobFormat::Sql);
        let rows_total = input_inspection
            .as_ref()
            .and_then(|inspection| inspection.item_count);
        // Streaming gzip readers report decompressed progress while a file
        // capability records compressed bytes. Do not present mismatched units.
        let bytes_total = (kind == JobKind::Import && !request.format.compressed())
            .then_some(capability.size_bytes)
            .flatten();
        let inserted = self
            .ledger
            .insert_job(
                authority,
                NewJob {
                    id: job_id,
                    operation_id,
                    connection_id: request.connection_id,
                    kind,
                    format: request.format,
                    plan: request.plan,
                    source_summary,
                    target_summary,
                    rows_total,
                    bytes_total,
                    resumable,
                },
            )
            .await;
        let inserted = match inserted {
            Ok(inserted) => inserted,
            Err(error) => {
                let _ = self
                    .operation
                    .cancel_before_execution(operation_id, &json!({"reason": "job_insert_failed"}))
                    .await;
                return Err(error);
            }
        };
        Ok(JobProposal {
            job: inserted.job,
            payload_hash: operation.payload_hash.clone(),
            approval_required: kind == JobKind::Import,
            confirmation_phrase: required_confirmation(&operation).map(str::to_owned),
        })
    }

    pub(crate) async fn list(&self, connection_id: ConnectionId) -> AppResult<Vec<Job>> {
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        self.ledger.list(guard.authority()).await
    }

    pub(crate) async fn detail(&self, scoped_id: ConnectionJobId) -> AppResult<JobDetail> {
        let ConnectionJobId {
            connection_id,
            job_id,
        } = scoped_id;
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let (job, artifacts) = self.ledger.detail(guard.authority(), job_id).await?;
        let operation = self.operation.get(job.operation_id).await?;
        Ok(JobDetail {
            job,
            artifacts,
            approval_required: operation.state == OperationState::PendingApproval,
            confirmation_phrase: required_confirmation(&operation).map(str::to_owned),
            payload_hash: operation.payload_hash,
            operation_state: operation.state,
        })
    }

    pub(crate) async fn start(&self, scoped_id: ConnectionJobId) -> AppResult<Job> {
        let ConnectionJobId {
            connection_id,
            job_id,
        } = scoped_id;
        if self.running.contains_key(&job_id) {
            return Err(AppError::Blocked {
                reason: "job is already running".into(),
            });
        }
        let read_guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let current = self
            .ledger
            .get_scoped(read_guard.authority(), job_id)
            .await?;
        let permission = if current.job.kind == JobKind::Import {
            JobPermission::Write
        } else {
            JobPermission::Read
        };
        let guard = self.authority.authorize(connection_id, permission).await?;
        if current.job.kind == JobKind::Import {
            let safety = self.authority.safety(&guard).await?;
            if !safety.allow_writes || !guard.authority().workspace_access.can_write() {
                return Err(AppError::Blocked {
                    reason: "current policy no longer allows this import".into(),
                });
            }
        }
        let operation = self.operation.get(current.job.operation_id).await?;
        if operation.state == OperationState::PendingApproval {
            return Err(AppError::Blocked {
                reason: "approve the exact import plan before starting it".into(),
            });
        }
        if current.job.state == JobState::Paused && !current.job.resumable {
            return Err(AppError::Blocked {
                reason: "this file format cannot resume; create a new job".into(),
            });
        }
        if current.job.state == JobState::Paused {
            self.execution.validate_resume(&current).await?;
        }
        let running = self.ledger.claim_running(guard.authority(), job_id).await?;
        let claimed = if matches!(
            operation.state,
            OperationState::Ready | OperationState::Approved
        ) {
            self.operation.claim(operation.id.into()).await
        } else if operation.state == OperationState::Executing
            && current.job.state == JobState::Paused
        {
            self.operation
                .resume_job_claim(operation.id.into(), &operation.payload_hash)
                .await
        } else {
            Err(AppError::Blocked {
                reason: "job operation is not executable".into(),
            })
        };
        let claimed = match claimed {
            Ok(claimed) => claimed,
            Err(error) => {
                // `claim_running` is intentionally performed before the Operation
                // claim so only one worker can win. If it fails, restore the exact
                // prior durable state instead of stranding a workerless `running`.
                let latest = self.ledger.get_unscoped(job_id).await?;
                if latest.job.state == JobState::CancelRequested {
                    return self.finish_cancelled_without_worker(&latest).await;
                }
                if current.job.state == JobState::Paused {
                    let _ = self.ledger.finish_pause(job_id).await;
                } else {
                    let _ = self.ledger.rollback_initial_start(job_id).await;
                }
                return Err(error);
            }
        };
        let token = CancellationToken::new();
        self.running.insert(job_id, token.clone());
        let latest = match self.ledger.get_unscoped(job_id).await {
            Ok(latest) => latest,
            Err(error) => {
                self.running.remove(&job_id);
                return Err(error);
            }
        };
        if latest.job.state == JobState::CancelRequested {
            token.cancel();
            self.running.remove(&job_id);
            return self.finish_cancelled_without_worker(&latest).await;
        }
        if latest.job.state == JobState::PauseRequested {
            token.cancel();
        }
        let service = self.clone();
        let execution = self.execution.clone();
        let record = running.clone();
        tokio::spawn(async move {
            let permit = tokio::select! {
                biased;
                _ = token.cancelled() => None,
                permit = service.concurrency.clone().acquire_owned() => Some(permit),
            };
            let result = match permit {
                Some(Ok(_permit)) => execution.run(record.clone(), claimed, token).await,
                Some(Err(_)) => Err(AppError::Config("job scheduler stopped".into())),
                None => match service.ledger.get_unscoped(job_id).await {
                    Ok(current) if current.job.state == JobState::CancelRequested => {
                        Ok(WorkerOutcome::Cancelled)
                    }
                    Ok(_) => execution.run(record.clone(), claimed, token).await,
                    Err(error) => Err(error),
                },
            };
            service.complete(record, result).await;
            service.running.remove(&job_id);
        });
        self.emit(&latest.job);
        Ok(latest.job)
    }

    async fn finish_cancelled_without_worker(&self, record: &JobRecord) -> AppResult<Job> {
        let updated = self
            .ledger
            .finish(record.job.id, JobState::Cancelled, None, None)
            .await?;
        let operation = self.operation.get(record.job.operation_id).await?;
        if operation.state == OperationState::Executing {
            let _ = self
                .operation
                .confirm_cancelled(operation.id.into(), &json!({"reason": "job_cancelled"}))
                .await;
        } else if !operation.state.is_terminal() {
            let _ = self
                .operation
                .cancel_before_execution(operation.id.into(), &json!({"reason": "job_cancelled"}))
                .await;
        }
        self.emit(&updated.job);
        self.retire_import_source(&updated).await;
        Ok(updated.job)
    }

    async fn complete(&self, record: JobRecord, result: AppResult<WorkerOutcome>) {
        match result {
            Ok(WorkerOutcome::Succeeded) => {
                if let Ok(updated) = self
                    .ledger
                    .finish(record.job.id, JobState::Succeeded, None, None)
                    .await
                {
                    let _ = self
                        .operation
                        .succeed(
                            record.job.operation_id,
                            &json!({
                                "bytesProcessed": updated.job.bytes_processed,
                                "rowsProcessed": updated.job.rows_processed,
                            }),
                        )
                        .await;
                    self.emit(&updated.job);
                    self.retire_import_source(&updated).await;
                }
            }
            Ok(WorkerOutcome::Paused) => {
                match self.ledger.finish_pause(record.job.id).await {
                    Ok(updated) => self.emit(&updated.job),
                    Err(_) => {
                        // Cancel may win after the worker observed pause_requested
                        // but before this durable transition. Never strand the Job
                        // in cancel_requested without a worker.
                        if let Ok(current) = self.ledger.get_unscoped(record.job.id).await {
                            if current.job.state == JobState::CancelRequested {
                                let _ = self.finish_cancelled_without_worker(&current).await;
                            } else if current.job.state == JobState::Paused {
                                self.emit(&current.job);
                            }
                        }
                    }
                }
            }
            Ok(WorkerOutcome::Cancelled) => {
                if let Ok(updated) = self
                    .ledger
                    .finish(record.job.id, JobState::Cancelled, None, None)
                    .await
                {
                    let _ = self
                        .operation
                        .confirm_cancelled(
                            record.job.operation_id,
                            &json!({"reason": "job_cancelled"}),
                        )
                        .await;
                    self.emit(&updated.job);
                    self.retire_import_source(&updated).await;
                }
            }
            Err(error) => {
                let current = self.ledger.get_unscoped(record.job.id).await;
                if current
                    .as_ref()
                    .is_ok_and(|value| value.job.state == JobState::Paused)
                {
                    if let Ok(current) = current {
                        self.emit(&current.job);
                    }
                    return;
                }
                let code = error_code(&error);
                let outcome_unknown = matches!(&error, AppError::OutcomeUnknown(_));
                let redacted = if outcome_unknown {
                    "The database may have committed the last import statement. Do not retry automatically; inspect the target first."
                } else {
                    "The job failed. Review its error artifact or retry the plan."
                };
                if let Ok(updated) = self
                    .ledger
                    .finish(record.job.id, JobState::Failed, Some(code), Some(redacted))
                    .await
                {
                    if outcome_unknown {
                        let _ = self
                            .operation
                            .mark_outcome_unknown(record.job.operation_id, &json!({"reason": code}))
                            .await;
                    } else {
                        let _ = self
                            .operation
                            .fail(record.job.operation_id, &json!({"reason": code}))
                            .await;
                    }
                    self.emit(&updated.job);
                    self.retire_import_source(&updated).await;
                }
            }
        }
    }

    pub(crate) async fn pause(&self, scoped_id: ConnectionJobId) -> AppResult<Job> {
        let ConnectionJobId {
            connection_id,
            job_id,
        } = scoped_id;
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let current = self.ledger.get_scoped(guard.authority(), job_id).await?;
        if !current.job.resumable {
            return Err(AppError::Blocked {
                reason: "this format cannot pause and resume".into(),
            });
        }
        let updated = self.ledger.request_pause(job_id).await?;
        if let Some(token) = self.running.get(&job_id) {
            token.cancel();
        }
        self.execution.cancel(job_id);
        self.emit(&updated.job);
        Ok(updated.job)
    }

    pub(crate) async fn cancel(&self, scoped_id: ConnectionJobId) -> AppResult<Job> {
        let ConnectionJobId {
            connection_id,
            job_id,
        } = scoped_id;
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let current = self.ledger.get_scoped(guard.authority(), job_id).await?;
        if current.job.state.terminal() {
            return Ok(current.job);
        }
        if current.job.state == JobState::CancelRequested {
            return Ok(current.job);
        }
        let updated = self.ledger.request_cancel(job_id).await?;
        if let Some(token) = self.running.get(&job_id) {
            token.cancel();
            self.execution.cancel(job_id);
        } else {
            let operation = self.operation.get(current.job.operation_id).await?;
            if operation.state == OperationState::Executing {
                let _ = self
                    .operation
                    .confirm_cancelled(operation.id.into(), &json!({"reason": "job_cancelled"}))
                    .await;
            } else if !operation.state.is_terminal() {
                let _ = self
                    .operation
                    .cancel_before_execution(
                        operation.id.into(),
                        &json!({"reason": "job_cancelled"}),
                    )
                    .await;
            }
            if updated.job.state == JobState::CancelRequested {
                return self.finish_cancelled_without_worker(&updated).await;
            }
            if updated.job.state.terminal() {
                self.retire_import_source(&updated).await;
            }
        }
        self.emit(&updated.job);
        Ok(updated.job)
    }

    pub(crate) async fn artifact_path(
        &self,
        connection_id: ConnectionId,
        artifact_id: JobArtifactId,
    ) -> AppResult<PathBuf> {
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        self.ledger
            .artifact_path(guard.authority(), artifact_id)
            .await
    }

    fn emit(&self, job: &Job) {
        let _ = self.events.send(JobChangedEvent {
            connection_id: job.connection_id,
            job_id: job.id,
            state: job.state,
            rows_processed: job.rows_processed,
            bytes_processed: job.bytes_processed,
        });
    }

    async fn retire_import_source(&self, record: &JobRecord) {
        if record.job.kind != JobKind::Import || !record.job.state.terminal() {
            return;
        }
        let path = match self.ledger.retire_input_capability(record.job.id).await {
            Ok(Some(path)) => path,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(
                    job_id = %record.job.id,
                    error = %error,
                    "could not retire a private job input"
                );
                return;
            }
        };
        if let Err(error) = self.files.remove_private_input(path).await {
            tracing::warn!(
                job_id = %record.job.id,
                error = %error,
                "could not remove a retired private job input"
            );
        }
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

fn error_code(error: &AppError) -> &'static str {
    match error {
        AppError::Blocked { .. } => "blocked",
        AppError::Network(_) => "network",
        AppError::OutcomeUnknown(_) => "outcome_unknown",
        AppError::Db(_) | AppError::Mongo(_) => "database",
        AppError::Io(_) => "io",
        _ => "job_failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_formats_expose_resume_limits_explicitly() {
        assert!(JobFormat::Csv.resumable());
        assert!(JobFormat::Ndjson.resumable());
        assert!(!JobFormat::Xlsx.resumable());
        assert!(!JobFormat::CsvGzip.resumable());
        assert_eq!(JobFormat::CsvGzip.base(), JobFormat::Csv);
    }
}
