//! Durable, scope-aware import/export Job Engine.
//!
//! Native file dialogs mint opaque capabilities, immutable plans are bound to an
//! exact Operation, and bounded workers persist progress/checkpoints so interruption
//! becomes an explicit pause rather than an ambiguous retry.

mod format;
mod repository;
mod worker;

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::{collections::HashSet, ffi::OsStr};

use chrono::{Duration, Utc};
use dashmap::DashMap;
use dopedb_protocol::{OperationKind, OperationRiskLevel, OperationState};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::connection::{ConnectionAccess, ConnectionManager};
use crate::error::{AppError, AppResult};
use crate::features::catalog::{CatalogFeature, CatalogReadPolicy};
use crate::features::jobs::{
    summaries, validate_mapping_sources, validate_plan, validate_required_target_columns,
};
pub(crate) use crate::features::jobs::{
    CreateJobRequest, Job, JobChangedEvent, JobDetail, JobFileCapability, JobFileDirection,
    JobFormat, JobInputInspection, JobKind, JobPlan, JobProposal, JobState,
};
use crate::kernel::identity::{
    ConnectionId, ConnectionJobId, JobArtifactId, JobFileCapabilityId, JobId, OperationId,
};
use crate::operations::{canonical_hash, NewOperation, OperationPlanDisposition, OperationRuntime};
use crate::store::Store;

use super::operation_service::{actor_for_pin, capture_policy, required_confirmation};
use repository::{JobRepository, NewCapability, NewJob};
use worker::{JobWorker, WorkerOutcome};

const FILE_CAPABILITY_DAYS: i64 = 30;
const MAX_INPUT_BYTES: u64 = 100 * 1024 * 1024 * 1024;
const MAX_CONCURRENT_JOBS: usize = 2;

#[derive(Clone)]
pub(crate) struct JobService {
    store: Store,
    connections: ConnectionManager,
    catalog: CatalogFeature,
    operation: OperationRuntime,
    repository: JobRepository,
    worker: JobWorker,
    running: Arc<DashMap<JobId, CancellationToken>>,
    concurrency: Arc<Semaphore>,
    events: broadcast::Sender<JobChangedEvent>,
}

impl JobService {
    pub(super) fn new(
        store: Store,
        connections: ConnectionManager,
        catalog: CatalogFeature,
        operation: OperationRuntime,
    ) -> Self {
        let repository = JobRepository::new(store.clone());
        let (events, _) = broadcast::channel(256);
        let worker = JobWorker::new(
            repository.clone(),
            connections.clone(),
            catalog.clone(),
            events.clone(),
        );
        Self {
            store,
            connections,
            catalog,
            operation,
            repository,
            worker,
            running: Arc::new(DashMap::new()),
            concurrency: Arc::new(Semaphore::new(MAX_CONCURRENT_JOBS)),
            events,
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<JobChangedEvent> {
        self.events.subscribe()
    }

    pub(crate) async fn recover_interrupted(&self) -> AppResult<u64> {
        match self.repository.retire_expired_input_capabilities().await {
            Ok(paths) => {
                for path in paths {
                    if let Err(error) =
                        tokio::task::spawn_blocking(move || remove_staged_input(&path))
                            .await
                            .map_err(|_| {
                                AppError::Config(
                                    "expired input cleanup stopped unexpectedly".into(),
                                )
                            })
                            .and_then(|result| result)
                    {
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
        match self.repository.active_input_capability_paths().await {
            Ok(active_paths) => {
                if let Err(error) =
                    tokio::task::spawn_blocking(move || sweep_staged_inputs(active_paths))
                        .await
                        .map_err(|_| {
                            AppError::Config("private input sweep stopped unexpectedly".into())
                        })
                        .and_then(|result| result)
                {
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
        let interrupted = self.repository.recover_interrupted().await?;
        for record in &interrupted {
            if record.job.kind == JobKind::Export
                && record.job.state == JobState::Failed
                && record.job.error_code.as_deref() == Some("not_resumable")
            {
                let operation = self.operation.get(record.job.operation_id.into()).await?;
                ensure_job_operation(record, &operation)?;
                self.operation
                    .fail_interrupted_export(operation.id, &operation.payload_hash)
                    .await?;
            }
            if record.job.state.terminal() {
                self.retire_import_source(record).await;
            }
        }
        for record in self.repository.queued_records().await? {
            let operation = self.operation.get(record.job.operation_id.into()).await?;
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
                    .repository
                    .finish_queued(record.job.id, state, code, message)
                    .await?;
                self.emit(&updated.job);
                self.retire_import_source(&updated).await;
            } else {
                self.operation
                    .rebind_pending_job(operation.id, &operation.payload_hash)
                    .await?;
            }
        }
        for record in self.repository.paused_records().await? {
            let operation = self.operation.get(record.job.operation_id.into()).await?;
            ensure_job_operation(&record, &operation)?;
            let has_checkpoint = self
                .repository
                .latest_checkpoint(record.job.id)
                .await?
                .is_some();
            if operation.state == OperationState::Executing && has_checkpoint {
                self.operation
                    .rebind_paused_job(operation.id, &operation.payload_hash)
                    .await?;
                continue;
            }

            let updated = self
                .repository
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
                    .fail_interrupted_export(operation.id, &operation.payload_hash)
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
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let canonical = tokio::task::spawn_blocking(move || snapshot_input(path))
            .await
            .map_err(|_| AppError::Config("input file inspection stopped".into()))??;
        let snapshot_path = canonical.path.clone();
        let result = self
            .repository
            .create_capability(
                context.pin(),
                NewCapability {
                    connection_id,
                    direction: JobFileDirection::Input,
                    path: canonical.path,
                    display_name: canonical.display_name,
                    size_bytes: Some(canonical.size_bytes),
                    modified_at: canonical.modified_at,
                    source_sha256: canonical.source_sha256,
                    expires_at: Utc::now() + Duration::days(FILE_CAPABILITY_DAYS),
                },
            )
            .await;
        if result.is_err() {
            let _ = tokio::task::spawn_blocking(move || remove_staged_input(&snapshot_path)).await;
        }
        result
    }

    pub(crate) async fn register_output(
        &self,
        connection_id: ConnectionId,
        path: PathBuf,
    ) -> AppResult<JobFileCapability> {
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let canonical = tokio::task::spawn_blocking(move || canonical_output(path))
            .await
            .map_err(|_| AppError::Config("output file inspection stopped".into()))??;
        self.repository
            .create_capability(
                context.pin(),
                NewCapability {
                    connection_id,
                    direction: JobFileDirection::Output,
                    path: canonical.path,
                    display_name: canonical.display_name,
                    size_bytes: None,
                    modified_at: None,
                    source_sha256: None,
                    expires_at: Utc::now() + Duration::days(FILE_CAPABILITY_DAYS),
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
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let capability = self
            .repository
            .resolve_capability(context.pin(), capability_id, JobFileDirection::Input, None)
            .await?;
        let path = capability.path;
        let engine = context.pin().profile.engine;
        let expected_hash = capability
            .source_sha256
            .ok_or_else(|| AppError::Config("input capability has no source hash".into()))?;
        tokio::task::spawn_blocking(move || {
            format::inspect_input_verified(&path, format, engine, &expected_hash)
        })
        .await
        .map_err(|_| AppError::Config("input inspection stopped unexpectedly".into()))?
    }

    pub(crate) async fn create(&self, request: CreateJobRequest) -> AppResult<JobProposal> {
        let kind = request.plan.kind();
        let access = if kind == JobKind::Import {
            ConnectionAccess::Write
        } else {
            ConnectionAccess::Read
        };
        let context = self
            .connections
            .pin(request.connection_id.into(), access)
            .await?;
        let pin = context.pin();
        if pin.profile.engine.is_document() {
            return Err(AppError::Blocked {
                reason:
                    "document databases require the typed document job adapter; SQL-family jobs cannot be used for this connection"
                        .into(),
            });
        }
        if kind == JobKind::Import {
            if !pin.profile.workspace_access.can_write() {
                return Err(AppError::Blocked {
                    reason: "your workspace role grants read-only database access".into(),
                });
            }
            let safety = self.store.get_safety(request.connection_id.into()).await?;
            if !safety.allow_writes {
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
            .repository
            .resolve_capability(pin, request.plan.capability_id(), direction, None)
            .await?;
        let (input_inspection, sql_audit) = if kind == JobKind::Import {
            let path = capability.path.clone();
            let format = request.format;
            let engine = pin.profile.engine;
            let expected_hash = capability
                .source_sha256
                .clone()
                .ok_or_else(|| AppError::Config("input capability has no source hash".into()))?;
            let review = tokio::task::spawn_blocking(move || {
                format::review_input_verified(&path, format, engine, &expected_hash)
            })
            .await
            .map_err(|_| AppError::Config("input validation stopped unexpectedly".into()))??;
            (Some(review.inspection), review.sql_audit)
        } else {
            (None, None)
        };
        let snapshot = self
            .catalog
            .load_snapshot(request.connection_id, CatalogReadPolicy::Refresh)
            .await?;
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
        let job_id = JobId::from(Uuid::new_v4());
        let operation_id = OperationId::from(Uuid::new_v4());
        let safety = self.store.get_safety(request.connection_id.into()).await?;
        let policy = capture_policy(pin, &safety)?;
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
                    workspace_id: pin.scope.workspace_id,
                    account_scope: pin.scope.account_scope.storage_key().into(),
                    connection_id: request.connection_id.into(),
                    connection_revision: pin.connection_revision,
                    terminal_session_id: None,
                    actor: actor_for_pin(pin, "job_engine".into()),
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
                    policy_snapshot: policy.snapshot,
                    policy_revision: policy.revision,
                    single_use: true,
                    idempotency_key: format!("job:{job_id}"),
                    expires_at: (kind == JobKind::Import)
                        .then(|| Utc::now() + Duration::minutes(30)),
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
            .repository
            .insert_job(
                pin,
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
                    .cancel_before_execution(
                        operation_id.into(),
                        &json!({"reason": "job_insert_failed"}),
                    )
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
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        self.repository.list(context.pin()).await
    }

    pub(crate) async fn detail(&self, scoped_id: ConnectionJobId) -> AppResult<JobDetail> {
        let ConnectionJobId {
            connection_id,
            job_id,
        } = scoped_id;
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let (job, artifacts) = self.repository.detail(context.pin(), job_id).await?;
        let operation = self.operation.get(job.operation_id.into()).await?;
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
        let read_context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let current = self
            .repository
            .get_scoped(read_context.pin(), job_id)
            .await?;
        let access = if current.job.kind == JobKind::Import {
            ConnectionAccess::Write
        } else {
            ConnectionAccess::Read
        };
        let context = self.connections.pin(connection_id.into(), access).await?;
        if current.job.kind == JobKind::Import {
            let safety = self.store.get_safety(connection_id.into()).await?;
            if !safety.allow_writes || !context.pin().profile.workspace_access.can_write() {
                return Err(AppError::Blocked {
                    reason: "current policy no longer allows this import".into(),
                });
            }
        }
        let operation = self.operation.get(current.job.operation_id.into()).await?;
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
            self.worker.validate_resume(&current).await?;
        }
        let running = self.repository.claim_running(context.pin(), job_id).await?;
        let claimed = if matches!(
            operation.state,
            OperationState::Ready | OperationState::Approved
        ) {
            self.operation.claim(operation.id).await
        } else if operation.state == OperationState::Executing
            && current.job.state == JobState::Paused
        {
            self.operation
                .resume_job_claim(operation.id, &operation.payload_hash)
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
                let latest = self.repository.get_unscoped(job_id).await?;
                if latest.job.state == JobState::CancelRequested {
                    return self.finish_cancelled_without_worker(&latest).await;
                }
                if current.job.state == JobState::Paused {
                    let _ = self.repository.finish_pause(job_id).await;
                } else {
                    let _ = self.repository.rollback_initial_start(job_id).await;
                }
                return Err(error);
            }
        };
        let token = CancellationToken::new();
        self.running.insert(job_id, token.clone());
        let latest = match self.repository.get_unscoped(job_id).await {
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
        let worker = self.worker.clone();
        let record = running.clone();
        tokio::spawn(async move {
            let permit = tokio::select! {
                biased;
                _ = token.cancelled() => None,
                permit = service.concurrency.clone().acquire_owned() => Some(permit),
            };
            let result = match permit {
                Some(Ok(_permit)) => worker.run(record.clone(), claimed, token).await,
                Some(Err(_)) => Err(AppError::Config("job scheduler stopped".into())),
                None => match service.repository.get_unscoped(job_id).await {
                    Ok(current) if current.job.state == JobState::CancelRequested => {
                        Ok(WorkerOutcome::Cancelled)
                    }
                    Ok(_) => worker.run(record.clone(), claimed, token).await,
                    Err(error) => Err(error),
                },
            };
            service.complete(record, result).await;
            service.running.remove(&job_id);
        });
        self.emit(&latest.job);
        Ok(latest.job)
    }

    async fn finish_cancelled_without_worker(
        &self,
        record: &repository::JobRecord,
    ) -> AppResult<Job> {
        let updated = self
            .repository
            .finish(record.job.id, JobState::Cancelled, None, None)
            .await?;
        let operation = self.operation.get(record.job.operation_id.into()).await?;
        if operation.state == OperationState::Executing {
            let _ = self
                .operation
                .confirm_cancelled(operation.id, &json!({"reason": "job_cancelled"}))
                .await;
        } else if !operation.state.is_terminal() {
            let _ = self
                .operation
                .cancel_before_execution(operation.id, &json!({"reason": "job_cancelled"}))
                .await;
        }
        self.emit(&updated.job);
        self.retire_import_source(&updated).await;
        Ok(updated.job)
    }

    async fn complete(&self, record: repository::JobRecord, result: AppResult<WorkerOutcome>) {
        match result {
            Ok(WorkerOutcome::Succeeded) => {
                if let Ok(updated) = self
                    .repository
                    .finish(record.job.id, JobState::Succeeded, None, None)
                    .await
                {
                    let _ = self
                        .operation
                        .succeed(
                            record.job.operation_id.into(),
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
                match self.repository.finish_pause(record.job.id).await {
                    Ok(updated) => self.emit(&updated.job),
                    Err(_) => {
                        // Cancel may win after the worker observed pause_requested
                        // but before this durable transition. Never strand the Job
                        // in cancel_requested without a worker.
                        if let Ok(current) = self.repository.get_unscoped(record.job.id).await {
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
                    .repository
                    .finish(record.job.id, JobState::Cancelled, None, None)
                    .await
                {
                    let _ = self
                        .operation
                        .confirm_cancelled(
                            record.job.operation_id.into(),
                            &json!({"reason": "job_cancelled"}),
                        )
                        .await;
                    self.emit(&updated.job);
                    self.retire_import_source(&updated).await;
                }
            }
            Err(error) => {
                let current = self.repository.get_unscoped(record.job.id).await;
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
                    .repository
                    .finish(record.job.id, JobState::Failed, Some(code), Some(redacted))
                    .await
                {
                    if outcome_unknown {
                        let _ = self
                            .operation
                            .mark_outcome_unknown(
                                record.job.operation_id.into(),
                                &json!({"reason": code}),
                            )
                            .await;
                    } else {
                        let _ = self
                            .operation
                            .fail(record.job.operation_id.into(), &json!({"reason": code}))
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
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let current = self.repository.get_scoped(context.pin(), job_id).await?;
        if !current.job.resumable {
            return Err(AppError::Blocked {
                reason: "this format cannot pause and resume".into(),
            });
        }
        let updated = self.repository.request_pause(job_id).await?;
        if let Some(token) = self.running.get(&job_id) {
            token.cancel();
        }
        crate::executor::cancel::cancel(job_id.into());
        self.emit(&updated.job);
        Ok(updated.job)
    }

    pub(crate) async fn cancel(&self, scoped_id: ConnectionJobId) -> AppResult<Job> {
        let ConnectionJobId {
            connection_id,
            job_id,
        } = scoped_id;
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let current = self.repository.get_scoped(context.pin(), job_id).await?;
        if current.job.state.terminal() {
            return Ok(current.job);
        }
        if current.job.state == JobState::CancelRequested {
            return Ok(current.job);
        }
        let updated = self.repository.request_cancel(job_id).await?;
        if let Some(token) = self.running.get(&job_id) {
            token.cancel();
            crate::executor::cancel::cancel(job_id.into());
        } else {
            let operation = self.operation.get(current.job.operation_id.into()).await?;
            if operation.state == OperationState::Executing {
                let _ = self
                    .operation
                    .confirm_cancelled(operation.id, &json!({"reason": "job_cancelled"}))
                    .await;
            } else if !operation.state.is_terminal() {
                let _ = self
                    .operation
                    .cancel_before_execution(operation.id, &json!({"reason": "job_cancelled"}))
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
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        self.repository
            .artifact_path(context.pin(), artifact_id)
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

    async fn retire_import_source(&self, record: &repository::JobRecord) {
        if record.job.kind != JobKind::Import || !record.job.state.terminal() {
            return;
        }
        let path = match self.repository.retire_input_capability(record.job.id).await {
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
        if let Err(error) = tokio::task::spawn_blocking(move || remove_staged_input(&path))
            .await
            .map_err(|_| AppError::Config("private input cleanup stopped unexpectedly".into()))
            .and_then(|result| result)
        {
            tracing::warn!(
                job_id = %record.job.id,
                error = %error,
                "could not remove a retired private job input"
            );
        }
    }
}

struct CanonicalInput {
    path: PathBuf,
    display_name: String,
    size_bytes: u64,
    modified_at: Option<String>,
    source_sha256: Option<String>,
}

fn snapshot_input(path: PathBuf) -> AppResult<CanonicalInput> {
    let directory = job_input_directory()?;
    std::fs::create_dir_all(&directory)?;
    let metadata = std::fs::symlink_metadata(&directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "job input storage is not a regular app-owned directory".into(),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    snapshot_input_to(path, &directory)
}

fn job_input_directory() -> AppResult<PathBuf> {
    Ok(dirs::data_dir()
        .ok_or_else(|| AppError::Config("no OS data directory".into()))?
        .join("dopedb")
        .join("job-inputs"))
}

fn remove_staged_input(path: &Path) -> AppResult<()> {
    let directory = job_input_directory()?;
    remove_staged_input_from(&directory, path)
}

fn remove_staged_input_from(directory: &Path, path: &Path) -> AppResult<()> {
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_suffix(".input"))
        .and_then(|value| Uuid::parse_str(value).ok());
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || path.parent() != Some(directory)
        || filename.is_none()
    {
        return Err(AppError::Blocked {
            reason: "refusing to remove a file outside private job input storage".into(),
        });
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Err(AppError::Blocked {
            reason: "private job input was replaced by a directory".into(),
        }),
        Ok(_) => {
            std::fs::remove_file(path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn sweep_staged_inputs(active_paths: Vec<PathBuf>) -> AppResult<()> {
    let directory = job_input_directory()?;
    sweep_staged_inputs_in(&directory, active_paths)
}

fn sweep_staged_inputs_in(directory: &Path, active_paths: Vec<PathBuf>) -> AppResult<()> {
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "job input storage is not a regular app-owned directory".into(),
        });
    }
    let active_paths = active_paths.into_iter().collect::<HashSet<_>>();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let is_private_input = path
            .file_name()
            .and_then(OsStr::to_str)
            .and_then(|value| value.strip_suffix(".input"))
            .is_some_and(|value| Uuid::parse_str(value).is_ok());
        if is_private_input && !active_paths.contains(&path) {
            remove_staged_input_from(directory, &path)?;
        }
    }
    Ok(())
}

fn snapshot_input_to(path: PathBuf, directory: &Path) -> AppResult<CanonicalInput> {
    let path = std::fs::canonicalize(path)?;
    let display_name = display_name(&path)?;
    let mut input_options = OpenOptions::new();
    input_options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        input_options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        input_options
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut input = input_options.open(&path)?;
    let metadata = input.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_INPUT_BYTES {
        return Err(AppError::Config(
            "input must be a regular file no larger than 100 GiB".into(),
        ));
    }
    let modified_at = metadata
        .modified()
        .ok()
        .map(chrono::DateTime::<Utc>::from)
        .map(|value| value.to_rfc3339());
    let snapshot_path = directory.join(format!("{}.input", Uuid::new_v4()));
    let result = (|| -> AppResult<CanonicalInput> {
        let mut output_options = OpenOptions::new();
        output_options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            output_options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            output_options.custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            );
        }
        let mut output = output_options.open(&snapshot_path)?;
        let mut hasher = Sha256::new();
        let mut size_bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            size_bytes = size_bytes
                .checked_add(read as u64)
                .ok_or_else(|| AppError::Config("input file size overflowed".into()))?;
            if size_bytes > MAX_INPUT_BYTES {
                return Err(AppError::Config(
                    "input must be a regular file no larger than 100 GiB".into(),
                ));
            }
            hasher.update(&buffer[..read]);
            output.write_all(&buffer[..read])?;
        }
        output.flush()?;
        output.sync_all()?;
        Ok(CanonicalInput {
            path: snapshot_path.clone(),
            display_name,
            size_bytes,
            modified_at,
            source_sha256: Some(hex::encode(hasher.finalize())),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&snapshot_path);
    }
    result
}

fn canonical_output(path: PathBuf) -> AppResult<CanonicalInput> {
    let filename = path
        .file_name()
        .ok_or_else(|| AppError::Config("output filename is missing".into()))?
        .to_owned();
    let parent = std::fs::canonicalize(
        path.parent()
            .ok_or_else(|| AppError::Config("output directory is missing".into()))?,
    )?;
    if !std::fs::metadata(&parent)?.is_dir() {
        return Err(AppError::Config("output parent is not a directory".into()));
    }
    let path = parent.join(filename);
    if std::fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || metadata.is_dir())
    {
        return Err(AppError::Blocked {
            reason: "output cannot replace a symlink or directory".into(),
        });
    }
    Ok(CanonicalInput {
        display_name: display_name(&path)?,
        path,
        size_bytes: 0,
        modified_at: None,
        source_sha256: None,
    })
}

fn display_name(path: &Path) -> AppResult<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::Config("selected filename is not valid Unicode".into()))
}

fn ensure_job_operation(
    record: &repository::JobRecord,
    operation: &crate::operations::OperationRecord,
) -> AppResult<()> {
    let expected_kind = match record.job.kind {
        JobKind::Import => OperationKind::Import,
        JobKind::Export => OperationKind::Export,
    };
    let matches = operation.id == Uuid::from(record.job.operation_id)
        && operation.connection_id == Uuid::from(record.job.connection_id)
        && operation.workspace_id == Uuid::from(record.workspace_id)
        && operation.account_scope == record.account_scope
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
    fn output_path_rejects_directory_and_symlink_targets() {
        let directory = tempfile::tempdir().unwrap();
        assert!(canonical_output(directory.path().to_owned()).is_err());
        let output = canonical_output(directory.path().join("export.ndjson")).unwrap();
        assert_eq!(output.display_name, "export.ndjson");
        assert_eq!(
            output.path,
            directory
                .path()
                .canonicalize()
                .unwrap()
                .join("export.ndjson")
        );
    }

    #[test]
    fn selected_input_is_frozen_in_a_private_snapshot() {
        let source_directory = tempfile::tempdir().unwrap();
        let snapshot_directory = tempfile::tempdir().unwrap();
        let source = source_directory.path().join("approved.sql");
        std::fs::write(&source, "INSERT INTO items VALUES (1);").unwrap();

        let snapshot = snapshot_input_to(source.clone(), snapshot_directory.path()).unwrap();
        std::fs::write(&source, "DROP TABLE items;").unwrap();

        assert_eq!(snapshot.display_name, "approved.sql");
        assert_eq!(
            std::fs::read_to_string(&snapshot.path).unwrap(),
            "INSERT INTO items VALUES (1);"
        );
        let snapshot_hash = format::file_sha256(&snapshot.path).unwrap();
        assert_eq!(
            snapshot.source_sha256.as_deref(),
            Some(snapshot_hash.as_str())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&snapshot.path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn private_input_sweep_keeps_only_active_uuid_snapshots() {
        let directory = tempfile::tempdir().unwrap();
        let active = directory.path().join(format!("{}.input", Uuid::new_v4()));
        let orphaned = directory.path().join(format!("{}.input", Uuid::new_v4()));
        let unrelated = directory.path().join("keep-me.txt");
        std::fs::write(&active, "active").unwrap();
        std::fs::write(&orphaned, "orphaned").unwrap();
        std::fs::write(&unrelated, "unrelated").unwrap();

        sweep_staged_inputs_in(directory.path(), vec![active.clone()]).unwrap();

        assert!(active.is_file());
        assert!(!orphaned.exists());
        assert!(unrelated.is_file());
    }

    #[test]
    fn job_formats_expose_resume_limits_explicitly() {
        assert!(JobFormat::Csv.resumable());
        assert!(JobFormat::Ndjson.resumable());
        assert!(!JobFormat::Xlsx.resumable());
        assert!(!JobFormat::CsvGzip.resumable());
        assert_eq!(JobFormat::CsvGzip.base(), JobFormat::Csv);
    }
}
