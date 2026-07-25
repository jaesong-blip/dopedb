//! Fail-closed validation for Catalog-pinned schema-change requests.

use dopedb_protocol::{
    CatalogSnapshot, Constraint, ConstraintKind, Index, ObjectKind, ObjectRef, SchemaChange,
    SchemaChangeRequest, DDL_IR_SCHEMA_VERSION,
};

use crate::error::{AppError, AppResult};

pub(super) fn request(snapshot: &CatalogSnapshot, request: &SchemaChangeRequest) -> AppResult<()> {
    snapshot
        .validate()
        .map_err(|_| AppError::Config("invalid Catalog V2 snapshot".into()))?;
    if request.schema_version != DDL_IR_SCHEMA_VERSION {
        return Err(AppError::Blocked {
            reason: format!(
                "unsupported DDL IR version {}; expected {}",
                request.schema_version, DDL_IR_SCHEMA_VERSION
            ),
        });
    }
    if request.catalog_fingerprint != snapshot.fingerprint() {
        return Err(AppError::Blocked {
            reason: "the schema changed after this edit was created; refresh and review it again"
                .into(),
        });
    }
    validate_object_ref(request.change.relation())?;
    match &request.change {
        SchemaChange::CreateTable { table } => {
            if table.relation.kind != ObjectKind::Table {
                return blocked("only table objects can be created by relational DDL");
            }
            if find_relation(snapshot, &table.relation).is_some() {
                return blocked("a relation with this name already exists");
            }
            if table.columns.is_empty() {
                return blocked("a new table must contain at least one column");
            }
            unique_names(
                table.columns.iter().map(|column| column.name.as_str()),
                "column",
            )?;
            for column in &table.columns {
                validate_identifier(&column.name, "column")?;
                validate_fragment(&column.native_type, "column type")?;
                optional_fragment(
                    column.default_expression.as_deref(),
                    "column default expression",
                )?;
                optional_fragment(
                    column.generated_expression.as_deref(),
                    "generated expression",
                )?;
                if column.identity && column.auto_increment {
                    return blocked("identity and auto-increment cannot both be enabled");
                }
            }
            unique_names(
                table
                    .constraints
                    .iter()
                    .map(|constraint| constraint.name.as_str()),
                "constraint",
            )?;
            unique_names(
                table.indexes.iter().map(|index| index.name.as_str()),
                "index",
            )?;
            for constraint in &table.constraints {
                validate_constraint(constraint)?;
                validate_constraint_columns(
                    snapshot,
                    constraint,
                    &table.relation,
                    &table
                        .columns
                        .iter()
                        .map(|column| column.name.as_str())
                        .collect::<Vec<_>>(),
                )?;
            }
            for index in &table.indexes {
                validate_index(index)?;
                validate_index_columns(
                    index,
                    &table
                        .columns
                        .iter()
                        .map(|column| column.name.as_str())
                        .collect::<Vec<_>>(),
                )?;
            }
        }
        SchemaChange::DropTable { relation } => {
            require_relation(snapshot, relation)?;
        }
        SchemaChange::RenameTable { relation, new_name } => {
            require_relation(snapshot, relation)?;
            validate_identifier(new_name, "new table name")?;
            let mut target = relation.clone();
            target.name.clone_from(new_name);
            if find_relation(snapshot, &target).is_some() {
                return blocked("the renamed relation would collide with an existing object");
            }
        }
        SchemaChange::AddColumn { relation, column } => {
            let current = require_relation(snapshot, relation)?;
            validate_identifier(&column.name, "column")?;
            validate_fragment(&column.native_type, "column type")?;
            optional_fragment(
                column.default_expression.as_deref(),
                "column default expression",
            )?;
            optional_fragment(
                column.generated_expression.as_deref(),
                "generated expression",
            )?;
            if column.identity && column.auto_increment {
                return blocked("identity and auto-increment cannot both be enabled");
            }
            if current
                .columns
                .iter()
                .any(|value| value.name == column.name)
            {
                return blocked("the column already exists");
            }
        }
        SchemaChange::AlterColumn {
            relation,
            column,
            alteration,
        } => {
            let current = require_relation(snapshot, relation)?;
            validate_identifier(column, "column")?;
            if !current.columns.iter().any(|value| value.name == *column) {
                return blocked("the column no longer exists");
            }
            if alteration.new_name.is_none()
                && alteration.native_type.is_none()
                && alteration.nullable.is_none()
                && matches!(alteration.default, dopedb_protocol::DefaultChange::Keep)
            {
                return blocked("the column alteration contains no changes");
            }
            if let Some(name) = &alteration.new_name {
                validate_identifier(name, "new column name")?;
                if name != column && current.columns.iter().any(|value| value.name == *name) {
                    return blocked("the renamed column would collide with an existing column");
                }
            }
            optional_fragment(alteration.native_type.as_deref(), "column type")?;
            if let dopedb_protocol::DefaultChange::Set { expression } = &alteration.default {
                validate_fragment(expression, "column default expression")?;
            }
        }
        SchemaChange::DropColumn { relation, column } => {
            let current = require_relation(snapshot, relation)?;
            validate_identifier(column, "column")?;
            if current.columns.len() <= 1 {
                return blocked("the last remaining column cannot be dropped");
            }
            if !current.columns.iter().any(|value| value.name == *column) {
                return blocked("the column no longer exists");
            }
        }
        SchemaChange::AddConstraint {
            relation,
            constraint,
        } => {
            let current = require_relation(snapshot, relation)?;
            validate_constraint(constraint)?;
            validate_constraint_columns(
                snapshot,
                constraint,
                &current.object,
                &current
                    .columns
                    .iter()
                    .map(|column| column.name.as_str())
                    .collect::<Vec<_>>(),
            )?;
            if current
                .constraints
                .iter()
                .any(|value| value.name == constraint.name)
            {
                return blocked("the constraint already exists");
            }
        }
        SchemaChange::DropConstraint { relation, name } => {
            let current = require_relation(snapshot, relation)?;
            validate_identifier(name, "constraint")?;
            if !current.constraints.iter().any(|value| value.name == *name) {
                return blocked("the constraint no longer exists");
            }
        }
        SchemaChange::CreateIndex { relation, index } => {
            let current = require_relation(snapshot, relation)?;
            validate_index(index)?;
            validate_index_columns(
                index,
                &current
                    .columns
                    .iter()
                    .map(|column| column.name.as_str())
                    .collect::<Vec<_>>(),
            )?;
            if current.indexes.iter().any(|value| value.name == index.name) {
                return blocked("the index already exists");
            }
        }
        SchemaChange::DropIndex { relation, name } => {
            let current = require_relation(snapshot, relation)?;
            validate_identifier(name, "index")?;
            if !current.indexes.iter().any(|value| value.name == *name) {
                return blocked("the index no longer exists");
            }
        }
    }
    Ok(())
}

pub(super) fn require_relation<'a>(
    snapshot: &'a CatalogSnapshot,
    reference: &ObjectRef,
) -> AppResult<&'a dopedb_protocol::Relation> {
    find_relation(snapshot, reference).ok_or_else(|| AppError::Blocked {
        reason: "the target relation is missing from the current Catalog snapshot".into(),
    })
}

fn find_relation<'a>(
    snapshot: &'a CatalogSnapshot,
    reference: &ObjectRef,
) -> Option<&'a dopedb_protocol::Relation> {
    snapshot.relations().iter().find(|relation| {
        relation.object.catalog == reference.catalog
            && relation.object.namespace == reference.namespace
            && relation.object.name == reference.name
            && relation.object.kind == reference.kind
    })
}

pub(super) fn validate_identifier(value: &str, label: &str) -> AppResult<()> {
    if value.trim().is_empty() {
        return blocked(&format!("{label} cannot be empty"));
    }
    if value.contains('\0') || value.chars().any(char::is_control) {
        return blocked(&format!("{label} contains unsupported control characters"));
    }
    Ok(())
}

pub(super) fn validate_fragment(value: &str, label: &str) -> AppResult<()> {
    if value.trim().is_empty() {
        return blocked(&format!("{label} cannot be empty"));
    }
    if value.contains('\0')
        || value.contains(';')
        || value.contains("--")
        || value.contains("/*")
        || value.contains("*/")
    {
        return blocked(&format!(
            "{label} contains a statement boundary or SQL comment token"
        ));
    }
    Ok(())
}

fn optional_fragment(value: Option<&str>, label: &str) -> AppResult<()> {
    if let Some(value) = value {
        validate_fragment(value, label)?;
    }
    Ok(())
}

fn validate_object_ref(reference: &ObjectRef) -> AppResult<()> {
    validate_identifier(&reference.name, "relation")?;
    if let Some(catalog) = &reference.catalog {
        validate_identifier(catalog, "catalog")?;
    }
    if let Some(namespace) = &reference.namespace {
        validate_identifier(namespace, "namespace")?;
    }
    Ok(())
}

fn validate_constraint(constraint: &Constraint) -> AppResult<()> {
    validate_identifier(&constraint.name, "constraint")?;
    unique_names(
        constraint.columns.iter().map(String::as_str),
        "constraint column",
    )?;
    match constraint.kind {
        ConstraintKind::Primary | ConstraintKind::Unique => {
            if constraint.columns.is_empty() {
                return blocked("primary and unique constraints require columns");
            }
        }
        ConstraintKind::Foreign => {
            let Some(reference) = &constraint.referenced_relation else {
                return blocked("foreign key constraint requires a referenced relation");
            };
            validate_object_ref(reference)?;
            if constraint.columns.is_empty()
                || constraint.columns.len() != constraint.referenced_columns.len()
            {
                return blocked(
                    "foreign key source and referenced column counts must be equal and non-zero",
                );
            }
            unique_names(
                constraint.referenced_columns.iter().map(String::as_str),
                "referenced constraint column",
            )?;
        }
        ConstraintKind::Check => {
            let Some(expression) = constraint.check_expression.as_deref() else {
                return blocked("check constraint requires an expression");
            };
            validate_fragment(expression, "check expression")?;
        }
    }
    if constraint.kind != ConstraintKind::Foreign
        && (constraint.update_action.is_some() || constraint.delete_action.is_some())
    {
        return blocked("referential actions are valid only for foreign keys");
    }
    optional_referential_action(constraint.update_action.as_deref(), "update action")?;
    optional_referential_action(constraint.delete_action.as_deref(), "delete action")?;
    Ok(())
}

fn validate_index(index: &Index) -> AppResult<()> {
    validate_identifier(&index.name, "index")?;
    if index.keys.is_empty() {
        return blocked("an index requires at least one key");
    }
    if let Some(method) = index.method.as_deref() {
        validate_unquoted_token(method, "index method")?;
    }
    optional_fragment(index.predicate.as_deref(), "index predicate")?;
    for key in &index.keys {
        match (&key.column, &key.expression) {
            (Some(column), None) => validate_identifier(column, "index column")?,
            (None, Some(expression)) => validate_fragment(expression, "index expression")?,
            _ => return blocked("each index key must contain exactly one column or expression"),
        }
    }
    for column in &index.included_columns {
        validate_identifier(column, "included index column")?;
    }
    Ok(())
}

fn validate_constraint_columns(
    snapshot: &CatalogSnapshot,
    constraint: &Constraint,
    relation: &ObjectRef,
    available_columns: &[&str],
) -> AppResult<()> {
    if constraint
        .columns
        .iter()
        .any(|column| !available_columns.contains(&column.as_str()))
    {
        return blocked("constraint contains a column that is not present in its relation");
    }
    if constraint.kind != ConstraintKind::Foreign {
        return Ok(());
    }
    let reference = constraint
        .referenced_relation
        .as_ref()
        .ok_or_else(|| AppError::Blocked {
            reason: "foreign key constraint requires a referenced relation".into(),
        })?;
    let referenced_columns = if reference.catalog == relation.catalog
        && reference.namespace == relation.namespace
        && reference.name == relation.name
        && reference.kind == relation.kind
    {
        available_columns.to_vec()
    } else {
        let referenced = find_relation(snapshot, reference).ok_or_else(|| AppError::Blocked {
            reason: "foreign key referenced relation is missing from the Catalog snapshot".into(),
        })?;
        referenced
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<Vec<_>>()
    };
    if constraint
        .referenced_columns
        .iter()
        .any(|column| !referenced_columns.contains(&column.as_str()))
    {
        return blocked("foreign key contains an unknown referenced column");
    }
    Ok(())
}

fn validate_index_columns(index: &Index, available_columns: &[&str]) -> AppResult<()> {
    if index
        .keys
        .iter()
        .filter_map(|key| key.column.as_deref())
        .chain(index.included_columns.iter().map(String::as_str))
        .any(|column| !available_columns.contains(&column))
    {
        return blocked("index contains a column that is not present in its relation");
    }
    Ok(())
}

fn optional_referential_action(value: Option<&str>, label: &str) -> AppResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let normalized = value.trim().to_ascii_uppercase();
    if matches!(
        normalized.as_str(),
        "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT"
    ) {
        Ok(())
    } else {
        blocked(&format!("{label} is not a supported referential action"))
    }
}

fn validate_unquoted_token(value: &str, label: &str) -> AppResult<()> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return blocked(&format!(
            "{label} must contain only ASCII letters, digits, or underscores"
        ));
    }
    Ok(())
}

fn unique_names<'a>(values: impl IntoIterator<Item = &'a str>, label: &str) -> AppResult<()> {
    let mut seen = std::collections::HashSet::new();
    for value in values {
        validate_identifier(value, label)?;
        if !seen.insert(value) {
            return blocked(&format!("duplicate {label} `{value}`"));
        }
    }
    Ok(())
}

fn blocked<T>(reason: &str) -> AppResult<T> {
    Err(AppError::Blocked {
        reason: reason.into(),
    })
}
