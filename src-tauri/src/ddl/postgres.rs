//! PostgreSQL DDL renderer.

use dopedb_protocol::{
    CatalogSnapshot, DatabaseEngine, DdlPlan, DefaultChange, SchemaChange, SchemaChangeRequest,
    DDL_IR_SCHEMA_VERSION,
};

use crate::error::AppResult;

use super::common::{
    create_index, create_table, quote_identifier, quoted_ref, render_column, render_constraint,
};

pub(super) fn render(
    _snapshot: &CatalogSnapshot,
    request: &SchemaChangeRequest,
) -> AppResult<DdlPlan> {
    let engine = DatabaseEngine::Postgres;
    let mut warnings = Vec::new();
    let statements = match &request.change {
        SchemaChange::CreateTable { table } => create_table(engine, table)?,
        SchemaChange::DropTable { relation } => {
            warnings.push("Dropping a table permanently removes its data.".into());
            vec![format!("DROP TABLE {};", quoted_ref(engine, relation))]
        }
        SchemaChange::RenameTable { relation, new_name } => vec![format!(
            "ALTER TABLE {} RENAME TO {};",
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
            let table = quoted_ref(engine, relation);
            let mut current = column.clone();
            let mut statements = Vec::new();
            if let Some(name) = &alteration.new_name {
                statements.push(format!(
                    "ALTER TABLE {table} RENAME COLUMN {} TO {};",
                    quote_identifier(engine, &current),
                    quote_identifier(engine, name)
                ));
                current.clone_from(name);
            }
            if let Some(native_type) = &alteration.native_type {
                statements.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN {} TYPE {};",
                    quote_identifier(engine, &current),
                    native_type.trim()
                ));
            }
            if let Some(nullable) = alteration.nullable {
                statements.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN {} {};",
                    quote_identifier(engine, &current),
                    if nullable {
                        "DROP NOT NULL"
                    } else {
                        "SET NOT NULL"
                    }
                ));
            }
            match &alteration.default {
                DefaultChange::Keep => {}
                DefaultChange::Drop => statements.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN {} DROP DEFAULT;",
                    quote_identifier(engine, &current)
                )),
                DefaultChange::Set { expression } => statements.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN {} SET DEFAULT {};",
                    quote_identifier(engine, &current),
                    expression.trim()
                )),
            }
            statements
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
        SchemaChange::DropConstraint { relation, name } => vec![format!(
            "ALTER TABLE {} DROP CONSTRAINT {};",
            quoted_ref(engine, relation),
            quote_identifier(engine, name)
        )],
        SchemaChange::CreateIndex { relation, index } => {
            vec![create_index(engine, relation, index)?]
        }
        SchemaChange::DropIndex { relation, name } => {
            let mut index = relation.clone();
            index.name.clone_from(name);
            vec![format!("DROP INDEX {};", quoted_ref(engine, &index))]
        }
    };
    Ok(DdlPlan {
        schema_version: DDL_IR_SCHEMA_VERSION,
        engine,
        catalog_fingerprint: request.catalog_fingerprint.clone(),
        statements,
        transactional: true,
        requires_rebuild: false,
        warnings,
    })
}
