//! Schema introspection into a serde [`Catalog`]. Always reads through the
//! connection's READ-ONLY pool. The catalog backs `get_schema`/`get_table_ddl`
//! and the local CLI catalog commands.

mod catalog_v2;
mod mysql;
mod pg;
mod sqlite;

pub(crate) use catalog_v2::{load_catalog, load_catalog_snapshot, CatalogReadMode};

use crate::connection::{DbPool, Live};
use crate::error::{AppError, AppResult};
use crate::features::catalog::{Catalog, Column, DatabaseObject, ForeignKey, Index, Table};

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
