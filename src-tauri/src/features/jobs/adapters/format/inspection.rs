use std::io::Cursor;
use std::path::Path;

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::features::jobs::{JobFormat, JobInputInspection};
use crate::model::QueryKind;

use super::super::super::ports::{InputReview, SqlImportAudit};
use super::import::{ImportItem, ImportSource};
use super::{MAX_DOCUMENT_INPUT_BYTES, MAX_XLSX_ENTRIES};

#[cfg(test)]
pub(in crate::features::jobs) fn inspect_input(
    path: &Path,
    format: JobFormat,
    engine: crate::model::Engine,
) -> AppResult<JobInputInspection> {
    let mut source = ImportSource::open(path, format, 0, engine)?;
    inspect_source(&mut source, format)
}

pub(in crate::features::jobs) fn inspect_input_verified(
    path: &Path,
    format: JobFormat,
    engine: crate::model::Engine,
    expected_sha256: &str,
) -> AppResult<JobInputInspection> {
    let (mut source, _) = ImportSource::open_verified(path, format, 0, engine, expected_sha256)?;
    inspect_source(&mut source, format)
}

fn inspect_source(source: &mut ImportSource, format: JobFormat) -> AppResult<JobInputInspection> {
    let item_count = source.item_count();
    let mut fields = source.declared_fields();
    // SQL has no row preview. Keeping its statement stream untouched lets the
    // exact inspection and safety audit share one verified file handle.
    let sample_items = if format.base() == JobFormat::Sql {
        Vec::new()
    } else {
        source.next_batch(5)?
    };
    if fields.is_empty() && format.base() != JobFormat::Sql {
        for item in &sample_items {
            if let ImportItem::Data(row) = item {
                fields.extend(row.values.keys().cloned());
            }
        }
    }
    fields.sort();
    fields.dedup();
    let mut warnings = Vec::new();
    let resumable = format.resumable() && format.base() != JobFormat::Sql;
    if !resumable {
        warnings.push(
            "This format cannot resume after interruption; cancellation keeps no restart point."
                .into(),
        );
    }
    if format.base() == JobFormat::Sql {
        warnings.push(
            "SQL import executes an exact hash-pinned script and always requires critical approval."
                .into(),
        );
    }
    Ok(JobInputInspection {
        fields,
        item_count,
        sample_rows: sample_items
            .into_iter()
            .filter_map(|item| match item {
                ImportItem::Data(row) => Some(bounded_preview(row.raw, 0)),
                ImportItem::Sql { .. } => None,
            })
            .collect(),
        resumable,
        warnings,
    })
}

fn bounded_preview(value: Value, depth: usize) -> Value {
    if depth >= 4 {
        return Value::String("<nested value>".into());
    }
    match value {
        Value::String(value) => Value::String(value.chars().take(512).collect()),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .take(16)
                .map(|value| bounded_preview(value, depth + 1))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .take(64)
                .map(|(key, value)| (key, bounded_preview(value, depth + 1)))
                .collect(),
        ),
        value => value,
    }
}

pub(in crate::features::jobs) fn review_input_verified(
    path: &Path,
    format: JobFormat,
    engine: crate::model::Engine,
    expected_sha256: &str,
) -> AppResult<InputReview> {
    let (mut source, _) = ImportSource::open_verified(path, format, 0, engine, expected_sha256)?;
    let inspection = inspect_source(&mut source, format)?;
    let sql_audit = if format.base() == JobFormat::Sql {
        Some(audit_sql_source(source, engine)?)
    } else {
        None
    };
    Ok(InputReview {
        inspection,
        sql_audit,
    })
}

#[cfg(test)]
pub(in crate::features::jobs) fn audit_sql_import(
    path: &Path,
    format: JobFormat,
    engine: crate::model::Engine,
) -> AppResult<SqlImportAudit> {
    let source = ImportSource::open(path, format, 0, engine)?;
    audit_sql_source(source, engine)
}

fn audit_sql_source(
    source: ImportSource,
    engine: crate::model::Engine,
) -> AppResult<SqlImportAudit> {
    let ImportSource::Sql { statements, .. } = source else {
        return Err(AppError::Config(
            "SQL import audit requires a SQL file format".into(),
        ));
    };
    if statements.is_empty() {
        return Err(AppError::Config(
            "SQL import contains no executable statements".into(),
        ));
    }
    let mut audit = SqlImportAudit {
        statement_count: statements.len() as u64,
        read_count: 0,
        write_count: 0,
        ddl_count: 0,
    };
    for statement in statements {
        match crate::safety::classify(&statement, engine)?.kind {
            QueryKind::Read => audit.read_count += 1,
            QueryKind::Write => audit.write_count += 1,
            QueryKind::Ddl => audit.ddl_count += 1,
            QueryKind::Privilege => {
                return Err(AppError::Blocked {
                    reason:
                        "SQL imports cannot contain arbitrary privilege statements; use a supported administrative action"
                            .into(),
                })
            }
        }
    }
    Ok(audit)
}

pub(super) fn validate_xlsx_archive(bytes: &[u8]) -> AppResult<()> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| AppError::Config(format!("XLSX archive is invalid: {error}")))?;
    if archive.len() > MAX_XLSX_ENTRIES {
        return Err(AppError::Blocked {
            reason: "XLSX archive contains too many entries".into(),
        });
    }
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| AppError::Config(format!("XLSX archive is invalid: {error}")))?;
        if entry.enclosed_name().is_none() {
            return Err(AppError::Blocked {
                reason: "XLSX archive contains an unsafe path".into(),
            });
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or_else(|| AppError::Blocked {
                reason: "XLSX expanded size is invalid".into(),
            })?;
        if expanded > MAX_DOCUMENT_INPUT_BYTES {
            return Err(AppError::Blocked {
                reason: "XLSX expanded content exceeds the 512 MiB safety limit".into(),
            });
        }
    }
    Ok(())
}
