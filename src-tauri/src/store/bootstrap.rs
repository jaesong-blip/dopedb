//! Store bootstrap, compatibility migration, and sync-outbox primitives.

use super::*;

/// Add synchronizable resource columns to databases created before the workspace
/// schema existed. SQLite lacks `ADD COLUMN IF NOT EXISTS`, so duplicate errors are
/// expected and deliberately ignored after each independent statement.
pub(super) async fn add_workspace_columns(pool: &SqlitePool) {
    let statements = [
        "ALTER TABLE connections ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'",
        "ALTER TABLE connections ADD COLUMN account_user_id TEXT",
        "ALTER TABLE connections ADD COLUMN remote_id TEXT",
        "ALTER TABLE connections ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE connections ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local'",
        "ALTER TABLE connections ADD COLUMN deleted_at TEXT",
        "ALTER TABLE dashboards ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'",
        "ALTER TABLE dashboards ADD COLUMN remote_id TEXT",
        "ALTER TABLE dashboards ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE dashboards ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local'",
        "ALTER TABLE dashboards ADD COLUMN deleted_at TEXT",
        "ALTER TABLE snippets ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'",
        "ALTER TABLE snippets ADD COLUMN remote_id TEXT",
        "ALTER TABLE snippets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE snippets ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local'",
        "ALTER TABLE snippets ADD COLUMN deleted_at TEXT",
    ];
    for statement in statements {
        let _ = sqlx::query(statement).execute(pool).await;
    }
}

/// Add account-local execution scope columns to pre-multi-account databases. The
/// default preserves Personal Workspace data until a verified team membership can
/// claim legacy rows during `sync_account_workspaces`.
pub(super) async fn add_local_scope_columns(pool: &SqlitePool) {
    let statements = [
        "ALTER TABLE query_history ADD COLUMN account_scope TEXT NOT NULL DEFAULT 'personal'",
        "ALTER TABLE agent_chat_threads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'",
        "ALTER TABLE agent_chat_threads ADD COLUMN account_scope TEXT NOT NULL DEFAULT 'personal'",
    ];
    for statement in statements {
        let _ = sqlx::query(statement).execute(pool).await;
    }
}

/// Add fail-closed per-account RBAC cache fields to databases created by the first
/// workspace preview. The next successful control-plane sync replaces these defaults.
pub(super) async fn add_connection_binding_scope_columns(pool: &SqlitePool) -> AppResult<()> {
    let statements = [
        "ALTER TABLE workspace_connection_bindings ADD COLUMN workspace_access TEXT NOT NULL DEFAULT 'view'",
        "ALTER TABLE workspace_connection_bindings ADD COLUMN allow_writes INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE workspace_connection_bindings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    ];
    for statement in statements {
        if let Err(error) = sqlx::query(statement).execute(pool).await {
            let duplicate_column = matches!(
                &error,
                sqlx::Error::Database(database)
                    if database.message().contains("duplicate column name")
            );
            if !duplicate_column {
                return Err(error.into());
            }
        }
    }
    Ok(())
}

/// Create indexes only after every upgrade path has added the referenced columns.
/// Putting these in the bootstrap schema would make an older `CREATE TABLE IF NOT
/// EXISTS` database fail before its `ALTER TABLE` compatibility steps can run.
pub(super) async fn ensure_local_scope_indexes(pool: &SqlitePool) -> AppResult<()> {
    sqlx::raw_sql(
        r#"
        CREATE INDEX IF NOT EXISTS idx_connections_workspace_account
            ON connections(workspace_id, account_user_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_history_conn_scope_executed
            ON query_history(connection_id, account_scope, executed_at);
        CREATE INDEX IF NOT EXISTS idx_agent_chat_threads_scope_updated
            ON agent_chat_threads(workspace_id, account_scope, updated_at DESC);
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// `schema_cache` used to have a connection-only primary key. Rebuild it once with
/// a composite scope key so two accounts using the same shared template never reuse
/// each other's catalog. No credential or remote payload is involved.
pub(super) async fn migrate_schema_cache_scopes(pool: &SqlitePool) -> AppResult<()> {
    let has_scope: bool = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM pragma_table_info('schema_cache') WHERE name = 'account_scope'
         )",
    )
    .fetch_one(pool)
    .await?;
    if has_scope {
        return Ok(());
    }
    sqlx::raw_sql(
        r#"
        BEGIN;
        CREATE TABLE schema_cache_scoped (
            connection_id   TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            account_scope   TEXT NOT NULL DEFAULT 'personal',
            introspected_at TEXT NOT NULL,
            catalog_json    TEXT NOT NULL,
            PRIMARY KEY (connection_id, account_scope)
        );
        INSERT INTO schema_cache_scoped
            (connection_id, account_scope, introspected_at, catalog_json)
        SELECT connection_id, 'personal', introspected_at, catalog_json
        FROM schema_cache;
        DROP TABLE schema_cache;
        ALTER TABLE schema_cache_scoped RENAME TO schema_cache;
        COMMIT;
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Validate the disposable Catalog V2 cache shape before creating its index. Keeping
/// the index out of the bootstrap script lets us recover from an interrupted preview
/// that left a partial table instead of failing startup before this repair can run.
pub(super) async fn ensure_schema_cache_v2(pool: &SqlitePool) -> AppResult<()> {
    let rows = sqlx::query("PRAGMA table_info('schema_cache_v2')")
        .fetch_all(pool)
        .await?;
    let expected = [
        ("workspace_id", "TEXT", 1_i64, 1_i64, None),
        ("account_scope", "TEXT", 1, 2, None),
        ("connection_id", "TEXT", 1, 3, None),
        ("connection_revision", "INTEGER", 1, 0, None),
        ("binding_revision", "INTEGER", 1, 0, None),
        ("binding_updated_at", "TEXT", 1, 0, Some("''")),
        ("catalog_schema_version", "INTEGER", 1, 0, None),
        ("fingerprint", "TEXT", 1, 0, None),
        ("captured_at", "TEXT", 1, 0, None),
        ("catalog_json", "TEXT", 1, 0, None),
    ];
    let shape_is_current = rows.len() == expected.len()
        && expected
            .iter()
            .all(|(expected_name, expected_type, not_null, pk, default)| {
                rows.iter().any(|row| {
                    row.try_get::<String, _>("name")
                        .is_ok_and(|value| value == *expected_name)
                        && row
                            .try_get::<String, _>("type")
                            .is_ok_and(|value| value == *expected_type)
                        && row
                            .try_get::<i64, _>("notnull")
                            .is_ok_and(|value| value == *not_null)
                        && row.try_get::<i64, _>("pk").is_ok_and(|value| value == *pk)
                        && row
                            .try_get::<Option<String>, _>("dflt_value")
                            .is_ok_and(|value| value.as_deref() == *default)
                })
            });
    let foreign_keys = sqlx::query("PRAGMA foreign_key_list('schema_cache_v2')")
        .fetch_all(pool)
        .await?;
    let foreign_keys_are_current = foreign_keys.len() == 2
        && [
            ("workspace_id", "workspaces"),
            ("connection_id", "connections"),
        ]
        .iter()
        .all(|(column, table)| {
            foreign_keys.iter().any(|row| {
                row.try_get::<String, _>("from")
                    .is_ok_and(|value| value == *column)
                    && row
                        .try_get::<String, _>("table")
                        .is_ok_and(|value| value == *table)
                    && row
                        .try_get::<String, _>("to")
                        .is_ok_and(|value| value == "id")
                    && row
                        .try_get::<String, _>("on_delete")
                        .is_ok_and(|value| value == "CASCADE")
            })
        });
    if !shape_is_current || !foreign_keys_are_current {
        let mut tx = pool.begin().await?;
        sqlx::query("DROP TABLE IF EXISTS schema_cache_v2")
            .execute(&mut *tx)
            .await?;
        sqlx::raw_sql(
            r#"
            CREATE TABLE schema_cache_v2 (
                workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                account_scope         TEXT NOT NULL,
                connection_id         TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
                connection_revision   INTEGER NOT NULL,
                binding_revision      INTEGER NOT NULL,
                binding_updated_at    TEXT NOT NULL DEFAULT '',
                catalog_schema_version INTEGER NOT NULL,
                fingerprint           TEXT NOT NULL,
                captured_at           TEXT NOT NULL,
                catalog_json          TEXT NOT NULL,
                PRIMARY KEY (workspace_id, account_scope, connection_id)
            );
            "#,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    sqlx::query("DROP INDEX IF EXISTS idx_schema_cache_v2_connection")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_schema_cache_v2_connection
         ON schema_cache_v2(connection_id)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Backfill every legacy synchronizable resource into the Personal Workspace while
/// preserving its UUID. The migration copies no credential value and creates no
/// outbox payload, so local secret references cannot leak into synchronization data.
pub(super) async fn migrate_workspace_foundation(pool: &SqlitePool) -> AppResult<()> {
    let personal = migrations::PERSONAL_WORKSPACE_ID;
    let mut tx = pool.begin().await?;
    for table in ["connections", "dashboards", "snippets"] {
        let sql = format!(
            "UPDATE {table} SET workspace_id = ?1 WHERE workspace_id IS NULL OR workspace_id = ''"
        );
        sqlx::query(AssertSqlSafe(sql))
            .bind(personal)
            .execute(&mut *tx)
            .await?;
    }
    let repaired_scope = sqlx::query(
        "UPDATE app_settings SET value = ?1
         WHERE key = 'active_workspace_id'
           AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = app_settings.value)",
    )
    .bind(personal)
    .execute(&mut *tx)
    .await?;
    if repaired_scope.rows_affected() > 0 {
        bump_active_scope_generation(&mut tx).await?;
    }
    sqlx::query("INSERT OR IGNORE INTO sync_state (workspace_id) VALUES (?1)")
        .bind(personal)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Queue only mutation identity and revision. A future sync serializer may populate
/// `payload_json`, but must explicitly redact `secret_ref` before doing so.
pub(super) async fn enqueue_outbox(
    tx: &mut Transaction<'_, Sqlite>,
    workspace_id: Uuid,
    resource_type: &str,
    resource_id: Uuid,
    operation: &str,
    revision: i64,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO sync_outbox
         (id, workspace_id, resource_type, resource_id, operation, revision, payload_json, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,NULL,?7)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(workspace_id.to_string())
    .bind(resource_type)
    .bind(resource_id.to_string())
    .bind(operation)
    .bind(revision)
    .bind(Utc::now())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Startup migration: rebuild `audit_log` WITHOUT the old `ON DELETE CASCADE` so a
/// connection deletion can never erase its compliance history. Idempotent — only fires
/// when the stored table def still carries the cascade (fresh DBs skip it).
pub(super) async fn migrate_audit_no_cascade(pool: &SqlitePool) -> AppResult<()> {
    let def: Option<String> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'")
            .fetch_optional(pool)
            .await?;
    // Only the old schema mentions CASCADE (the new one has no FK at all).
    if !def
        .as_deref()
        .map(|s| s.to_uppercase().contains("CASCADE"))
        .unwrap_or(false)
    {
        return Ok(());
    }

    // SQLite can't ALTER away a constraint — rebuild the table, preserving every row.
    // audit_log has no incoming FKs, so this is safe with foreign_keys enabled.
    sqlx::raw_sql(
        r#"
        BEGIN;
        CREATE TABLE audit_log_new (
            id                TEXT PRIMARY KEY,
            connection_id     TEXT NOT NULL,
            ts                TEXT NOT NULL,
            engine            TEXT NOT NULL,
            agent_prompt      TEXT,
            sql               TEXT NOT NULL,
            kind              TEXT NOT NULL,
            action            TEXT NOT NULL,
            approved_by       TEXT,
            affected_estimate INTEGER,
            error             TEXT,
            prev_hash         TEXT,
            hash              TEXT NOT NULL
        );
        INSERT INTO audit_log_new
            SELECT id, connection_id, ts, engine, agent_prompt, sql, kind, action,
                   approved_by, affected_estimate, error, prev_hash, hash
            FROM audit_log;
        DROP TABLE audit_log;
        ALTER TABLE audit_log_new RENAME TO audit_log;
        CREATE INDEX IF NOT EXISTS idx_audit_conn ON audit_log(connection_id, ts);
        COMMIT;
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) fn dashboard_scope_changed() -> AppError {
    AppError::Blocked {
        reason: "workspace, connection, or dashboard changed; retry the operation".into(),
    }
}
