//! One bounded import/export worker. Database reads are paged, writes commit in
//! bounded transactions, and every resumable boundary records exact source/target
//! fingerprints before progress is published.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use dopedb_protocol::{CatalogSnapshot, ConstraintKind, NormalizedTypeFamily, ObjectRef};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::AssertSqlSafe;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::connection::{ConnectionAccess, ConnectionManager, DbPool};
use crate::error::{AppError, AppResult};
use crate::features::catalog::{CatalogFeature, CatalogReadPolicy};
use crate::model::Engine;
use crate::operations::{ClaimedOperation, ExecutionGrant};

use super::format::{
    create_error_writer, file_sha256, finalize_error_writer, typed_sql_literal, write_error_row,
    ExportSink, ImportDataRow, ImportItem, ImportSource,
};
use super::model::{
    JobChangedEvent, JobErrorPolicy, JobFieldMapping, JobFileDirection, JobFormat, JobPlan,
    JobState, JobValidation,
};
use super::repository::{Checkpoint, JobRecord, JobRepository};

const MAX_EXPORT_BATCH_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WorkerOutcome {
    Succeeded,
    Paused,
    Cancelled,
}

#[derive(Clone)]
pub(super) struct JobWorker {
    repository: JobRepository,
    connections: ConnectionManager,
    catalog: CatalogFeature,
    events: broadcast::Sender<JobChangedEvent>,
}

impl JobWorker {
    pub(super) fn new(
        repository: JobRepository,
        connections: ConnectionManager,
        catalog: CatalogFeature,
        events: broadcast::Sender<JobChangedEvent>,
    ) -> Self {
        Self {
            repository,
            connections,
            catalog,
            events,
        }
    }

    /// Validate every durable resume boundary before the Operation runtime issues
    /// a fresh execution grant. The worker repeats these checks after claiming so
    /// a file or catalog change in the small intervening window still fails closed.
    pub(super) async fn validate_resume(&self, record: &JobRecord) -> AppResult<()> {
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
                let context = self
                    .connections
                    .pin(record.job.connection_id, ConnectionAccess::Read)
                    .await?;
                ensure_record_scope(record, context.pin())?;
                let capability = self
                    .repository
                    .resolve_capability(
                        context.pin(),
                        *capability_id,
                        JobFileDirection::Output,
                        Some(record.job.id),
                    )
                    .await?;
                validate_output_parent(&capability.path)?;
                let snapshot = self
                    .catalog
                    .load_snapshot(record.job.connection_id.into(), CatalogReadPolicy::Refresh)
                    .await?;
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
                let context = self
                    .connections
                    .pin(record.job.connection_id, ConnectionAccess::Write)
                    .await?;
                ensure_record_scope(record, context.pin())?;
                if !context.pin().profile.workspace_access.can_write() {
                    return Err(AppError::Blocked {
                        reason: "your workspace role grants read-only database access".into(),
                    });
                }
                let capability = self
                    .repository
                    .resolve_capability(
                        context.pin(),
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
                let snapshot = self
                    .catalog
                    .load_snapshot(record.job.connection_id.into(), CatalogReadPolicy::Refresh)
                    .await?;
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

    pub(super) async fn run(
        &self,
        record: JobRecord,
        claimed: ClaimedOperation,
        cancellation: CancellationToken,
    ) -> AppResult<WorkerOutcome> {
        verify_operation(&record, &claimed)?;
        match &record.plan {
            JobPlan::Export { .. } => {
                let recovery_record = record.clone();
                let result = self.run_export(record, &claimed, cancellation).await;
                if matches!(&result, Err(_) | Ok(WorkerOutcome::Cancelled)) {
                    if let Err(error) = self.retain_export_partial(&recovery_record).await {
                        tracing::warn!(
                            job_id = %recovery_record.job.id,
                            error = %error,
                            "could not retain export partial artifact"
                        );
                    }
                }
                result
            }
            JobPlan::Import { .. } => self.run_import(record, &claimed, cancellation).await,
        }
    }

    async fn run_export(
        &self,
        record: JobRecord,
        claimed: &ClaimedOperation,
        cancellation: CancellationToken,
    ) -> AppResult<WorkerOutcome> {
        let JobPlan::Export {
            capability_id,
            relation,
            columns,
            field_names,
            batch_size,
            ..
        } = &record.plan
        else {
            unreachable!()
        };
        let context = self
            .connections
            .pin(record.job.connection_id, ConnectionAccess::Read)
            .await?;
        ensure_record_scope(&record, context.pin())?;
        let engine = context.pin().profile.engine;
        let capability = self
            .repository
            .resolve_capability(
                context.pin(),
                *capability_id,
                JobFileDirection::Output,
                Some(record.job.id),
            )
            .await?;
        let snapshot = self
            .catalog
            .load_snapshot(record.job.connection_id.into(), CatalogReadPolicy::Refresh)
            .await?;
        let relation_metadata = find_relation(&snapshot, relation)?;
        let source_columns = if columns.is_empty() {
            relation_metadata
                .columns
                .iter()
                .map(|column| column.name.clone())
                .collect::<Vec<_>>()
        } else {
            validate_columns(
                columns,
                &relation_metadata
                    .columns
                    .iter()
                    .map(|column| column.name.as_str())
                    .collect::<Vec<_>>(),
            )?;
            columns.clone()
        };
        if source_columns.is_empty() {
            return Err(AppError::Config(
                "export relation contains no columns".into(),
            ));
        }
        let output_columns = export_field_names(&source_columns, field_names)?;
        let type_families = source_columns
            .iter()
            .map(|name| {
                relation_metadata
                    .columns
                    .iter()
                    .find(|column| column.name == *name)
                    .map(|column| column.type_family)
                    .ok_or_else(|| {
                        AppError::Config(format!(
                            "export column `{name}` has no catalog type metadata"
                        ))
                    })
            })
            .collect::<AppResult<Vec<_>>>()?;
        validate_output_parent(&capability.path)?;
        let partial = partial_path(&capability.path, record.job.id)?;
        let table_sql = quoted_relation(engine, relation);
        let source_fingerprint = snapshot.fingerprint().to_owned();
        let resume_checkpoint = self.repository.latest_checkpoint(record.job.id).await?;
        if let Some(checkpoint) = &resume_checkpoint {
            validate_checkpoint_counters(checkpoint, &record)?;
            if record.job.rows_processed == 0 {
                let checkpoint_partial = partial.clone();
                let partial_hash =
                    tokio::task::spawn_blocking(move || file_sha256(&checkpoint_partial))
                        .await
                        .map_err(|_| {
                            AppError::Config(
                                "partial output validation stopped unexpectedly".into(),
                            )
                        })??;
                validate_export_checkpoint(
                    Some(checkpoint),
                    &source_fingerprint,
                    Some(&partial_hash),
                )?;
            }
        } else if record.job.rows_processed > 0 {
            return Err(AppError::Blocked {
                reason: "resumable export has no durable checkpoint".into(),
            });
        }
        let mut sink = ExportSink::open(
            &partial,
            record.job.format,
            output_columns,
            type_families,
            table_sql.clone(),
            engine,
            record.job.rows_processed,
        )?;
        if record.job.rows_processed > 0 {
            let checkpoint = resume_checkpoint
                .as_ref()
                .ok_or_else(|| AppError::Blocked {
                    reason: "resumable export has no durable checkpoint".into(),
                })?;
            validate_export_checkpoint(
                Some(checkpoint),
                &source_fingerprint,
                sink.fingerprint().as_deref(),
            )?;
        }
        if cancellation.is_cancelled() {
            return self
                .checkpoint_export_stop(
                    &record,
                    &mut sink,
                    &partial,
                    &source_fingerprint,
                    record.job.rows_processed,
                )
                .await;
        }
        let lease = context.connect().await?;
        let live = lease.live().sql()?;
        let order_columns = relation_metadata
            .constraints
            .iter()
            .find(|constraint| constraint.kind == ConstraintKind::Primary)
            .map(|constraint| constraint.columns.clone())
            .filter(|values| !values.is_empty())
            .unwrap_or_else(|| vec![source_columns[0].clone()]);
        let select_columns = source_columns
            .iter()
            .map(|column| quote_identifier(engine, column))
            .collect::<Vec<_>>()
            .join(", ");
        let order = order_columns
            .iter()
            .map(|column| quote_identifier(engine, column))
            .collect::<Vec<_>>()
            .join(", ");
        let mut rows_processed = record.job.rows_processed;
        let total = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                return self
                    .checkpoint_export_stop(
                        &record,
                        &mut sink,
                        &partial,
                        &source_fingerprint,
                        rows_processed,
                    )
                    .await;
            }
            result = count_rows(live, engine, &table_sql, record.job.id) => {
                match result {
                    Ok(total) => total,
                    Err(_) if cancellation.is_cancelled() => {
                        return self
                            .checkpoint_export_stop(
                                &record,
                                &mut sink,
                                &partial,
                                &source_fingerprint,
                                rows_processed,
                            )
                            .await;
                    }
                    Err(error) => return Err(error),
                }
            }
        };
        if let Err(error) = self
            .repository
            .update_totals(record.job.id, Some(total), None)
            .await
        {
            if cancellation.is_cancelled() {
                return self
                    .checkpoint_export_stop(
                        &record,
                        &mut sink,
                        &partial,
                        &source_fingerprint,
                        rows_processed,
                    )
                    .await;
            }
            return Err(error);
        }
        loop {
            if cancellation.is_cancelled() {
                return self
                    .checkpoint_export_stop(
                        &record,
                        &mut sink,
                        &partial,
                        &source_fingerprint,
                        rows_processed,
                    )
                    .await;
            }
            let sql = format!(
                "SELECT {select_columns} FROM {table_sql} ORDER BY {order} LIMIT {} OFFSET {}",
                batch_size, rows_processed
            );
            let result = match crate::executor::read::run_read_byte_capped(
                live,
                engine,
                &sql,
                u64::from(*batch_size),
                MAX_EXPORT_BATCH_BYTES,
                Some(record.job.id),
            )
            .await
            {
                Ok(result) => result,
                Err(_) if cancellation.is_cancelled() => {
                    return self
                        .checkpoint_export_stop(
                            &record,
                            &mut sink,
                            &partial,
                            &source_fingerprint,
                            rows_processed,
                        )
                        .await;
                }
                Err(error) => return Err(error),
            };
            if cancellation.is_cancelled() {
                return self
                    .checkpoint_export_stop(
                        &record,
                        &mut sink,
                        &partial,
                        &source_fingerprint,
                        rows_processed,
                    )
                    .await;
            }
            if result.rows.is_empty() {
                break;
            }
            sink.write_rows(&result.rows)?;
            rows_processed = sink.rows_written();
            let bytes = file_len(&partial)?;
            let checkpoint = sink.fingerprint().map(|target| Checkpoint {
                source_fingerprint: source_fingerprint.clone(),
                target_fingerprint: target,
                value: json!({
                    "bytesProcessed": bytes,
                    "rowsProcessed": rows_processed,
                }),
            });
            let updated = self
                .repository
                .update_progress(record.job.id, rows_processed, bytes, checkpoint)
                .await?;
            self.emit(&updated.job);
        }
        sink.finish()?;
        finalize_output(&partial, &capability.path)?;
        let size = file_len(&capability.path)?;
        let sha256 = file_sha256(&capability.path)?;
        self.repository
            .record_artifact(record.job.id, "output", &capability.path, size, &sha256)
            .await?;
        self.repository
            .update_progress(record.job.id, rows_processed, size, None)
            .await?;
        let _ = claimed.grant();
        Ok(WorkerOutcome::Succeeded)
    }

    async fn checkpoint_export_stop(
        &self,
        record: &JobRecord,
        sink: &mut ExportSink,
        partial: &Path,
        source_fingerprint: &str,
        rows_processed: u64,
    ) -> AppResult<WorkerOutcome> {
        sink.flush()?;
        let bytes = file_len(partial)?;
        let checkpoint = sink.fingerprint().map(|target| Checkpoint {
            source_fingerprint: source_fingerprint.to_owned(),
            target_fingerprint: target,
            value: json!({
                "bytesProcessed": bytes,
                "rowsProcessed": rows_processed,
            }),
        });
        let updated = self
            .repository
            .update_progress(record.job.id, rows_processed, bytes, checkpoint)
            .await?;
        self.emit(&updated.job);
        self.stop_outcome(record.job.id).await
    }

    async fn run_import(
        &self,
        record: JobRecord,
        claimed: &ClaimedOperation,
        cancellation: CancellationToken,
    ) -> AppResult<WorkerOutcome> {
        let JobPlan::Import {
            capability_id,
            target_relation,
            mapping,
            validation,
            batch_size,
        } = &record.plan
        else {
            unreachable!()
        };
        let context = self
            .connections
            .pin(record.job.connection_id, ConnectionAccess::Write)
            .await?;
        ensure_record_scope(&record, context.pin())?;
        let engine = context.pin().profile.engine;
        if !context.pin().profile.workspace_access.can_write() {
            return Err(AppError::Blocked {
                reason: "your workspace role grants read-only database access".into(),
            });
        }
        let capability = self
            .repository
            .resolve_capability(
                context.pin(),
                *capability_id,
                JobFileDirection::Input,
                Some(record.job.id),
            )
            .await?;
        let expected_source = capability
            .source_sha256
            .as_deref()
            .ok_or_else(|| AppError::Config("input capability has no source hash".into()))?;
        let snapshot = self
            .catalog
            .load_snapshot(record.job.connection_id.into(), CatalogReadPolicy::Refresh)
            .await?;
        let target_fingerprint = snapshot.fingerprint().to_owned();
        let target_metadata = match target_relation {
            Some(reference) => Some(find_relation(&snapshot, reference)?),
            None if record.job.format.base() == JobFormat::Sql => None,
            None => {
                return Err(AppError::Config(
                    "structured import requires a target relation".into(),
                ))
            }
        };
        let source_path = capability.path.clone();
        let source_format = record.job.format;
        let resume_rows = record.job.rows_processed;
        let expected_source = expected_source.to_owned();
        let (mut source, actual_source) = tokio::task::spawn_blocking(move || {
            ImportSource::open_verified(
                &source_path,
                source_format,
                resume_rows,
                engine,
                &expected_source,
            )
        })
        .await
        .map_err(|_| AppError::Config("input preparation stopped unexpectedly".into()))??;
        let resume_checkpoint = self.repository.latest_checkpoint(record.job.id).await?;
        if let Some(checkpoint) = &resume_checkpoint {
            validate_checkpoint_counters(checkpoint, &record)?;
            validate_import_checkpoint(Some(checkpoint), &actual_source, &target_fingerprint)?;
        } else if record.job.rows_processed > 0 {
            return Err(AppError::Blocked {
                reason: "resumable import has no durable checkpoint".into(),
            });
        }
        let error_path = error_artifact_path(record.job.id)?;
        let append_errors = resume_checkpoint.is_some() && error_path.is_file();
        let mut error_writer = create_error_writer(&error_path, append_errors)?;
        let mut error_count = resume_checkpoint
            .as_ref()
            .and_then(|checkpoint| checkpoint.value.get("errors"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mut committed_bytes = resume_checkpoint
            .as_ref()
            .and_then(|checkpoint| checkpoint.value.get("bytesProcessed"))
            .and_then(Value::as_u64)
            .unwrap_or(record.job.bytes_processed);
        let mut committed_error_count = error_count;
        let existing_error_bytes = std::fs::metadata(&error_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut committed_error_bytes = resume_checkpoint
            .as_ref()
            .and_then(|checkpoint| checkpoint.value.get("errorBytes"))
            .and_then(Value::as_u64)
            .unwrap_or(existing_error_bytes);
        truncate_error_writer(&mut error_writer, committed_error_bytes)?;
        let mut rows_processed = record.job.rows_processed;
        let mut error_artifact_needed =
            std::fs::metadata(&error_path).is_ok_and(|metadata| metadata.len() > 0);
        let result = if cancellation.is_cancelled() {
            self.checkpoint_import_stop(
                &record,
                &mut error_writer,
                &actual_source,
                &target_fingerprint,
                rows_processed,
                committed_bytes,
                committed_error_count,
                committed_error_bytes,
            )
            .await
        } else {
            let lease = context.connect().await?;
            let live = lease.live().sql()?;
            let mut execute_batches = async || -> AppResult<WorkerOutcome> {
                loop {
                    if cancellation.is_cancelled() {
                        return self
                            .checkpoint_import_stop(
                                &record,
                                &mut error_writer,
                                &actual_source,
                                &target_fingerprint,
                                rows_processed,
                                committed_bytes,
                                committed_error_count,
                                committed_error_bytes,
                            )
                            .await;
                    }
                    let effective_batch_size = if record.job.format.base() == JobFormat::Sql {
                        1
                    } else {
                        *batch_size as usize
                    };
                    let items = source.next_batch(effective_batch_size)?;
                    if items.is_empty() {
                        break;
                    }
                    let statements = build_import_statements(
                        engine,
                        target_relation.as_ref(),
                        target_metadata,
                        mapping,
                        validation,
                        &items,
                    );
                    let mut executable = Vec::new();
                    for (item, statement) in items.iter().zip(statements) {
                        match statement {
                            Ok(statement) => executable.push((item, statement)),
                            Err(message) => {
                                error_artifact_needed = true;
                                error_count += 1;
                                write_item_error(&mut error_writer, item, &message)?;
                                if validation.on_error == JobErrorPolicy::Stop
                                    || error_count >= validation.max_errors
                                {
                                    return Err(AppError::Blocked {
                                        reason:
                                            "import validation failed; see the error rows artifact"
                                                .into(),
                                    });
                                }
                            }
                        }
                    }
                    if !executable.is_empty() {
                        let sql = executable
                            .iter()
                            .map(|(_, statement)| statement.clone())
                            .collect::<Vec<_>>();
                        if let Err(batch_error) = execute_transaction(
                            &live.write_pool,
                            &sql,
                            claimed.grant(),
                            &cancellation,
                            record.job.format.base() == JobFormat::Sql,
                        )
                        .await
                        {
                            // An unacknowledged commit may already have reached the target.
                            // Retrying it row-by-row could duplicate data, so this state is
                            // terminal regardless of the configured validation policy.
                            if matches!(batch_error, AppError::OutcomeUnknown(_)) {
                                error_artifact_needed = true;
                                for (item, _) in &executable {
                                    write_item_error(
                                        &mut error_writer,
                                        item,
                                        &bounded_error(&batch_error),
                                    )?;
                                }
                                return Err(batch_error);
                            }
                            if cancellation.is_cancelled() {
                                return self
                                    .checkpoint_import_stop(
                                        &record,
                                        &mut error_writer,
                                        &actual_source,
                                        &target_fingerprint,
                                        rows_processed,
                                        committed_bytes,
                                        committed_error_count,
                                        committed_error_bytes,
                                    )
                                    .await;
                            }
                            if validation.on_error == JobErrorPolicy::Stop {
                                error_artifact_needed = true;
                                for (item, _) in &executable {
                                    write_item_error(
                                        &mut error_writer,
                                        item,
                                        &bounded_error(&batch_error),
                                    )?;
                                }
                                return Err(AppError::Blocked {
                                    reason: "import batch failed; see the error rows artifact"
                                        .into(),
                                });
                            }
                            let mut fallback_committed = false;
                            for (item, statement) in executable {
                                match execute_transaction(
                                    &live.write_pool,
                                    &[statement],
                                    claimed.grant(),
                                    &cancellation,
                                    false,
                                )
                                .await
                                {
                                    Ok(()) => fallback_committed = true,
                                    Err(row_error)
                                        if matches!(row_error, AppError::OutcomeUnknown(_)) =>
                                    {
                                        error_artifact_needed = true;
                                        write_item_error(
                                            &mut error_writer,
                                            item,
                                            &bounded_error(&row_error),
                                        )?;
                                        return Err(row_error);
                                    }
                                    Err(_) if cancellation.is_cancelled() && fallback_committed => {
                                        return Err(AppError::OutcomeUnknown(
                                        "import cancellation followed committed row fallbacks; automatic resume is unsafe"
                                            .into(),
                                    ));
                                    }
                                    Err(_) if cancellation.is_cancelled() => {
                                        return self
                                            .checkpoint_import_stop(
                                                &record,
                                                &mut error_writer,
                                                &actual_source,
                                                &target_fingerprint,
                                                rows_processed,
                                                committed_bytes,
                                                committed_error_count,
                                                committed_error_bytes,
                                            )
                                            .await;
                                    }
                                    Err(row_error) => {
                                        error_artifact_needed = true;
                                        error_count += 1;
                                        write_item_error(
                                            &mut error_writer,
                                            item,
                                            &bounded_error(&row_error),
                                        )?;
                                        if error_count >= validation.max_errors {
                                            return Err(AppError::Blocked {
                                            reason:
                                                "import error limit reached; see the error rows artifact"
                                                    .into(),
                                        });
                                        }
                                    }
                                }
                            }
                        }
                    }
                    rows_processed = rows_processed.saturating_add(items.len() as u64);
                    let bytes = source.bytes_consumed().unwrap_or(0);
                    error_writer.flush()?;
                    let error_bytes = error_writer.get_ref().metadata()?.len();
                    let checkpoint = record.job.resumable.then(|| Checkpoint {
                        source_fingerprint: actual_source.clone(),
                        target_fingerprint: target_fingerprint.clone(),
                        value: json!({
                            "bytesProcessed": bytes,
                            "errorBytes": error_bytes,
                            "errors": error_count,
                            "rowsProcessed": rows_processed,
                        }),
                    });
                    let updated = self
                        .repository
                        .update_progress(record.job.id, rows_processed, bytes, checkpoint)
                        .await?;
                    self.emit(&updated.job);
                    committed_bytes = bytes;
                    committed_error_count = error_count;
                    committed_error_bytes = error_bytes;
                }
                Ok(WorkerOutcome::Succeeded)
            };
            execute_batches().await
        };
        finalize_error_writer(error_writer)?;
        if !matches!(&result, Ok(WorkerOutcome::Paused)) {
            if error_artifact_needed {
                let size = file_len(&error_path)?;
                let hash = file_sha256(&error_path)?;
                self.repository
                    .record_artifact(record.job.id, "error_rows", &error_path, size, &hash)
                    .await?;
            } else {
                let _ = std::fs::remove_file(&error_path);
            }
        }
        if matches!(&result, Ok(WorkerOutcome::Succeeded)) {
            let size = capability
                .size_bytes
                .unwrap_or_else(|| file_len(&capability.path).unwrap_or(0));
            let _ = self
                .repository
                .update_progress(record.job.id, rows_processed, size, None)
                .await;
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn checkpoint_import_stop(
        &self,
        record: &JobRecord,
        error_writer: &mut BufWriter<File>,
        source_fingerprint: &str,
        target_fingerprint: &str,
        rows_processed: u64,
        bytes_processed: u64,
        error_count: u64,
        error_bytes: u64,
    ) -> AppResult<WorkerOutcome> {
        truncate_error_writer(error_writer, error_bytes)?;
        let checkpoint = record.job.resumable.then(|| Checkpoint {
            source_fingerprint: source_fingerprint.to_owned(),
            target_fingerprint: target_fingerprint.to_owned(),
            value: json!({
                "bytesProcessed": bytes_processed,
                "errorBytes": error_bytes,
                "errors": error_count,
                "rowsProcessed": rows_processed,
            }),
        });
        let updated = self
            .repository
            .update_progress(record.job.id, rows_processed, bytes_processed, checkpoint)
            .await?;
        self.emit(&updated.job);
        self.stop_outcome(record.job.id).await
    }

    async fn stop_outcome(&self, job_id: Uuid) -> AppResult<WorkerOutcome> {
        let current = self.repository.get_unscoped(job_id).await?;
        match current.job.state {
            JobState::Running | JobState::PauseRequested => Ok(WorkerOutcome::Paused),
            JobState::CancelRequested => Ok(WorkerOutcome::Cancelled),
            JobState::Paused => Ok(WorkerOutcome::Paused),
            _ => Err(AppError::Blocked {
                reason: "job stop request no longer matches its lifecycle state".into(),
            }),
        }
    }

    async fn retain_export_partial(&self, record: &JobRecord) -> AppResult<()> {
        let JobPlan::Export { capability_id, .. } = &record.plan else {
            return Ok(());
        };
        let context = self
            .connections
            .pin(record.job.connection_id, ConnectionAccess::Read)
            .await?;
        ensure_record_scope(record, context.pin())?;
        let capability = self
            .repository
            .resolve_capability(
                context.pin(),
                *capability_id,
                JobFileDirection::Output,
                Some(record.job.id),
            )
            .await?;
        let partial = partial_path(&capability.path, record.job.id)?;
        let size = match std::fs::metadata(&partial) {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => metadata.len(),
            _ => return Ok(()),
        };
        let sha256 = file_sha256(&partial)?;
        self.repository
            .record_artifact(record.job.id, "partial", &partial, size, &sha256)
            .await
    }

    fn emit(&self, job: &super::model::Job) {
        let _ = self.events.send(JobChangedEvent {
            connection_id: job.connection_id,
            job_id: job.id,
            state: job.state,
            rows_processed: job.rows_processed,
            bytes_processed: job.bytes_processed,
        });
    }
}

fn verify_operation(record: &JobRecord, claimed: &ClaimedOperation) -> AppResult<()> {
    let operation = claimed.record();
    let expected_kind = match record.job.kind {
        super::model::JobKind::Import => dopedb_protocol::OperationKind::Import,
        super::model::JobKind::Export => dopedb_protocol::OperationKind::Export,
    };
    let matches = operation.id == record.job.operation_id
        && operation.connection_id == record.job.connection_id
        && operation.workspace_id == record.workspace_id
        && operation.account_scope == record.account_scope
        && operation.kind == expected_kind
        && operation
            .payload
            .get("jobId")
            .and_then(Value::as_str)
            .is_some_and(|value| value == record.job.id.to_string())
        && operation.payload.get("planHash").and_then(Value::as_str)
            == Some(record.plan_hash.as_str())
        && claimed.grant().operation_id() == operation.id
        && claimed.grant().connection_id() == operation.connection_id;
    if matches {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "job projection does not match its approved immutable operation".into(),
        })
    }
}

fn ensure_record_scope(record: &JobRecord, pin: &crate::store::PinnedConnection) -> AppResult<()> {
    if record.workspace_id == pin.scope.workspace_id
        && record.account_scope == pin.scope.account_scope.storage_key()
        && record.job.connection_id == pin.connection_id
    {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "job belongs to a different workspace or account scope".into(),
        })
    }
}

fn find_relation<'a>(
    snapshot: &'a CatalogSnapshot,
    reference: &ObjectRef,
) -> AppResult<&'a dopedb_protocol::Relation> {
    snapshot
        .relations()
        .iter()
        .find(|relation| {
            relation.object.catalog == reference.catalog
                && relation.object.namespace == reference.namespace
                && relation.object.name == reference.name
                && relation.object.kind == reference.kind
        })
        .ok_or_else(|| AppError::Blocked {
            reason: "job relation is missing from the current catalog".into(),
        })
}

fn validate_columns(columns: &[String], available: &[&str]) -> AppResult<()> {
    let mut seen = std::collections::HashSet::new();
    if columns.iter().any(|column| {
        column.is_empty() || !available.contains(&column.as_str()) || !seen.insert(column)
    }) {
        return Err(AppError::Config(
            "job columns contain an unknown, empty, or duplicate name".into(),
        ));
    }
    Ok(())
}

fn export_field_names(columns: &[String], mappings: &[JobFieldMapping]) -> AppResult<Vec<String>> {
    if mappings.is_empty() {
        return Ok(columns.to_vec());
    }
    let mappings = mappings
        .iter()
        .map(|mapping| (mapping.source.as_str(), mapping.target.as_str()))
        .collect::<HashMap<_, _>>();
    let output = columns
        .iter()
        .map(|column| {
            mappings
                .get(column.as_str())
                .copied()
                .unwrap_or(column)
                .to_owned()
        })
        .collect::<Vec<_>>();
    let mut unique = std::collections::HashSet::new();
    if output.iter().any(|column| !unique.insert(column)) {
        return Err(AppError::Config(
            "export field mapping creates duplicate names".into(),
        ));
    }
    Ok(output)
}

async fn count_rows(
    live: &crate::connection::LiveConnection,
    engine: Engine,
    table_sql: &str,
    job_id: Uuid,
) -> AppResult<u64> {
    let result = crate::executor::read::run_read_byte_capped(
        live,
        engine,
        &format!("SELECT COUNT(*) AS n FROM {table_sql}"),
        1,
        64 * 1024,
        Some(job_id),
    )
    .await?;
    let value = result
        .rows
        .first()
        .and_then(|row| row.first())
        .ok_or_else(|| AppError::Config("export count returned no value".into()))?;
    match value {
        Value::Number(value) => value
            .as_u64()
            .ok_or_else(|| AppError::Config("export count is invalid".into())),
        Value::String(value) => value
            .parse()
            .map_err(|_| AppError::Config("export count is invalid".into())),
        _ => Err(AppError::Config("export count is invalid".into())),
    }
}

fn validate_export_checkpoint(
    checkpoint: Option<&Checkpoint>,
    source_fingerprint: &str,
    target_fingerprint: Option<&str>,
) -> AppResult<()> {
    let checkpoint = checkpoint.ok_or_else(|| AppError::Blocked {
        reason: "resumable export has no durable checkpoint".into(),
    })?;
    if checkpoint.source_fingerprint != source_fingerprint
        || target_fingerprint != Some(checkpoint.target_fingerprint.as_str())
    {
        return Err(AppError::Blocked {
            reason: "export source schema or partial output changed after the checkpoint".into(),
        });
    }
    Ok(())
}

fn validate_checkpoint_counters(checkpoint: &Checkpoint, record: &JobRecord) -> AppResult<()> {
    let rows = checkpoint
        .value
        .get("rowsProcessed")
        .and_then(Value::as_u64);
    let bytes = checkpoint
        .value
        .get("bytesProcessed")
        .and_then(Value::as_u64);
    if rows != Some(record.job.rows_processed) || bytes != Some(record.job.bytes_processed) {
        return Err(AppError::Blocked {
            reason: "job progress no longer matches its latest durable checkpoint".into(),
        });
    }
    Ok(())
}

fn validate_import_checkpoint(
    checkpoint: Option<&Checkpoint>,
    source_fingerprint: &str,
    target_fingerprint: &str,
) -> AppResult<()> {
    let checkpoint = checkpoint.ok_or_else(|| AppError::Blocked {
        reason: "resumable import has no durable checkpoint".into(),
    })?;
    if checkpoint.source_fingerprint != source_fingerprint
        || checkpoint.target_fingerprint != target_fingerprint
    {
        return Err(AppError::Blocked {
            reason: "import source file or target schema changed after the checkpoint".into(),
        });
    }
    Ok(())
}

fn build_import_statements(
    engine: Engine,
    target: Option<&ObjectRef>,
    target_metadata: Option<&dopedb_protocol::Relation>,
    mappings: &[JobFieldMapping],
    validation: &JobValidation,
    items: &[ImportItem],
) -> Vec<Result<String, String>> {
    items
        .iter()
        .map(|item| match item {
            ImportItem::Sql { statement, .. } => match crate::safety::classify(statement, engine) {
                Ok(classification) if classification.kind != crate::model::QueryKind::Privilege => {
                    Ok(statement.clone())
                }
                Ok(_) => Err("arbitrary privilege statements are blocked in SQL imports".into()),
                Err(error) => Err(format!("SQL statement failed safety inspection: {error}")),
            },
            ImportItem::Data(row) => build_insert(
                engine,
                target.ok_or_else(|| "target relation is missing".to_owned())?,
                target_metadata.ok_or_else(|| "target metadata is missing".to_owned())?,
                mappings,
                validation,
                row,
            ),
        })
        .collect()
}

fn build_insert(
    engine: Engine,
    target: &ObjectRef,
    target_metadata: &dopedb_protocol::Relation,
    mappings: &[JobFieldMapping],
    validation: &JobValidation,
    row: &ImportDataRow,
) -> Result<String, String> {
    let effective = if mappings.is_empty() {
        target_metadata
            .columns
            .iter()
            .filter(|column| row.values.contains_key(&column.name))
            .map(|column| JobFieldMapping {
                source: column.name.clone(),
                target: column.name.clone(),
                required: false,
            })
            .collect::<Vec<_>>()
    } else {
        mappings.to_vec()
    };
    if effective.is_empty() {
        return Err("no input fields map to target columns".into());
    }
    let available = target_metadata
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<Vec<_>>();
    let mut columns = Vec::with_capacity(effective.len());
    let mut values = Vec::with_capacity(effective.len());
    for mapping in effective {
        if !available.contains(&mapping.target.as_str()) {
            return Err(format!("unknown target column `{}`", mapping.target));
        }
        let mut value = row
            .values
            .get(&mapping.source)
            .cloned()
            .unwrap_or(Value::Null);
        if let Value::String(text) = &value {
            if validation.null_values.iter().any(|null| null == text) {
                value = Value::Null;
            }
        }
        if mapping.required && value.is_null() {
            return Err(format!("required field `{}` is missing", mapping.source));
        }
        columns.push(quote_identifier(engine, &mapping.target));
        let family = target_metadata
            .columns
            .iter()
            .find(|column| column.name == mapping.target)
            .map(|column| column.type_family)
            .unwrap_or(NormalizedTypeFamily::Other);
        values.push(typed_sql_literal(engine, family, &value)?);
    }
    Ok(format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quoted_relation(engine, target),
        columns.join(", "),
        values.join(", ")
    ))
}

async fn execute_transaction(
    pool: &DbPool,
    statements: &[String],
    grant: &ExecutionGrant,
    cancellation: &CancellationToken,
    conservative_statement_outcome: bool,
) -> AppResult<()> {
    if statements.is_empty() {
        return Ok(());
    }
    if grant.connection_id() == Uuid::nil() {
        return Err(AppError::Blocked {
            reason: "import execution grant has no connection".into(),
        });
    }
    macro_rules! execute {
        ($pool:expr) => {{
            let mut transaction = tokio::select! {
                result = tokio::time::timeout(
                    crate::executor::cancel::QUERY_TIMEOUT,
                    $pool.begin(),
                ) => match result {
                    Ok(Ok(transaction)) => transaction,
                    Ok(Err(error)) => return Err(error.into()),
                    Err(_) => return Err(AppError::Blocked {
                        reason: "import transaction start timed out".into(),
                    }),
                },
                _ = cancellation.cancelled() => return Err(AppError::Blocked {
                    reason: "import transaction was cancelled before it started".into(),
                }),
            };
            for statement in statements {
                let result = tokio::select! {
                    result = tokio::time::timeout(
                        crate::executor::cancel::QUERY_TIMEOUT,
                        sqlx::query(AssertSqlSafe(statement.as_str()))
                            .execute(&mut *transaction),
                    ) => result,
                    _ = cancellation.cancelled() => {
                        if conservative_statement_outcome {
                            return Err(AppError::OutcomeUnknown(
                                "SQL import statement acknowledgement was interrupted by cancellation".into(),
                            ));
                        }
                        return Err(AppError::Blocked {
                            reason: "import transaction was cancelled and rolled back".into(),
                        });
                    },
                };
                match result {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => return Err(error.into()),
                    Err(_) if conservative_statement_outcome => return Err(
                        AppError::OutcomeUnknown(
                            "SQL import statement acknowledgement timed out".into(),
                        ),
                    ),
                    Err(_) => return Err(AppError::Blocked {
                        reason: "import statement timed out and was rolled back".into(),
                    }),
                }
            }
            let commit = transaction.commit();
            tokio::select! {
                result = tokio::time::timeout(
                    crate::executor::cancel::QUERY_TIMEOUT,
                    commit,
                ) => match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => return Err(AppError::OutcomeUnknown(format!(
                        "import commit acknowledgement failed: {error}"
                    ))),
                    Err(_) => return Err(AppError::OutcomeUnknown(
                        "import commit acknowledgement timed out".into(),
                    )),
                },
                _ = cancellation.cancelled() => return Err(AppError::OutcomeUnknown(
                    "import commit acknowledgement was interrupted by cancellation".into(),
                )),
            }
        }};
    }
    match pool {
        DbPool::Postgres(pool) => execute!(pool),
        DbPool::Mysql(pool) => execute!(pool),
        DbPool::Sqlite(pool) => execute!(pool),
    }
    Ok(())
}

fn write_item_error(writer: &mut BufWriter<File>, item: &ImportItem, error: &str) -> AppResult<()> {
    match item {
        ImportItem::Data(row) => write_error_row(writer, row.source_line, &row.raw, error),
        ImportItem::Sql {
            source_line,
            statement,
        } => write_error_row(
            writer,
            *source_line,
            &json!({
                "statementSha256": hex::encode(Sha256::digest(statement.as_bytes())),
            }),
            error,
        ),
    }
}

fn truncate_error_writer(writer: &mut BufWriter<File>, length: u64) -> AppResult<()> {
    writer.flush()?;
    writer.get_mut().set_len(length)?;
    writer.seek(SeekFrom::Start(length))?;
    Ok(())
}

fn bounded_error(error: &AppError) -> String {
    let value = error.to_string();
    value.chars().take(1_000).collect()
}

fn quoted_relation(engine: Engine, relation: &ObjectRef) -> String {
    let name = quote_identifier(engine, &relation.name);
    match relation.namespace.as_deref() {
        Some(namespace) if !namespace.is_empty() && engine != Engine::Sqlite => {
            format!("{}.{}", quote_identifier(engine, namespace), name)
        }
        _ => name,
    }
}

fn quote_identifier(engine: Engine, value: &str) -> String {
    if engine == Engine::Mysql {
        format!("`{}`", value.replace('`', "``"))
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
}

fn partial_path(path: &Path, job_id: Uuid) -> AppResult<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Config("output path has no parent directory".into()))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Config("output filename is invalid".into()))?;
    Ok(parent.join(format!(".{name}.dopedb-{job_id}.part")))
}

fn finalize_output(partial: &Path, output: &Path) -> AppResult<()> {
    validate_output_parent(output)?;
    if std::fs::symlink_metadata(output)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || metadata.is_dir())
    {
        return Err(AppError::Blocked {
            reason: "output destination changed to a symlink or directory".into(),
        });
    }
    replace_file(partial, output).map_err(|error| {
        AppError::Config(format!(
            "could not atomically publish the output file; the partial file was retained: {error}"
        ))
    })?;
    #[cfg(unix)]
    if let Some(parent) = output.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn validate_output_parent(output: &Path) -> AppResult<()> {
    let parent = output
        .parent()
        .ok_or_else(|| AppError::Config("output path has no parent directory".into()))?;
    let canonical = parent.canonicalize()?;
    if canonical != parent || !std::fs::symlink_metadata(parent)?.is_dir() {
        return Err(AppError::Blocked {
            reason: "output directory changed after the file permission was issued".into(),
        });
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(partial: &Path, output: &Path) -> std::io::Result<()> {
    std::fs::rename(partial, output)
}

#[cfg(windows)]
fn replace_file(partial: &Path, output: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let partial = partial
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let output = output
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            partial.as_ptr(),
            output.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn error_artifact_path(job_id: Uuid) -> AppResult<PathBuf> {
    let directory = dirs::data_dir()
        .ok_or_else(|| AppError::Config("no OS data directory".into()))?
        .join("dopedb")
        .join("job-artifacts");
    std::fs::create_dir_all(&directory)?;
    let metadata = std::fs::symlink_metadata(&directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "job artifact storage is not a regular app-owned directory".into(),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(directory.join(format!("{job_id}.errors.ndjson")))
}

fn file_len(path: &Path) -> AppResult<u64> {
    Ok(std::fs::metadata(path)?.len())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn output_parent_must_remain_the_original_canonical_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let actual = root.path().join("actual");
        let alias = root.path().join("alias");
        std::fs::create_dir(&actual).unwrap();
        symlink(&actual, &alias).unwrap();
        let actual = actual.canonicalize().unwrap();
        assert!(validate_output_parent(&actual.join("rows.ndjson")).is_ok());
        assert!(matches!(
            validate_output_parent(&alias.join("rows.ndjson")),
            Err(AppError::Blocked { .. })
        ));
    }
}
