//! SQLite DDL renderer with an explicit table-rebuild preview for unsupported ALTERs.

use dopedb_protocol::{
    CatalogSnapshot, ColumnDefinition, DatabaseEngine, DdlPlan, Index, Relation, SchemaChange,
    SchemaChangeRequest, TableDefinition, DDL_IR_SCHEMA_VERSION,
};

use crate::error::{AppError, AppResult};

use super::common::{
    column_definition, create_index, create_table, quote_identifier, quoted_ref, render_column,
};
use super::validate::require_relation;

pub(super) fn render(
    snapshot: &CatalogSnapshot,
    request: &SchemaChangeRequest,
) -> AppResult<DdlPlan> {
    let engine = DatabaseEngine::Sqlite;
    let mut warnings = Vec::new();
    let (statements, requires_rebuild) = match &request.change {
        SchemaChange::CreateTable { table } => (create_table(engine, table)?, false),
        SchemaChange::DropTable { relation } => {
            warnings.push("Dropping a table permanently removes its data.".into());
            (
                vec![format!("DROP TABLE {};", quoted_ref(engine, relation))],
                false,
            )
        }
        SchemaChange::RenameTable { relation, new_name } => (
            vec![format!(
                "ALTER TABLE {} RENAME TO {};",
                quoted_ref(engine, relation),
                quote_identifier(engine, new_name)
            )],
            false,
        ),
        SchemaChange::AddColumn { relation, column } => (
            vec![format!(
                "ALTER TABLE {} ADD COLUMN {};",
                quoted_ref(engine, relation),
                render_column(engine, column)?
            )],
            false,
        ),
        SchemaChange::AlterColumn {
            relation,
            column,
            alteration,
        } if alteration.new_name.is_some()
            && alteration.native_type.is_none()
            && alteration.nullable.is_none()
            && matches!(alteration.default, dopedb_protocol::DefaultChange::Keep) =>
        {
            (
                vec![format!(
                    "ALTER TABLE {} RENAME COLUMN {} TO {};",
                    quoted_ref(engine, relation),
                    quote_identifier(engine, column),
                    quote_identifier(
                        engine,
                        alteration
                            .new_name
                            .as_ref()
                            .expect("guard requires a new name")
                    )
                )],
                false,
            )
        }
        change => {
            warnings.push(
                "SQLite requires a table rebuild; the preview includes every copy and restore step."
                    .into(),
            );
            (rebuild(snapshot, request, change)?, true)
        }
    };
    Ok(DdlPlan {
        schema_version: DDL_IR_SCHEMA_VERSION,
        engine,
        catalog_fingerprint: request.catalog_fingerprint.clone(),
        statements,
        // The script executor supplies one transaction. Rebuild plans defer
        // foreign-key checks inside that same transaction.
        transactional: true,
        requires_rebuild,
        warnings,
    })
}

fn rebuild(
    snapshot: &CatalogSnapshot,
    request: &SchemaChangeRequest,
    change: &SchemaChange,
) -> AppResult<Vec<String>> {
    let current = require_relation(snapshot, change.relation())?;
    if current.object.kind != dopedb_protocol::ObjectKind::Table {
        return blocked("SQLite can rebuild tables only, not views");
    }
    let mut next = current.clone();
    let mut source_names = next
        .columns
        .iter()
        .map(|column| (column.name.clone(), column.name.clone()))
        .collect::<Vec<_>>();

    match change {
        SchemaChange::AlterColumn {
            column, alteration, ..
        } => {
            let target = next
                .columns
                .iter_mut()
                .find(|value| value.name == *column)
                .ok_or_else(|| AppError::Blocked {
                    reason: "the column no longer exists".into(),
                })?;
            if let Some(name) = &alteration.new_name {
                rename_column_references(&mut next.constraints, &mut next.indexes, column, name);
                if let Some((_, destination)) =
                    source_names.iter_mut().find(|(source, _)| source == column)
                {
                    destination.clone_from(name);
                }
                target.name.clone_from(name);
            }
            if let Some(native_type) = &alteration.native_type {
                target.native_type.clone_from(native_type);
            }
            if let Some(nullable) = alteration.nullable {
                target.nullable = nullable;
            }
            match &alteration.default {
                dopedb_protocol::DefaultChange::Keep => {}
                dopedb_protocol::DefaultChange::Drop => target.default_expression = None,
                dopedb_protocol::DefaultChange::Set { expression } => {
                    target.default_expression = Some(expression.clone());
                }
            }
        }
        SchemaChange::DropColumn { column, .. } => {
            if next.constraints.iter().any(|constraint| {
                constraint.columns.iter().any(|value| value == column)
                    || constraint
                        .referenced_columns
                        .iter()
                        .any(|value| value == column)
            }) || next.indexes.iter().any(|index| {
                index
                    .keys
                    .iter()
                    .any(|key| key.column.as_deref() == Some(column))
                    || index.included_columns.iter().any(|value| value == column)
            }) {
                return blocked(
                    "drop dependent constraints and indexes before dropping this SQLite column",
                );
            }
            next.columns.retain(|value| value.name != *column);
            source_names.retain(|(source, _)| source != column);
        }
        SchemaChange::AddConstraint { constraint, .. } => {
            next.constraints.push(constraint.clone());
        }
        SchemaChange::DropConstraint { name, .. } => {
            next.constraints.retain(|value| value.name != *name);
        }
        SchemaChange::AddColumn { column, .. } => {
            if !column.nullable
                && column.default_expression.is_none()
                && column.generated_expression.is_none()
            {
                return blocked(
                    "a non-null SQLite column needs a default before existing rows can be rebuilt",
                );
            }
            next.columns
                .push(catalog_column(column, next.columns.len() + 1));
        }
        _ => return blocked("this SQLite change does not use the rebuild planner"),
    }

    let temp_name = format!(
        "__dopedb_rebuild_{}",
        &request.catalog_fingerprint[..12.min(request.catalog_fingerprint.len())]
    );
    if snapshot
        .relations()
        .iter()
        .any(|relation| relation.object.name == temp_name)
    {
        return blocked("the deterministic SQLite rebuild table already exists");
    }
    let original = next.object.clone();
    next.object.name.clone_from(&temp_name);
    let table = table_definition(&next);
    let mut create = create_table(
        DatabaseEngine::Sqlite,
        &TableDefinition {
            indexes: Vec::new(),
            ..table
        },
    )?;
    let create_table = create
        .drain(..)
        .next()
        .ok_or_else(|| AppError::Config("SQLite rebuild produced no CREATE TABLE".into()))?;

    let insert_pairs = source_names
        .iter()
        .filter(|(_, destination)| {
            next.columns
                .iter()
                .find(|column| column.name == *destination)
                .is_some_and(|column| column.generated_expression.is_none())
        })
        .collect::<Vec<_>>();
    let destination_columns = insert_pairs
        .iter()
        .map(|(_, destination)| quote_identifier(DatabaseEngine::Sqlite, destination))
        .collect::<Vec<_>>()
        .join(", ");
    let source_columns = insert_pairs
        .iter()
        .map(|(source, _)| quote_identifier(DatabaseEngine::Sqlite, source))
        .collect::<Vec<_>>()
        .join(", ");
    let temp_ref = next.object.clone();
    let mut statements = vec![
        "PRAGMA defer_foreign_keys = ON;".into(),
        create_table,
        format!(
            "INSERT INTO {} ({destination_columns}) SELECT {source_columns} FROM {};",
            quoted_ref(DatabaseEngine::Sqlite, &temp_ref),
            quoted_ref(DatabaseEngine::Sqlite, &original)
        ),
        format!(
            "DROP TABLE {};",
            quoted_ref(DatabaseEngine::Sqlite, &original)
        ),
        format!(
            "ALTER TABLE {} RENAME TO {};",
            quoted_ref(DatabaseEngine::Sqlite, &temp_ref),
            quote_identifier(DatabaseEngine::Sqlite, &original.name)
        ),
    ];
    statements.extend(
        next.indexes
            .iter()
            .map(|index| create_index(DatabaseEngine::Sqlite, &original, index))
            .collect::<AppResult<Vec<_>>>()?,
    );
    statements.extend(["PRAGMA foreign_key_check;".into()]);
    Ok(statements)
}

fn table_definition(relation: &Relation) -> TableDefinition {
    TableDefinition {
        relation: relation.object.clone(),
        columns: relation.columns.iter().map(column_definition).collect(),
        constraints: relation.constraints.clone(),
        indexes: relation.indexes.clone(),
        comment: relation.comment.clone(),
    }
}

fn catalog_column(column: &ColumnDefinition, ordinal: usize) -> dopedb_protocol::Column {
    dopedb_protocol::Column {
        name: column.name.clone(),
        ordinal: u32::try_from(ordinal).unwrap_or(u32::MAX),
        native_type: column.native_type.clone(),
        type_family: dopedb_protocol::NormalizedTypeFamily::Other,
        length: None,
        precision: None,
        scale: None,
        nullable: column.nullable,
        default_expression: column.default_expression.clone(),
        generated_expression: column.generated_expression.clone(),
        identity: column.identity,
        auto_increment: column.auto_increment,
        collation: column.collation.clone(),
        comment: column.comment.clone(),
        sensitivity: None,
    }
}

fn rename_column_references(
    constraints: &mut [dopedb_protocol::Constraint],
    indexes: &mut [Index],
    old: &str,
    new: &str,
) {
    for constraint in constraints {
        for column in &mut constraint.columns {
            if column == old {
                column.replace_range(.., new);
            }
        }
        for column in &mut constraint.referenced_columns {
            if column == old {
                column.replace_range(.., new);
            }
        }
    }
    for index in indexes {
        for key in &mut index.keys {
            if key.column.as_deref() == Some(old) {
                key.column = Some(new.into());
            }
        }
        for column in &mut index.included_columns {
            if column == old {
                column.replace_range(.., new);
            }
        }
    }
}

fn blocked<T>(reason: &str) -> AppResult<T> {
    Err(AppError::Blocked {
        reason: reason.into(),
    })
}
