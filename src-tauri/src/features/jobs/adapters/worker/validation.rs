use std::collections::{HashMap, HashSet};

use dopedb_protocol::{CatalogSnapshot, ObjectRef};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::features::jobs::{JobFieldMapping, JobKind};
use crate::operations::ClaimedOperation;

use super::super::super::ports::{Checkpoint, JobAuthority, JobRecord};

pub(super) fn verify_operation(record: &JobRecord, claimed: &ClaimedOperation) -> AppResult<()> {
    let operation = claimed.record();
    let expected_kind = match record.job.kind {
        JobKind::Import => dopedb_protocol::OperationKind::Import,
        JobKind::Export => dopedb_protocol::OperationKind::Export,
    };
    let matches = operation.id == uuid::Uuid::from(record.job.operation_id)
        && operation.connection_id == uuid::Uuid::from(record.job.connection_id)
        && operation.workspace_id == uuid::Uuid::from(record.workspace_id)
        && operation.account_scope == record.account_scope.as_str()
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

pub(super) fn ensure_record_scope(record: &JobRecord, authority: &JobAuthority) -> AppResult<()> {
    if record.workspace_id == authority.resource.workspace_id
        && record.account_scope == authority.account_scope
        && record.job.connection_id == authority.resource.connection_id
    {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "job belongs to a different workspace or account scope".into(),
        })
    }
}

pub(super) fn find_relation<'a>(
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

pub(super) fn validate_columns(columns: &[String], available: &[&str]) -> AppResult<()> {
    let mut seen = HashSet::new();
    if columns.iter().any(|column| {
        column.is_empty() || !available.contains(&column.as_str()) || !seen.insert(column)
    }) {
        return Err(AppError::Config(
            "job columns contain an unknown, empty, or duplicate name".into(),
        ));
    }
    Ok(())
}

pub(super) fn export_field_names(
    columns: &[String],
    mappings: &[JobFieldMapping],
) -> AppResult<Vec<String>> {
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
    let mut unique = HashSet::new();
    if output.iter().any(|column| !unique.insert(column)) {
        return Err(AppError::Config(
            "export field mapping creates duplicate names".into(),
        ));
    }
    Ok(output)
}

pub(super) fn validate_export_checkpoint(
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

pub(super) fn validate_checkpoint_counters(
    checkpoint: &Checkpoint,
    record: &JobRecord,
) -> AppResult<()> {
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

pub(super) fn validate_import_checkpoint(
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
