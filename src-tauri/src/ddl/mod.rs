//! Catalog-pinned dialect-neutral DDL planning.
//!
//! Structured editors submit [`SchemaChangeRequest`] values. This module validates
//! them against the exact canonical Catalog snapshot and renders a complete,
//! reviewable plan without executing target-database mutations.

mod common;
mod mysql;
mod postgres;
mod sqlite;
mod validate;

use dopedb_protocol::{CatalogSnapshot, DatabaseEngine, DdlPlan, SchemaChangeRequest};

use crate::error::{AppError, AppResult};

/// Validate and render one exact schema change.
pub(crate) fn render(
    snapshot: &CatalogSnapshot,
    request: &SchemaChangeRequest,
) -> AppResult<DdlPlan> {
    validate::request(snapshot, request)?;
    match snapshot.engine() {
        DatabaseEngine::Postgres => postgres::render(snapshot, request),
        DatabaseEngine::Mysql => mysql::render(snapshot, request),
        DatabaseEngine::Sqlite => sqlite::render(snapshot, request),
        DatabaseEngine::Mongodb => Err(AppError::Blocked {
            reason: "relational DDL is unavailable for document databases".into(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use dopedb_protocol::{
        CatalogContents, Column, ColumnAlteration, ColumnDefinition, Constraint, ConstraintKind,
        DatabaseEngine, DefaultChange, Index, IndexKey, NormalizedTypeFamily, ObjectKind,
        ObjectRef, Relation, SchemaChange, SchemaChangeRequest,
    };
    use uuid::Uuid;

    use super::*;

    fn relation() -> Relation {
        Relation {
            object: ObjectRef {
                catalog: None,
                namespace: Some("public".into()),
                name: "users".into(),
                kind: ObjectKind::Table,
                native_id: None,
            },
            comment: None,
            row_estimate: None,
            partition_parent: None,
            partition_children: Vec::new(),
            columns: vec![
                Column {
                    name: "id".into(),
                    ordinal: 1,
                    native_type: "bigint".into(),
                    type_family: NormalizedTypeFamily::Integer,
                    length: None,
                    precision: None,
                    scale: None,
                    nullable: false,
                    default_expression: None,
                    generated_expression: None,
                    identity: true,
                    auto_increment: false,
                    collation: None,
                    comment: None,
                    sensitivity: None,
                },
                Column {
                    name: "email".into(),
                    ordinal: 2,
                    native_type: "text".into(),
                    type_family: NormalizedTypeFamily::Text,
                    length: None,
                    precision: None,
                    scale: None,
                    nullable: false,
                    default_expression: None,
                    generated_expression: None,
                    identity: false,
                    auto_increment: false,
                    collation: None,
                    comment: None,
                    sensitivity: None,
                },
            ],
            constraints: vec![Constraint {
                name: "users_pkey".into(),
                kind: ConstraintKind::Primary,
                columns: vec!["id".into()],
                referenced_relation: None,
                referenced_columns: Vec::new(),
                check_expression: None,
                update_action: None,
                delete_action: None,
                deferrable: false,
                validated: true,
            }],
            indexes: Vec::new(),
        }
    }

    fn snapshot(engine: DatabaseEngine) -> CatalogSnapshot {
        let mut relation = relation();
        if engine != DatabaseEngine::Postgres {
            relation.object.namespace = None;
            relation.columns[0].identity = false;
            relation.columns[0].auto_increment = engine == DatabaseEngine::Mysql;
        }
        CatalogSnapshot::capture(
            Uuid::from_u128(7),
            engine,
            "app",
            Utc::now(),
            CatalogContents {
                relations: vec![relation],
                ..CatalogContents::default()
            },
        )
        .unwrap()
    }

    fn request(snapshot: &CatalogSnapshot, change: SchemaChange) -> SchemaChangeRequest {
        SchemaChangeRequest::new(snapshot.fingerprint(), change)
    }

    #[test]
    fn postgres_alter_column_renders_exact_steps() {
        let snapshot = snapshot(DatabaseEngine::Postgres);
        let plan = render(
            &snapshot,
            &request(
                &snapshot,
                SchemaChange::AlterColumn {
                    relation: snapshot.relations()[0].object.clone(),
                    column: "email".into(),
                    alteration: ColumnAlteration {
                        new_name: Some("login".into()),
                        native_type: Some("varchar(320)".into()),
                        nullable: Some(true),
                        default: DefaultChange::Set {
                            expression: "''".into(),
                        },
                    },
                },
            ),
        )
        .unwrap();

        assert_eq!(plan.engine, DatabaseEngine::Postgres);
        assert_eq!(plan.statements.len(), 4);
        assert!(plan.statements[0].contains("RENAME COLUMN \"email\" TO \"login\""));
        assert!(plan.statements[1].contains("ALTER COLUMN \"login\" TYPE varchar(320)"));
        assert!(plan.statements[2].contains("DROP NOT NULL"));
        assert!(plan.statements[3].contains("SET DEFAULT ''"));
    }

    #[test]
    fn stale_catalog_fingerprint_fails_closed() {
        let snapshot = snapshot(DatabaseEngine::Postgres);
        let request = SchemaChangeRequest::new(
            "f".repeat(64),
            SchemaChange::DropTable {
                relation: snapshot.relations()[0].object.clone(),
            },
        );

        let error = render(&snapshot, &request).unwrap_err();
        assert!(matches!(error, AppError::Blocked { .. }));
    }

    #[test]
    fn sqlite_drop_column_produces_full_rebuild_preview() {
        let snapshot = snapshot(DatabaseEngine::Sqlite);
        let plan = render(
            &snapshot,
            &request(
                &snapshot,
                SchemaChange::DropColumn {
                    relation: snapshot.relations()[0].object.clone(),
                    column: "email".into(),
                },
            ),
        )
        .unwrap();

        assert!(plan.requires_rebuild);
        assert!(plan.transactional);
        assert!(plan
            .statements
            .iter()
            .any(|statement| statement.starts_with("CREATE TABLE")));
        assert!(plan
            .statements
            .iter()
            .any(|statement| statement.contains("INSERT INTO")));
        assert!(plan
            .statements
            .iter()
            .any(|statement| statement.contains("PRAGMA foreign_key_check")));
    }

    #[test]
    fn sqlite_non_null_add_without_default_is_blocked_for_rebuild() {
        let snapshot = snapshot(DatabaseEngine::Sqlite);
        let error = render(
            &snapshot,
            &request(
                &snapshot,
                SchemaChange::AddColumn {
                    relation: snapshot.relations()[0].object.clone(),
                    column: ColumnDefinition {
                        name: "required".into(),
                        native_type: "TEXT".into(),
                        nullable: false,
                        default_expression: None,
                        generated_expression: None,
                        identity: false,
                        auto_increment: false,
                        collation: None,
                        comment: None,
                    },
                },
            ),
        )
        .unwrap();

        // SQLite can add this to an empty table, so the direct plan is valid and
        // leaves final enforcement to SQLite. Rebuild paths apply the stricter copy gate.
        assert!(!error.requires_rebuild);
    }

    #[test]
    fn structured_ddl_rejects_unbounded_actions_methods_and_unknown_columns() {
        let snapshot = snapshot(DatabaseEngine::Postgres);
        let relation = snapshot.relations()[0].object.clone();
        let mut foreign = Constraint {
            name: "users_parent_fk".into(),
            kind: ConstraintKind::Foreign,
            columns: vec!["id".into()],
            referenced_relation: Some(relation.clone()),
            referenced_columns: vec!["id".into()],
            check_expression: None,
            update_action: Some("CASCADE NULLS DISTINCT".into()),
            delete_action: None,
            deferrable: false,
            validated: true,
        };
        assert!(render(
            &snapshot,
            &request(
                &snapshot,
                SchemaChange::AddConstraint {
                    relation: relation.clone(),
                    constraint: foreign.clone(),
                },
            ),
        )
        .is_err());

        foreign.update_action = Some("cascade".into());
        foreign.columns = vec!["missing".into()];
        assert!(render(
            &snapshot,
            &request(
                &snapshot,
                SchemaChange::AddConstraint {
                    relation: relation.clone(),
                    constraint: foreign,
                },
            ),
        )
        .is_err());

        let index = Index {
            name: "users_email_idx".into(),
            method: Some("btree WHERE true".into()),
            keys: vec![IndexKey {
                column: Some("email".into()),
                expression: None,
                direction: None,
            }],
            included_columns: Vec::new(),
            predicate: None,
            unique: false,
            valid: true,
        };
        assert!(render(
            &snapshot,
            &request(&snapshot, SchemaChange::CreateIndex { relation, index },),
        )
        .is_err());
    }
}
