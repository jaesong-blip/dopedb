//! Schema introspection into a serde [`Catalog`]. Always reads through the
//! connection's READ-ONLY pool. The catalog backs `get_schema`/`get_table_ddl`
//! and the local CLI catalog commands.

mod catalog_v2;
mod mysql;
mod pg;
mod sqlite;

pub(crate) use catalog_v2::{
    load_catalog_in_context, load_catalog_snapshot_in_context, snapshot_from_catalog,
    CatalogReadMode,
};

use crate::connection::{DbPool, Live};
use crate::error::{AppError, AppResult};
use crate::features::catalog::{
    Catalog, CatalogOverview, Column, DatabaseObject, DatabaseSummary, ForeignKey, Index, Table,
};

/// Introspect a live connection's schema. SQL engines read via the read-only
/// pool; MongoDB lists collections with sampled field structure.
pub async fn introspect(conn: &Live) -> AppResult<Catalog> {
    match conn {
        Live::Sql(live) => match live.ro() {
            DbPool::Postgres(pool) => pg::introspect(pool).await,
            DbPool::Mysql(pool) => mysql::introspect(pool, live.skip_fk_metadata).await,
            DbPool::Sqlite(pool) => sqlite::introspect(pool).await,
        },
        Live::Mongo(conn) => crate::mongo::introspect::introspect(conn).await,
    }
}

/// Read only the complete relation tree required to open a workspace connection.
///
/// This must remain independent of the full snapshot path: callers intentionally
/// avoid the detail scan and never persist this response in the CatalogSnapshot cache.
pub(crate) async fn overview(conn: &Live) -> AppResult<CatalogOverview> {
    match conn {
        Live::Sql(live) => match live.ro() {
            DbPool::Postgres(pool) => pg::overview(pool).await,
            DbPool::Mysql(pool) => mysql::overview(pool).await,
            DbPool::Sqlite(pool) => sqlite::overview(pool).await,
        },
        Live::Mongo(conn) => crate::mongo::introspect::overview(conn).await,
    }
}

/// Discover databases reachable through the credential behind one connection.
///
/// Engines expose different server/catalog concepts, so the adapter returns only
/// names that can be selected as a target database. The configured database remains
/// the default and is restored by the shared normalizer if a server omits it.
pub(crate) async fn databases(conn: &Live, configured: &str) -> AppResult<Vec<DatabaseSummary>> {
    let names = match conn {
        Live::Sql(live) => match live.ro() {
            DbPool::Postgres(pool) => pg::databases(pool).await?,
            DbPool::Mysql(pool) => mysql::databases(pool).await?,
            DbPool::Sqlite(_) => vec![configured.to_owned()],
        },
        Live::Mongo(conn) => crate::mongo::introspect::databases(conn).await?,
    };
    Ok(database_summaries(names, configured))
}

fn database_summaries(mut names: Vec<String>, configured: &str) -> Vec<DatabaseSummary> {
    names.retain(|name| {
        !name.is_empty() && name.len() <= 255 && !name.chars().any(char::is_control)
    });
    if !names.iter().any(|name| name == configured) {
        names.push(configured.to_owned());
    }
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|name| DatabaseSummary {
            is_default: name == configured,
            name,
        })
        .collect()
}

/// The CREATE-TABLE DDL for one table, read through the read-only pool.
///
/// - MySQL: `SHOW CREATE TABLE` (server-authoritative).
/// - SQLite: the stored `sqlite_master.sql` for the table plus its indexes.
/// - Postgres: synthesized from the catalog (NOT pg_dump-exact — see `pg::table_ddl`).
pub(crate) async fn table_ddl(live: &Live, schema: Option<&str>, table: &str) -> AppResult<String> {
    match live {
        Live::Sql(live) => match live.ro() {
            DbPool::Postgres(pool) => pg::table_ddl(pool, schema, table).await,
            DbPool::Mysql(pool) => mysql::table_ddl(pool, table).await,
            DbPool::Sqlite(pool) => sqlite::table_ddl(pool, table).await,
        },
        Live::Mongo(_) => Err(AppError::Config(
            "MongoDB collections have no SQL DDL".into(),
        )),
    }
}
