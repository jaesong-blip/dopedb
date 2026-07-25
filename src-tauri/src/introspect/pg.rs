//! Postgres introspection via `information_schema` + `pg_catalog`.

use std::collections::HashMap;
use std::fmt::Write as _;

use dopedb_protocol::{Constraint, ConstraintKind, IndexKey, ObjectKind, ObjectRef, SortDirection};
use sqlx::{PgPool, Row};

use crate::error::{AppError, AppResult};

use super::{Catalog, Column, DatabaseObject, ForeignKey, Index, Table};

const COLS_SQL: &str = r#"
SELECT c.table_schema, c.table_name, c.column_name,
       format_type(a.atttypid, a.atttypmod) AS formatted_type,
       c.is_nullable, c.ordinal_position,
       c.character_maximum_length, c.numeric_precision, c.numeric_scale,
       c.column_default, c.is_identity, c.collation_name,
       col_description(cl.oid, a.attnum) AS column_comment,
       COALESCE(pk.is_pk, false) AS is_pk
FROM information_schema.columns c
JOIN pg_namespace ns ON ns.nspname = c.table_schema
JOIN pg_class cl ON cl.relnamespace = ns.oid AND cl.relname = c.table_name
JOIN pg_attribute a ON a.attrelid = cl.oid
                   AND a.attname = c.column_name
                   AND a.attnum > 0
                   AND NOT a.attisdropped
LEFT JOIN (
    SELECT tc.table_schema, tc.table_name, kcu.column_name, true AS is_pk
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
) pk ON pk.table_schema = c.table_schema
    AND pk.table_name = c.table_name
    AND pk.column_name = c.column_name
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
  -- Hide objects owned by an extension (e.g. pg_stat_statements) — they are noise in
  -- a table browser and some error on SELECT *.
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    JOIN pg_class pc ON pc.oid = dep.objid
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE dep.deptype = 'e'
      AND dep.classid = 'pg_class'::regclass
      AND pn.nspname = c.table_schema
      AND pc.relname = c.table_name
  )
ORDER BY c.table_schema, c.table_name, c.ordinal_position
"#;

// Tables vs. views. information_schema.columns returns both, so classify per relation.
const KIND_SQL: &str = r#"
SELECT n.nspname AS table_schema,
       c.relname AS table_name,
       CASE c.relkind
         WHEN 'v' THEN 'VIEW'
         WHEN 'm' THEN 'MATERIALIZED VIEW'
         ELSE 'BASE TABLE'
       END AS table_type,
       c.oid::text AS native_id,
       obj_description(c.oid, 'pg_class') AS table_comment,
       pn.nspname AS parent_schema,
       pc.relname AS parent_table
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits inh ON inh.inhrelid = c.oid
LEFT JOIN pg_class pc ON pc.oid = inh.inhparent
LEFT JOIN pg_namespace pn ON pn.oid = pc.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
"#;

// FK edges resolved on pg_catalog so composite keys stay per-column-correct. Zipping
// conkey/confkey WITH ORDINALITY pairs each local column to the matching referenced
// column (the old key-name join produced NxN garbage for composite FKs and cross-joined
// same-named constraints across tables).
const FK_SQL: &str = r#"
SELECT cn.nspname   AS table_schema,
       cl.relname   AS table_name,
       con.conname  AS constraint_name,
       k.ord        AS ordinal_position,
       att.attname  AS column_name,
       fn.nspname   AS foreign_schema,
       fcl.relname  AS foreign_table,
       fatt.attname AS foreign_column,
       CASE con.confupdtype
         WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
         WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
         WHEN 'd' THEN 'SET DEFAULT'
       END AS update_action,
       CASE con.confdeltype
         WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
         WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
         WHEN 'd' THEN 'SET DEFAULT'
       END AS delete_action,
       con.condeferrable AS is_deferrable,
       con.convalidated AS is_validated
FROM pg_constraint con
JOIN pg_class cl       ON cl.oid = con.conrelid
JOIN pg_namespace cn   ON cn.oid = cl.relnamespace
JOIN pg_class fcl      ON fcl.oid = con.confrelid
JOIN pg_namespace fn   ON fn.oid = fcl.relnamespace
JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(conkey, confkey, ord) ON true
JOIN pg_attribute att  ON att.attrelid = con.conrelid  AND att.attnum = k.conkey
JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = k.confkey
WHERE con.contype = 'f'
  AND cn.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY cn.nspname, cl.relname, con.conname, k.ord
"#;

// Secondary indexes (PK indexes excluded — the PK is already on the columns). Expression
// columns (indkey = 0) surface as "(expression)".
const IDX_SQL: &str = r#"
SELECT n.nspname AS table_schema,
       t.relname AS table_name,
       ic.relname AS index_name,
       i.indisunique AS is_unique,
       am.amname AS index_method,
       a.attname AS column_name,
       CASE WHEN a.attname IS NULL
            THEN pg_get_indexdef(i.indexrelid, k.ord::integer, true)
            ELSE NULL
       END AS index_expression,
       CASE WHEN (i.indoption[(k.ord - 1)::integer] & 1) = 1
            THEN 'desc' ELSE 'asc'
       END AS sort_direction,
       pg_get_expr(i.indpred, i.indrelid) AS predicate,
       i.indisvalid AS is_valid
FROM pg_index i
JOIN pg_class t      ON t.oid = i.indrelid
JOIN pg_class ic     ON ic.oid = i.indexrelid
JOIN pg_namespace n  ON n.oid = t.relnamespace
JOIN pg_am am         ON am.oid = ic.relam
JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT i.indisprimary
ORDER BY n.nspname, t.relname, ic.relname, k.ord
"#;

const CONSTRAINTS_SQL: &str = r#"
SELECT n.nspname AS table_schema,
       c.relname AS table_name,
       con.conname AS constraint_name,
       con.contype AS constraint_type,
       COALESCE(
         ARRAY(
           SELECT a.attname
           FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
           ORDER BY key.ord
         ),
         ARRAY[]::text[]
       ) AS columns,
       CASE WHEN con.contype = 'c' THEN pg_get_expr(con.conbin, con.conrelid) END
         AS check_expression,
       con.condeferrable AS is_deferrable,
       con.convalidated AS is_validated
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.contype IN ('p', 'u', 'c')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname, con.conname
"#;

const EST_SQL: &str = r#"
SELECT n.nspname AS table_schema, c.relname AS table_name, c.reltuples::bigint AS estimate
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
"#;

// Non-tabular objects stay out of Catalog.tables so callers cannot try to SELECT from
// a routine or sequence as if it were a data grid. Extension-owned objects are omitted
// for the same reason as extension-owned relations above: they are implementation noise
// in an application database explorer.
const OBJECTS_SQL: &str = r#"
SELECT n.nspname AS schema_name,
       p.proname AS object_name,
       CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS object_kind,
       pg_get_function_identity_arguments(p.oid) AS object_detail,
       NULL::text AS parent_name,
       p.oid::text AS native_id,
       pg_get_function_result(p.oid) AS return_type,
       l.lanname AS language,
       obj_description(p.oid, 'pg_proc') AS object_comment
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.prokind IN ('f', 'p', 'w')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    WHERE dep.deptype = 'e'
      AND dep.classid = 'pg_proc'::regclass
      AND dep.objid = p.oid
  )
UNION ALL
SELECT n.nspname,
       c.relname,
       CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'materialized_view' END,
       NULL::text,
       NULL::text,
       c.oid::text,
       NULL::text,
       NULL::text,
       obj_description(c.oid, 'pg_class')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('S', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    WHERE dep.deptype = 'e'
      AND dep.classid = 'pg_class'::regclass
      AND dep.objid = c.oid
  )
UNION ALL
SELECT n.nspname,
       t.tgname,
       'trigger',
       pg_get_triggerdef(t.oid, false),
       c.relname,
       t.oid::text,
       NULL::text,
       NULL::text,
       obj_description(t.oid, 'pg_trigger')
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    WHERE dep.deptype = 'e'
      AND dep.classid = 'pg_trigger'::regclass
      AND dep.objid = t.oid
  )
ORDER BY schema_name, object_kind, object_name, object_detail
"#;

// PostgreSQL 10 and earlier represent routine kind with proisagg/proiswindow;
// `pg_proc.prokind` arrived in PostgreSQL 11. Procedures do not exist on the
// legacy branch, but functions, sequences, materialized views, and triggers do.
const OBJECTS_LEGACY_SQL: &str = r#"
SELECT n.nspname AS schema_name,
       p.proname AS object_name,
       'function' AS object_kind,
       pg_get_function_identity_arguments(p.oid) AS object_detail,
       NULL::text AS parent_name,
       p.oid::text AS native_id,
       pg_get_function_result(p.oid) AS return_type,
       l.lanname AS language,
       obj_description(p.oid, 'pg_proc') AS object_comment
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT p.proisagg
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    WHERE dep.deptype = 'e'
      AND dep.classid = 'pg_proc'::regclass
      AND dep.objid = p.oid
  )
UNION ALL
SELECT n.nspname,
       c.relname,
       CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'materialized_view' END,
       NULL::text,
       NULL::text,
       c.oid::text,
       NULL::text,
       NULL::text,
       obj_description(c.oid, 'pg_class')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('S', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    WHERE dep.deptype = 'e'
      AND dep.classid = 'pg_class'::regclass
      AND dep.objid = c.oid
  )
UNION ALL
SELECT n.nspname,
       t.tgname,
       'trigger',
       pg_get_triggerdef(t.oid, false),
       c.relname,
       t.oid::text,
       NULL::text,
       NULL::text,
       obj_description(t.oid, 'pg_trigger')
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    WHERE dep.deptype = 'e'
      AND dep.classid = 'pg_trigger'::regclass
      AND dep.objid = t.oid
  )
ORDER BY schema_name, object_kind, object_name, object_detail
"#;

fn objects_sql_for_version(server_version_num: u32) -> &'static str {
    if server_version_num >= 110_000 {
        OBJECTS_SQL
    } else {
        OBJECTS_LEGACY_SQL
    }
}

pub async fn introspect(pool: &PgPool) -> AppResult<Catalog> {
    let mut tables: Vec<Table> = Vec::new();
    let mut idx: HashMap<(String, String), usize> = HashMap::new();

    for r in sqlx::query(COLS_SQL).fetch_all(pool).await? {
        let schema: String = r.try_get("table_schema")?;
        let name: String = r.try_get("table_name")?;
        let i = *idx
            .entry((schema.clone(), name.clone()))
            .or_insert_with(|| {
                tables.push(Table {
                    schema: Some(schema),
                    name,
                    kind: "table".into(),
                    columns: Vec::new(),
                    foreign_keys: Vec::new(),
                    indexes: Vec::new(),
                    row_estimate: None,
                    ..Table::default()
                });
                tables.len() - 1
            });
        let nullable: String = r.try_get("is_nullable")?;
        let ordinal = r
            .try_get::<i32, _>("ordinal_position")
            .ok()
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0);
        tables[i].columns.push(Column {
            name: r.try_get("column_name")?,
            data_type: r.try_get("formatted_type")?,
            nullable: nullable.eq_ignore_ascii_case("YES"),
            pk: r.try_get("is_pk")?,
            ordinal,
            length: r
                .try_get::<Option<i32>, _>("character_maximum_length")
                .unwrap_or(None)
                .and_then(|value| u64::try_from(value).ok()),
            precision: r
                .try_get::<Option<i32>, _>("numeric_precision")
                .unwrap_or(None)
                .and_then(|value| u32::try_from(value).ok()),
            scale: r
                .try_get::<Option<i32>, _>("numeric_scale")
                .unwrap_or(None)
                .and_then(|value| u32::try_from(value).ok()),
            default_expression: r.try_get("column_default").unwrap_or(None),
            identity: r
                .try_get::<String, _>("is_identity")
                .is_ok_and(|value| value.eq_ignore_ascii_case("YES")),
            collation: r.try_get("collation_name").unwrap_or(None),
            comment: r.try_get("column_comment").unwrap_or(None),
            ..Column::default()
        });
    }

    for r in sqlx::query(KIND_SQL).fetch_all(pool).await? {
        let key: (String, String) = (r.try_get("table_schema")?, r.try_get("table_name")?);
        if let Some(&i) = idx.get(&key) {
            let ty: String = r.try_get("table_type")?;
            if ty.eq_ignore_ascii_case("VIEW") {
                tables[i].kind = "view".into();
            } else if ty.eq_ignore_ascii_case("MATERIALIZED VIEW") {
                tables[i].kind = "materialized_view".into();
            }
            tables[i].native_id = r.try_get("native_id").ok();
            tables[i].comment = r.try_get("table_comment").unwrap_or(None);
            let parent_table: Option<String> = r.try_get("parent_table").unwrap_or(None);
            if let Some(parent_table) = parent_table {
                tables[i].partition_parent = Some(ObjectRef {
                    catalog: None,
                    namespace: r.try_get("parent_schema").unwrap_or(None),
                    name: parent_table,
                    kind: ObjectKind::Table,
                    native_id: None,
                });
            }
        }
    }

    let table_refs = tables
        .iter()
        .map(|table| {
            (
                (table.schema.clone(), table.name.clone()),
                ObjectRef {
                    catalog: None,
                    namespace: table.schema.clone(),
                    name: table.name.clone(),
                    kind: ObjectKind::Table,
                    native_id: table.native_id.clone(),
                },
                table.partition_parent.clone(),
            )
        })
        .collect::<Vec<_>>();
    for (_, child, parent) in table_refs {
        let Some(parent) = parent else { continue };
        if let Some(parent_table) = tables
            .iter_mut()
            .find(|table| table.schema == parent.namespace && table.name == parent.name)
        {
            parent_table.partition_children.push(child);
        }
    }

    for r in sqlx::query(CONSTRAINTS_SQL).fetch_all(pool).await? {
        let key: (String, String) = (r.try_get("table_schema")?, r.try_get("table_name")?);
        let Some(&i) = idx.get(&key) else { continue };
        let kind = match r.try_get::<String, _>("constraint_type")?.as_str() {
            "p" => ConstraintKind::Primary,
            "u" => ConstraintKind::Unique,
            "c" => ConstraintKind::Check,
            _ => continue,
        };
        tables[i].constraints.push(Constraint {
            name: r.try_get("constraint_name")?,
            kind,
            columns: r.try_get("columns").unwrap_or_default(),
            referenced_relation: None,
            referenced_columns: Vec::new(),
            check_expression: r.try_get("check_expression").unwrap_or(None),
            update_action: None,
            delete_action: None,
            deferrable: r.try_get("is_deferrable").unwrap_or(false),
            validated: r.try_get("is_validated").unwrap_or(true),
        });
    }

    for r in sqlx::query(FK_SQL).fetch_all(pool).await? {
        let key: (String, String) = (r.try_get("table_schema")?, r.try_get("table_name")?);
        if let Some(&i) = idx.get(&key) {
            tables[i].foreign_keys.push(ForeignKey {
                name: r.try_get("constraint_name").ok(),
                ordinal: r
                    .try_get::<i64, _>("ordinal_position")
                    .ok()
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(0),
                column: r.try_get("column_name")?,
                references_table: r.try_get("foreign_table")?,
                references_column: r.try_get("foreign_column")?,
                references_schema: r.try_get("foreign_schema").ok(),
                update_action: r.try_get("update_action").unwrap_or(None),
                delete_action: r.try_get("delete_action").unwrap_or(None),
                deferrable: r.try_get("is_deferrable").unwrap_or(false),
                validated: r.try_get("is_validated").unwrap_or(true),
            });
        }
    }

    // Group index rows (already ordered by table/index/position) into per-index columns.
    for r in sqlx::query(IDX_SQL).fetch_all(pool).await? {
        let key: (String, String) = (r.try_get("table_schema")?, r.try_get("table_name")?);
        let Some(&i) = idx.get(&key) else { continue };
        let iname: String = r.try_get("index_name")?;
        let column: Option<String> = r.try_get("column_name")?;
        let expression: Option<String> = r.try_get("index_expression")?;
        let display = column
            .clone()
            .or_else(|| expression.clone())
            .unwrap_or_else(|| "(expression)".into());
        let unique: bool = r.try_get("is_unique")?;
        let key_part = IndexKey {
            column,
            expression,
            direction: match r.try_get::<String, _>("sort_direction")?.as_str() {
                "desc" => Some(SortDirection::Desc),
                _ => Some(SortDirection::Asc),
            },
        };
        let idxs = &mut tables[i].indexes;
        match idxs.last_mut() {
            Some(last) if last.name == iname => {
                last.columns.push(display);
                last.keys.push(key_part);
            }
            _ => idxs.push(Index {
                name: iname,
                columns: vec![display],
                unique,
                method: r.try_get("index_method").ok(),
                keys: vec![key_part],
                predicate: r.try_get("predicate").unwrap_or(None),
                valid: r.try_get("is_valid").unwrap_or(true),
                ..Index::default()
            }),
        }
    }

    for r in sqlx::query(EST_SQL).fetch_all(pool).await? {
        let key: (String, String) = (r.try_get("table_schema")?, r.try_get("table_name")?);
        if let Some(&i) = idx.get(&key) {
            // reltuples is -1 for a relation that has never been ANALYZEd (PG 14+);
            // treat any negative value as "unknown" so the UI shows nothing, not "~-1".
            tables[i].row_estimate = r.try_get::<i64, _>("estimate").ok().filter(|&n| n >= 0);
        }
    }

    let server_version: String = sqlx::query_scalar("SHOW server_version_num")
        .fetch_one(pool)
        .await?;
    let server_version_num = server_version.trim().parse::<u32>().map_err(|_| {
        AppError::Config("PostgreSQL returned an invalid server_version_num".into())
    })?;
    let objects = sqlx::query(objects_sql_for_version(server_version_num))
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| {
            let detail: Option<String> = row.try_get("object_detail")?;
            Ok(DatabaseObject {
                schema: row.try_get("schema_name")?,
                name: row.try_get("object_name")?,
                kind: row.try_get("object_kind")?,
                native_id: row.try_get("native_id")?,
                detail: detail.clone(),
                parent: row.try_get("parent_name")?,
                arguments: detail
                    .filter(|value| !value.trim().is_empty())
                    .into_iter()
                    .collect(),
                return_type: row.try_get("return_type")?,
                language: row.try_get("language")?,
                comment: row.try_get("object_comment")?,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    Ok(Catalog { tables, objects })
}

/// Synthesize CREATE TABLE + CREATE INDEX from the introspected catalog. This is a
/// best-effort reconstruction (types come from information_schema, composite FKs emit
/// one line per column), NOT a pg_dump-exact dump.
pub async fn table_ddl(pool: &PgPool, schema: Option<&str>, table: &str) -> AppResult<String> {
    let cat = introspect(pool).await?;
    let t = cat
        .tables
        .iter()
        .find(|t| t.name == table && schema.is_none_or(|s| t.schema.as_deref() == Some(s)))
        .ok_or_else(|| AppError::NotFound(format!("table {table}")))?;
    Ok(synthesize_ddl(t))
}

fn q(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

fn qualified(schema: Option<&str>, name: &str) -> String {
    match schema {
        Some(s) => format!("{}.{}", q(s), q(name)),
        None => q(name),
    }
}

fn synthesize_ddl(t: &Table) -> String {
    let full = qualified(t.schema.as_deref(), &t.name);
    let mut out = String::new();
    let _ = writeln!(out, "-- Synthesized from catalog (not pg_dump-exact).");
    let _ = writeln!(out, "CREATE TABLE {full} (");

    let mut lines: Vec<String> = t
        .columns
        .iter()
        .map(|c| {
            format!(
                "    {} {}{}",
                q(&c.name),
                c.data_type,
                if c.nullable { "" } else { " NOT NULL" }
            )
        })
        .collect();

    let pk: Vec<String> = t
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| q(&c.name))
        .collect();
    if !pk.is_empty() {
        lines.push(format!("    PRIMARY KEY ({})", pk.join(", ")));
    }
    for fk in &t.foreign_keys {
        lines.push(format!(
            "    FOREIGN KEY ({}) REFERENCES {} ({})",
            q(&fk.column),
            qualified(fk.references_schema.as_deref(), &fk.references_table),
            q(&fk.references_column),
        ));
    }
    out.push_str(&lines.join(",\n"));
    let _ = write!(out, "\n);");

    for i in &t.indexes {
        let cols = i
            .columns
            .iter()
            .map(|c| q(c))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = write!(
            out,
            "\n{} {} ON {} ({});",
            if i.unique {
                "CREATE UNIQUE INDEX"
            } else {
                "CREATE INDEX"
            },
            q(&i.name),
            full,
            cols,
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthesize_ddl_covers_pk_fk_index() {
        let t = Table {
            schema: Some("public".into()),
            name: "orders".into(),
            kind: "table".into(),
            columns: vec![
                Column {
                    name: "id".into(),
                    data_type: "integer".into(),
                    nullable: false,
                    pk: true,
                    ..Column::default()
                },
                Column {
                    name: "user_id".into(),
                    data_type: "integer".into(),
                    nullable: false,
                    pk: false,
                    ..Column::default()
                },
                Column {
                    name: "note".into(),
                    data_type: "text".into(),
                    nullable: true,
                    pk: false,
                    ..Column::default()
                },
            ],
            foreign_keys: vec![ForeignKey {
                column: "user_id".into(),
                references_table: "users".into(),
                references_column: "id".into(),
                references_schema: Some("public".into()),
                ..ForeignKey::default()
            }],
            indexes: vec![Index {
                name: "idx_orders_user".into(),
                columns: vec!["user_id".into()],
                unique: false,
                ..Index::default()
            }],
            row_estimate: None,
            ..Table::default()
        };
        let ddl = synthesize_ddl(&t);
        assert!(ddl.contains("CREATE TABLE \"public\".\"orders\""));
        assert!(ddl.contains("\"id\" integer NOT NULL"));
        assert!(ddl.contains("\"note\" text\n") || ddl.contains("\"note\" text,"));
        assert!(ddl.contains("PRIMARY KEY (\"id\")"));
        assert!(ddl.contains("FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\" (\"id\")"));
        assert!(ddl
            .contains("CREATE INDEX \"idx_orders_user\" ON \"public\".\"orders\" (\"user_id\");"));
    }

    #[test]
    fn object_catalog_selects_the_server_compatible_pg_proc_shape() {
        assert!(objects_sql_for_version(100_000).contains("proisagg"));
        assert!(!objects_sql_for_version(100_000).contains("p.prokind"));
        assert!(objects_sql_for_version(110_000).contains("p.prokind"));
        assert!(objects_sql_for_version(170_000).contains("'pg_proc'::regclass"));
    }
}
