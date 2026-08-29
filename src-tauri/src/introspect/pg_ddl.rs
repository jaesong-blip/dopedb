use std::fmt::Write;

use sqlx::PgPool;

use super::{introspect, Table};
use crate::error::{AppError, AppResult};

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
