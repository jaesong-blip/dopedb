//! MySQL/MariaDB DDL renderer. Plans flag implicit-commit behavior explicitly.

use dopedb_protocol::{
    CatalogSnapshot, ConstraintKind, DatabaseEngine, DdlPlan, SchemaChange, SchemaChangeRequest,
    TableDefinition, DDL_IR_SCHEMA_VERSION,
};

use crate::error::{AppError, AppResult};

use super::common::{
    column_definition, create_index, create_table, quote_identifier, quoted_ref, render_column,
    render_constraint,
};
use super::validate::require_relation;

pub(super) fn render(
    snapshot: &CatalogSnapshot,
    request: &SchemaChangeRequest,
) -> AppResult<DdlPlan> {
    let engine = DatabaseEngine::Mysql;
    let mut warnings = vec![
        "MySQL DDL may commit implicitly; rollback is not guaranteed after execution starts."
            .into(),
    ];
    let statements = match &request.change {
        SchemaChange::CreateTable { table } => create_table(engine, table)?,
        SchemaChange::DropTable { relation } => {
            warnings.push("Dropping a table permanently removes its data.".into());
            vec![format!("DROP TABLE {};", quoted_ref(engine, relation))]
        }
        SchemaChange::RenameTable { relation, new_name } => vec![format!(
            "RENAME TABLE {} TO {};",
            quoted_ref(engine, relation),
            quote_identifier(engine, new_name)
        )],
        SchemaChange::AddColumn { relation, column } => vec![format!(
            "ALTER TABLE {} ADD COLUMN {};",
            quoted_ref(engine, relation),
            render_column(engine, column)?
        )],
        SchemaChange::AlterColumn {
            relation,
            column,
            alteration,
        } => {
            let current_relation = require_relation(snapshot, relation)?;
            let current = current_relation
                .columns
                .iter()
                .find(|value| value.name == *column)
                .ok_or_else(|| AppError::Blocked {
                    reason: "the column no longer exists".into(),
                })?;
            let mut definition = column_definition(current);
            if let Some(name) = &alteration.new_name {
                definition.name.clone_from(name);
            }
            if let Some(native_type) = &alteration.native_type {
                definition.native_type.clone_from(native_type);
            }
            if let Some(nullable) = alteration.nullable {
                definition.nullable = nullable;
            }
            match &alteration.default {
                dopedb_protocol::DefaultChange::Keep => {}
                dopedb_protocol::DefaultChange::Drop => definition.default_expression = None,
                dopedb_protocol::DefaultChange::Set { expression } => {
                    definition.default_expression = Some(expression.clone());
                }
            }
            vec![format!(
                "ALTER TABLE {} CHANGE COLUMN {} {};",
                quoted_ref(engine, relation),
                quote_identifier(engine, column),
                render_column(engine, &definition)?
            )]
        }
        SchemaChange::DropColumn { relation, column } => vec![format!(
            "ALTER TABLE {} DROP COLUMN {};",
            quoted_ref(engine, relation),
            quote_identifier(engine, column)
        )],
        SchemaChange::AddConstraint {
            relation,
            constraint,
        } => vec![format!(
            "ALTER TABLE {} ADD {};",
            quoted_ref(engine, relation),
            render_constraint(engine, constraint)?
        )],
        SchemaChange::DropConstraint { relation, name } => {
            let current = require_relation(snapshot, relation)?;
            let constraint = current
                .constraints
                .iter()
                .find(|constraint| constraint.name == *name)
                .ok_or_else(|| AppError::Blocked {
                    reason: "the constraint no longer exists".into(),
                })?;
            let action = match constraint.kind {
                ConstraintKind::Primary => "DROP PRIMARY KEY".into(),
                ConstraintKind::Foreign => {
                    format!("DROP FOREIGN KEY {}", quote_identifier(engine, name))
                }
                ConstraintKind::Unique => {
                    format!("DROP INDEX {}", quote_identifier(engine, name))
                }
                ConstraintKind::Check => {
                    format!("DROP CHECK {}", quote_identifier(engine, name))
                }
            };
            vec![format!(
                "ALTER TABLE {} {action};",
                quoted_ref(engine, relation)
            )]
        }
        SchemaChange::CreateIndex { relation, index } => {
            vec![create_index(engine, relation, index)?]
        }
        SchemaChange::DropIndex { relation, name } => vec![format!(
            "DROP INDEX {} ON {};",
            quote_identifier(engine, name),
            quoted_ref(engine, relation)
        )],
    };
    // Retain this explicit empty-use binding so the renderer fails to compile if
    // TableDefinition changes without reviewing MySQL create-table behavior.
    let _: Option<&TableDefinition> = match &request.change {
        SchemaChange::CreateTable { table } => Some(table),
        _ => None,
    };
    Ok(DdlPlan {
        schema_version: DDL_IR_SCHEMA_VERSION,
        engine,
        catalog_fingerprint: request.catalog_fingerprint.clone(),
        statements,
        transactional: false,
        requires_rebuild: false,
        warnings,
    })
}
