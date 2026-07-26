//! Live connection pools. A write-capable [`LiveConnection`] holds TWO pools: a normal
//! read/write pool and a separate read-only pool. A read acquisition holds ONLY the
//! read-only pool and aliases it into the legacy `write_pool` field for API compatibility.
//! The read-only pool is the first line of L2 enforcement at the connection level — but
//! the authoritative boundary remains the per-request read-only transaction the executor opens:
//!   - Postgres: `after_connect` sets `default_transaction_read_only = on`.
//!   - MySQL:    `after_connect` sets `SESSION transaction_read_only = 1`.
//!   - SQLite:   a second handle opened `read_only(true)` (file-level, unforgeable).

use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Executor;

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionProfile, Engine, WorkspaceCredentialMode};

use super::providers;

const MAX_CONNS: u32 = 5;
// Managed write profiles create one read and one write pool. Two connections per pool
// keep their combined maximum aligned with Neon's lease-role CONNECTION LIMIT 4; a
// managed read profile opens only its read pool.
const MANAGED_MAX_CONNS_PER_POOL: u32 = 2;

fn pool_connection_limit(mode: WorkspaceCredentialMode) -> u32 {
    if mode == WorkspaceCredentialMode::Managed {
        MANAGED_MAX_CONNS_PER_POOL
    } else {
        MAX_CONNS
    }
}

/// A live sqlx pool for one of the three supported engines. Cheap to clone — each
/// inner sqlx pool is an `Arc` handle.
#[derive(Clone)]
pub enum DbPool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
}

impl DbPool {
    /// `SELECT 1` liveness probe.
    pub async fn ping(&self) -> AppResult<()> {
        match self {
            DbPool::Postgres(p) => {
                sqlx::query("SELECT 1").execute(p).await?;
            }
            DbPool::Mysql(p) => {
                sqlx::query("SELECT 1").execute(p).await?;
            }
            DbPool::Sqlite(p) => {
                sqlx::query("SELECT 1").execute(p).await?;
            }
        }
        Ok(())
    }

    /// Close the shared SQLx pool and wake tasks waiting to acquire a connection.
    pub async fn close(&self) {
        match self {
            DbPool::Postgres(pool) => pool.close().await,
            DbPool::Mysql(pool) => pool.close().await,
            DbPool::Sqlite(pool) => pool.close().await,
        }
    }
}

/// An open connection. Write acquisitions contain separate read/write and read-only
/// pools; read acquisitions contain only the L2-enforced read-only pool. Each `DbPool`
/// variant is self-describing and cheaply cloned through its inner `Arc`.
///
/// Field names are the executor's legacy contract: for a read-only live value,
/// `write_pool` aliases `read_pool` and remains DB-enforced read-only. `DbPool` is
/// also re-exported as `connection::Pool` for that module.
#[derive(Clone)]
pub struct LiveConnection {
    /// L2-enforced read-only pool. Reads and read previews route through this.
    pub read_pool: DbPool,
    /// Read/write pool for write acquisitions; aliases the read-only pool for reads.
    pub write_pool: DbPool,
    /// Whether `write_pool` is a separately opened write-capable target pool.
    pub(crate) has_writable_pool: bool,
    /// True for PlanetScale/Vitess — introspection must skip FK metadata.
    pub skip_fk_metadata: bool,
}

impl LiveConnection {
    /// The read-only pool. Reads and all read previews route through this.
    pub fn ro(&self) -> &DbPool {
        &self.read_pool
    }

    /// Whether this live value opened a target write pool.
    #[cfg(test)]
    pub(crate) fn has_writable_pool(&self) -> bool {
        self.has_writable_pool
    }

    /// `SELECT 1` against the live server.
    pub async fn test(&self) -> AppResult<()> {
        self.read_pool.ping().await
    }

    /// Close both underlying pools for a lease or connection that is no longer valid.
    pub async fn close(&self) {
        if self.has_writable_pool {
            tokio::join!(self.read_pool.close(), self.write_pool.close());
        } else {
            self.read_pool.close().await;
        }
    }
}

/// Finish opening a writable pool after its read-only companion is live.  If the
/// second connection fails, the already-open read pool must not outlive a failed
/// acquisition (notably because SQLite then keeps a file handle on Windows).
async fn writable_pool_or_close_read<T>(
    read_pool: &DbPool,
    writable_pool: Result<T, sqlx::Error>,
) -> AppResult<T> {
    match writable_pool {
        Ok(pool) => Ok(pool),
        Err(error) => {
            read_pool.close().await;
            Err(error.into())
        }
    }
}

/// SQLx adapter entrypoint. Driver selection and compatibility validation live in
/// `crate::driver`; this module only builds the concrete SQLx pools.
pub(crate) async fn connect_sqlx(
    adapter_engine: Engine,
    profile: &ConnectionProfile,
    secret: &str,
    writable: bool,
) -> AppResult<LiveConnection> {
    if adapter_engine != profile.engine {
        return Err(AppError::Config(format!(
            "SQLx {:?} adapter cannot open a {:?} profile",
            adapter_engine, profile.engine
        )));
    }
    let skip_fk_metadata = providers::skip_fk_metadata(profile);
    let acquire = providers::connect_timeout(profile);
    let max_connections = pool_connection_limit(profile.credential_mode);

    let (write_pool, read_pool, has_writable_pool) = match adapter_engine {
        Engine::Postgres => {
            let base = PgConnectOptions::new()
                .host(&profile.host)
                .port(profile.port)
                .database(&profile.database)
                .username(&profile.username)
                .password(secret)
                .ssl_mode(pg_ssl_mode(&profile.sslmode)?);
            let base = providers::apply_pg_tuning(profile, base);

            let ro = PgPoolOptions::new()
                .max_connections(max_connections)
                .acquire_timeout(acquire)
                .after_connect(|conn, _meta| {
                    Box::pin(async move {
                        conn.execute("SET default_transaction_read_only = on")
                            .await?;
                        Ok(())
                    })
                })
                .connect_with(base)
                .await?;
            let ro = DbPool::Postgres(ro);
            if writable {
                let rw = writable_pool_or_close_read(
                    &ro,
                    PgPoolOptions::new()
                        .max_connections(max_connections)
                        .acquire_timeout(acquire)
                        .connect_with(providers::apply_pg_tuning(
                            profile,
                            PgConnectOptions::new()
                                .host(&profile.host)
                                .port(profile.port)
                                .database(&profile.database)
                                .username(&profile.username)
                                .password(secret)
                                .ssl_mode(pg_ssl_mode(&profile.sslmode)?),
                        ))
                        .await,
                )
                .await?;
                (DbPool::Postgres(rw), ro, true)
            } else {
                (ro.clone(), ro, false)
            }
        }
        Engine::Mysql => {
            let base = MySqlConnectOptions::new()
                .host(&profile.host)
                .port(profile.port)
                .database(&profile.database)
                .username(&profile.username)
                .password(secret)
                .ssl_mode(mysql_ssl_mode(&profile.sslmode)?);
            let base = providers::apply_mysql_tuning(profile, base);

            let ro = MySqlPoolOptions::new()
                .max_connections(max_connections)
                .acquire_timeout(acquire)
                .after_connect(|conn, _meta| {
                    Box::pin(async move {
                        // Fail CLOSED: the read pool must be genuinely read-only. Try the
                        // modern variable, then the legacy MariaDB name; if neither exists,
                        // reject the connection rather than hand back a writable read pool.
                        if conn
                            .execute("SET SESSION transaction_read_only = 1")
                            .await
                            .is_err()
                            && conn.execute("SET SESSION tx_read_only = 1").await.is_err()
                        {
                            return Err(sqlx::Error::Configuration(
                                "read-only pool: server accepts neither `transaction_read_only` \
                                 nor `tx_read_only` — refusing a silently writable read pool"
                                    .into(),
                            ));
                        }
                        Ok(())
                    })
                })
                .connect_with(base)
                .await?;
            let ro = DbPool::Mysql(ro);
            if writable {
                let rw = writable_pool_or_close_read(
                    &ro,
                    MySqlPoolOptions::new()
                        .max_connections(max_connections)
                        .acquire_timeout(acquire)
                        .connect_with(providers::apply_mysql_tuning(
                            profile,
                            MySqlConnectOptions::new()
                                .host(&profile.host)
                                .port(profile.port)
                                .database(&profile.database)
                                .username(&profile.username)
                                .password(secret)
                                .ssl_mode(mysql_ssl_mode(&profile.sslmode)?),
                        ))
                        .await,
                )
                .await?;
                (DbPool::Mysql(rw), ro, true)
            } else {
                (ro.clone(), ro, false)
            }
        }
        Engine::Sqlite => {
            // For SQLite the file path lives in `database`; host/port/user unused.
            let path = &profile.database;
            // Unforgeable file-level read-only handle.
            let ro_opts = SqliteConnectOptions::new().filename(path).read_only(true);
            let ro = SqlitePoolOptions::new()
                .max_connections(max_connections)
                .connect_with(ro_opts)
                .await?;
            let ro = DbPool::Sqlite(ro);
            if writable {
                let rw_opts = SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(false);
                let rw = writable_pool_or_close_read(
                    &ro,
                    SqlitePoolOptions::new()
                        .max_connections(max_connections)
                        .connect_with(rw_opts)
                        .await,
                )
                .await?;
                (DbPool::Sqlite(rw), ro, true)
            } else {
                (ro.clone(), ro, false)
            }
        }
        Engine::Mongodb => {
            return Err(AppError::Config(
                "MongoDB must be opened through its document database adapter".into(),
            ))
        }
    };

    Ok(LiveConnection {
        read_pool,
        write_pool,
        has_writable_pool,
        skip_fk_metadata,
    })
}

// Fail CLOSED on unknown sslmode: a typo like "verrify-full" must NOT silently
// downgrade to a non-verifying mode. Trim + lowercase; empty means "unspecified"
// and keeps the platform default; anything else unknown is a config error.
fn pg_ssl_mode(mode: &str) -> AppResult<PgSslMode> {
    Ok(match mode.trim().to_ascii_lowercase().as_str() {
        "" => PgSslMode::Prefer, // ponytail: empty = unspecified, not a typo
        "disable" => PgSslMode::Disable,
        "allow" => PgSslMode::Allow,
        "prefer" => PgSslMode::Prefer,
        "require" => PgSslMode::Require,
        "verify-ca" | "verify_ca" => PgSslMode::VerifyCa,
        "verify-full" | "verify_full" => PgSslMode::VerifyFull,
        other => {
            return Err(AppError::Config(format!(
                "unknown Postgres sslmode {other:?} — use disable/allow/prefer/require/verify-ca/verify-full"
            )))
        }
    })
}

fn mysql_ssl_mode(mode: &str) -> AppResult<MySqlSslMode> {
    Ok(match mode.trim().to_ascii_lowercase().as_str() {
        "" => MySqlSslMode::Preferred, // ponytail: empty = unspecified, not a typo
        "disable" | "disabled" => MySqlSslMode::Disabled,
        "prefer" | "preferred" => MySqlSslMode::Preferred,
        "require" | "required" => MySqlSslMode::Required,
        "verify-ca" | "verify_ca" => MySqlSslMode::VerifyCa,
        "verify-identity" | "verify_identity" | "verify-full" => MySqlSslMode::VerifyIdentity,
        other => {
            return Err(AppError::Config(format!(
                "unknown MySQL sslmode {other:?} — use disabled/preferred/required/verify-ca/verify-identity"
            )))
        }
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use uuid::Uuid;

    use super::*;

    fn sqlite_profile(path: String) -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::new_v4(),
            name: "read-only-test".into(),
            engine: Engine::Sqlite,
            provider: crate::model::Provider::Generic,
            driver_id: None,
            host: String::new(),
            port: 0,
            database: path,
            username: String::new(),
            sslmode: String::new(),
            extra_params: HashMap::new(),
            readonly_default: true,
            allow_writes: true,
            secret_ref: None,
            env: None,
            schema_group: None,
            workspace_access: crate::model::WorkspaceConnectionAccess::Local,
            credential_mode: WorkspaceCredentialMode::Local,
        }
    }

    async fn prepared_sqlite_file() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("dopedb-read-pool-{}.sqlite", Uuid::new_v4()));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE values_for_access_test (value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        path
    }

    #[test]
    fn pg_sslmode_documented_values_ok() {
        assert!(matches!(
            pg_ssl_mode("verify-full"),
            Ok(PgSslMode::VerifyFull)
        ));
        // trailing space / mixed case still resolve, not error
        assert!(matches!(pg_ssl_mode("  Require "), Ok(PgSslMode::Require)));
    }

    #[test]
    fn pg_sslmode_unknown_errors() {
        // typo must fail closed, never silently downgrade to Prefer
        assert!(pg_ssl_mode("verrify-full").is_err());
    }

    #[test]
    fn mysql_sslmode_documented_values_ok() {
        assert!(matches!(
            mysql_ssl_mode("VERIFY-IDENTITY"),
            Ok(MySqlSslMode::VerifyIdentity)
        ));
    }

    #[test]
    fn mysql_sslmode_unknown_errors() {
        assert!(mysql_ssl_mode("prefered").is_err());
    }

    #[test]
    fn managed_pool_pair_stays_within_neon_role_limit() {
        let per_pool = pool_connection_limit(WorkspaceCredentialMode::Managed);
        assert_eq!(per_pool, 2);
        assert_eq!(per_pool * 2, 4);
        assert_eq!(pool_connection_limit(WorkspaceCredentialMode::Local), 5);
    }

    #[tokio::test]
    async fn read_sqlite_opens_no_write_pool_and_legacy_slot_stays_read_only() {
        let path = prepared_sqlite_file().await;
        let live = connect_sqlx(
            Engine::Sqlite,
            &sqlite_profile(path.to_string_lossy().into_owned()),
            "",
            false,
        )
        .await
        .unwrap();

        assert!(!live.has_writable_pool());
        let DbPool::Sqlite(legacy_write_slot) = &live.write_pool else {
            panic!("expected sqlite legacy slot");
        };
        assert!(
            sqlx::query("INSERT INTO values_for_access_test VALUES ('blocked')")
                .execute(legacy_write_slot)
                .await
                .is_err()
        );

        live.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn approved_write_sqlite_opens_a_dedicated_write_pool() {
        let path = prepared_sqlite_file().await;
        let live = connect_sqlx(
            Engine::Sqlite,
            &sqlite_profile(path.to_string_lossy().into_owned()),
            "",
            true,
        )
        .await
        .unwrap();

        assert!(live.has_writable_pool());
        let DbPool::Sqlite(write_pool) = &live.write_pool else {
            panic!("expected sqlite write pool");
        };
        sqlx::query("INSERT INTO values_for_access_test VALUES ('approved')")
            .execute(write_pool)
            .await
            .unwrap();

        live.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn failed_writable_pool_construction_closes_the_read_pool() {
        let pool = SqlitePoolOptions::new()
            .connect_lazy("sqlite::memory:")
            .unwrap();
        let read_pool = DbPool::Sqlite(pool.clone());

        assert!(writable_pool_or_close_read::<SqlitePool>(
            &read_pool,
            Err(sqlx::Error::PoolClosed),
        )
        .await
        .is_err());
        assert!(pool.is_closed());
    }
}
