//! Pure job-plan validation against one immutable catalog snapshot.

use dopedb_protocol::catalog::{CatalogSnapshot, ObjectRef, Relation};

use crate::error::{AppError, AppResult};

use super::domain::{CreateJobRequest, JobErrorPolicy, JobFieldMapping, JobFormat, JobPlan};

pub(crate) fn valid_sha256_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn validate_plan(
    request: &CreateJobRequest,
    snapshot: &CatalogSnapshot,
) -> AppResult<()> {
    if !(100..=10_000).contains(&request.plan.batch_size()) {
        return Err(AppError::Config(
            "job batch size must be between 100 and 10,000".into(),
        ));
    }
    match &request.plan {
        JobPlan::Export {
            relation,
            columns,
            field_names,
            ..
        } => {
            let metadata = relation_in_snapshot(snapshot, relation)?;
            let available = metadata
                .columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>();
            validate_named_columns(columns, &available)?;
            validate_mapping(field_names, Some(&available))?;
        }
        JobPlan::Import {
            target_relation,
            mapping,
            validation,
            ..
        } => {
            if validation.max_errors == 0 || validation.max_errors > 1_000_000 {
                return Err(AppError::Config(
                    "import max errors must be between 1 and 1,000,000".into(),
                ));
            }
            if request.format.base() == JobFormat::Sql {
                if target_relation.is_some() || !mapping.is_empty() {
                    return Err(AppError::Config(
                        "SQL import does not accept a target or field mapping".into(),
                    ));
                }
                if validation.on_error != JobErrorPolicy::Stop {
                    return Err(AppError::Config(
                        "SQL import must stop on the first failed statement".into(),
                    ));
                }
            } else {
                let target = target_relation.as_ref().ok_or_else(|| {
                    AppError::Config("structured import requires a target relation".into())
                })?;
                let metadata = relation_in_snapshot(snapshot, target)?;
                let available = metadata
                    .columns
                    .iter()
                    .map(|column| column.name.as_str())
                    .collect::<Vec<_>>();
                validate_mapping(mapping, Some(&available))?;
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_mapping_sources(
    mapping: &[JobFieldMapping],
    available: &[String],
) -> AppResult<()> {
    if mapping
        .iter()
        .any(|field| !available.contains(&field.source))
    {
        return Err(AppError::Config(
            "field mapping contains a source that is not present in the selected file".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_required_target_columns(
    plan: &JobPlan,
    snapshot: &CatalogSnapshot,
    source_fields: &[String],
) -> AppResult<()> {
    let JobPlan::Import {
        target_relation: Some(target),
        mapping,
        ..
    } = plan
    else {
        return Ok(());
    };
    let relation = relation_in_snapshot(snapshot, target)?;
    let mapped_targets = if mapping.is_empty() {
        source_fields.iter().map(String::as_str).collect::<Vec<_>>()
    } else {
        mapping
            .iter()
            .map(|field| field.target.as_str())
            .collect::<Vec<_>>()
    };
    let missing = relation
        .columns
        .iter()
        .filter(|column| {
            !column.nullable
                && column.default_expression.is_none()
                && column.generated_expression.is_none()
                && !column.identity
                && !column.auto_increment
                && !mapped_targets.contains(&column.name.as_str())
        })
        .map(|column| column.name.clone())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(AppError::Config(format!(
            "import mapping is missing required target columns: {}",
            missing.join(", ")
        )))
    }
}

pub(crate) fn summaries(plan: &JobPlan, capability_name: &str) -> (String, String) {
    match plan {
        JobPlan::Export { relation, .. } => (relation_label(relation), capability_name.to_owned()),
        JobPlan::Import {
            target_relation, ..
        } => (
            capability_name.to_owned(),
            target_relation
                .as_ref()
                .map(relation_label)
                .unwrap_or_else(|| "SQL script".into()),
        ),
    }
}

fn relation_in_snapshot<'a>(
    snapshot: &'a CatalogSnapshot,
    reference: &ObjectRef,
) -> AppResult<&'a Relation> {
    snapshot
        .relations()
        .iter()
        .find(|relation| relation.object == *reference)
        .ok_or_else(|| AppError::Blocked {
            reason: "job relation is missing from the current catalog".into(),
        })
}

fn validate_named_columns(columns: &[String], available: &[&str]) -> AppResult<()> {
    let mut unique = std::collections::HashSet::new();
    if columns.iter().any(|column| {
        column.trim().is_empty() || !available.contains(&column.as_str()) || !unique.insert(column)
    }) {
        return Err(AppError::Config(
            "job columns contain an unknown, empty, or duplicate name".into(),
        ));
    }
    Ok(())
}

fn validate_mapping(
    mapping: &[JobFieldMapping],
    available_targets: Option<&[&str]>,
) -> AppResult<()> {
    let mut sources = std::collections::HashSet::new();
    let mut targets = std::collections::HashSet::new();
    if mapping.iter().any(|field| {
        field.source.trim().is_empty()
            || field.target.trim().is_empty()
            || !sources.insert(&field.source)
            || !targets.insert(&field.target)
            || available_targets
                .is_some_and(|available| !available.contains(&field.target.as_str()))
    }) {
        return Err(AppError::Config(
            "field mapping contains an unknown, empty, or duplicate field".into(),
        ));
    }
    Ok(())
}

fn relation_label(reference: &ObjectRef) -> String {
    reference
        .namespace
        .as_ref()
        .map(|namespace| format!("{namespace}.{}", reference.name))
        .unwrap_or_else(|| reference.name.clone())
}
