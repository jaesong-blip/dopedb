//! Creates the bundled, local SQLite learning database used by the first-run
//! Data Source launcher. The file lives under the app-local data directory and
//! is seeded idempotently so opening the demo never overwrites user edits.

use std::path::{Path, PathBuf};

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};
use tauri::Manager;

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionProfile, Engine};

const DEMO_FILE_NAME: &str = "dopedb-demo-v1.sqlite";

const DEMO_SQL: &[&str] = &[
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        segment TEXT NOT NULL,
        created_at TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        unit_price REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
    )",
    "CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        status TEXT NOT NULL,
        total REAL NOT NULL,
        created_at TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL,
        unit_price REAL NOT NULL
    )",
    "CREATE VIEW IF NOT EXISTS monthly_revenue AS
        SELECT substr(created_at, 1, 7) AS month,
               round(sum(total), 2) AS revenue,
               count(*) AS order_count
        FROM orders
        WHERE status IN ('paid', 'shipped')
        GROUP BY substr(created_at, 1, 7)",
    "INSERT OR IGNORE INTO customers
        (id, name, email, segment, created_at) VALUES
        (1, 'Mina Park', 'mina.park@example.test', 'enterprise', '2026-01-08T09:20:00Z'),
        (2, 'Noah Williams', 'noah.williams@example.test', 'growth', '2026-01-19T14:10:00Z'),
        (3, 'Sofia Chen', 'sofia.chen@example.test', 'startup', '2026-02-03T11:45:00Z'),
        (4, 'Mateo Silva', 'mateo.silva@example.test', 'growth', '2026-02-24T16:05:00Z'),
        (5, 'Ava Thompson', 'ava.thompson@example.test', 'enterprise', '2026-03-12T08:32:00Z')",
    "INSERT OR IGNORE INTO products
        (id, sku, name, category, unit_price, active) VALUES
        (1, 'DB-OBS-100', 'Query observability pack', 'software', 129.00, 1),
        (2, 'DB-SAFE-210', 'Write safety controls', 'software', 249.00, 1),
        (3, 'DB-MIG-330', 'Migration review kit', 'service', 499.00, 1),
        (4, 'DB-AUD-410', 'Audit export bundle', 'service', 89.00, 1),
        (5, 'DB-ARC-500', 'Archive storage add-on', 'storage', 39.00, 1)",
    "INSERT OR IGNORE INTO orders
        (id, customer_id, status, total, created_at) VALUES
        (10101, 1, 'paid', 378.00, '2026-04-02T08:03:00Z'),
        (10102, 3, 'paid', 168.00, '2026-04-02T08:21:00Z'),
        (10103, 2, 'processing', 92.10, '2026-04-02T08:35:00Z'),
        (10104, 5, 'shipped', 184.25, '2026-04-02T08:41:00Z'),
        (10105, 4, 'refunded', 89.00, '2026-04-04T10:16:00Z'),
        (10106, 1, 'paid', 538.00, '2026-05-07T12:24:00Z'),
        (10107, 2, 'shipped', 288.00, '2026-05-12T15:09:00Z'),
        (10108, 5, 'paid', 667.00, '2026-06-01T07:42:00Z')",
    "INSERT OR IGNORE INTO order_items
        (id, order_id, product_id, quantity, unit_price) VALUES
        (1, 10101, 1, 1, 129.00),
        (2, 10101, 2, 1, 249.00),
        (3, 10102, 1, 1, 129.00),
        (4, 10102, 5, 1, 39.00),
        (5, 10103, 4, 1, 89.00),
        (6, 10104, 1, 1, 129.00),
        (7, 10104, 5, 1, 39.00),
        (8, 10105, 4, 1, 89.00),
        (9, 10106, 2, 1, 249.00),
        (10, 10106, 3, 1, 289.00),
        (11, 10107, 1, 1, 129.00),
        (12, 10107, 4, 1, 89.00),
        (13, 10107, 5, 2, 35.00),
        (14, 10108, 2, 1, 249.00),
        (15, 10108, 3, 1, 379.00),
        (16, 10108, 5, 1, 39.00)",
];

pub(crate) async fn create(app: &tauri::AppHandle) -> AppResult<String> {
    let path = demo_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| AppError::Config("demo database directory is unavailable".into()))?;
    tokio::fs::create_dir_all(&directory).await?;
    create_at(&path).await?;

    path.into_os_string()
        .into_string()
        .map_err(|_| AppError::Config("demo database path is not valid UTF-8".into()))
}

pub(crate) async fn remove_if_unreferenced(
    app: &tauri::AppHandle,
    deleted: &ConnectionProfile,
    remaining: &[ConnectionProfile],
) -> AppResult<bool> {
    let path = demo_path(app)?;
    if deleted.engine != Engine::Sqlite || Path::new(&deleted.database) != path {
        return Ok(false);
    }
    if remaining
        .iter()
        .any(|profile| profile.engine == Engine::Sqlite && Path::new(&profile.database) == path)
    {
        return Ok(false);
    }

    let mut removed = remove_file_if_present(&path).await?;
    for suffix in ["-wal", "-shm", "-journal"] {
        removed |= remove_file_if_present(&sqlite_sidecar_path(&path, suffix)).await?;
    }
    Ok(removed)
}

fn demo_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| AppError::Config(format!("demo database path unavailable: {error}")))?
        .join("demos")
        .join(DEMO_FILE_NAME))
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut sidecar = path.as_os_str().to_os_string();
    sidecar.push(suffix);
    PathBuf::from(sidecar)
}

async fn remove_file_if_present(path: &Path) -> AppResult<bool> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

async fn create_at(path: &Path) -> AppResult<()> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options).await?;
    let mut transaction = connection.begin().await?;
    for &statement in DEMO_SQL {
        sqlx::query(statement).execute(&mut *transaction).await?;
    }
    transaction.commit().await?;
    Ok(())
}
