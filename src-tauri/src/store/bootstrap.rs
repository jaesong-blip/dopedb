//! Store bootstrap, compatibility migration, and sync-outbox primitives.

use super::*;

/// Version 1 introduced ordered local migrations. Version 2 adds bounded Activity
/// paging indexes; version 3 adds the server revision and publication metadata
/// needed to synchronize dashboard definitions without synchronizing result rows.
/// Version 4 makes Personal dashboards explicitly local and removes historical
/// outbox rows that could never have a hosted destination.
pub(super) const LOCAL_SCHEMA_VERSION: i64 = 4;

pub(super) async fn migrate_local_store(pool: &SqlitePool) -> AppResult<bool> {
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await?;
    if version > LOCAL_SCHEMA_VERSION {
        return Err(AppError::Config(format!(
            "local database schema version {version} is newer than this app supports ({LOCAL_SCHEMA_VERSION})"
        )));
    }
    if version == LOCAL_SCHEMA_VERSION {
        return Ok(false);
    }

    let mut migrated = false;
    if version < 1 {
        // Version zero covers both a fresh database and every pre-versioned DopeDB
        // database. The compatibility checks are explicit schema reads, so expected
        // duplicate-column errors are never part of the successful startup path.
        sqlx::raw_sql(migrations::SCHEMA).execute(pool).await?;
        add_legacy_columns(pool).await?;
        add_sql_document_database_scope(pool).await?;
        add_workspace_columns(pool).await?;
        migrate_workspace_foundation(pool).await?;
        migrate_audit_no_cascade(pool).await?;
        add_local_scope_columns(pool).await?;
        add_connection_binding_scope_columns(pool).await?;
        migrate_agent_acp_providers(pool).await?;
        migrate_schema_cache_scopes(pool).await?;
        ensure_schema_cache_v2(pool).await?;
        ensure_local_scope_indexes(pool).await?;
        set_local_schema_version(pool, 1).await?;
        migrated = true;
    }
    if version < 2 {
        ensure_activity_paging_indexes(pool).await?;
        set_local_schema_version(pool, 2).await?;
        migrated = true;
    }
    if version < 3 {
        add_dashboard_sync_columns(pool).await?;
        set_local_schema_version(pool, 3).await?;
        migrated = true;
    }
    if version < 4 {
        normalize_personal_dashboard_sync(pool).await?;
        set_local_schema_version(pool, 4).await?;
        migrated = true;
    }
    Ok(migrated)
}

async fn normalize_personal_dashboard_sync(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "DELETE FROM sync_outbox
         WHERE resource_type = 'dashboard'
           AND workspace_id IN (SELECT id FROM workspaces WHERE kind = 'personal')",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE dashboards
         SET remote_id = NULL, remote_revision = NULL, sync_status = 'local',
             owner_member_id = NULL, updated_by_member_id = NULL
         WHERE workspace_id IN (SELECT id FROM workspaces WHERE kind = 'personal')",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn add_dashboard_sync_columns(pool: &SqlitePool) -> AppResult<()> {
    let columns = [
        (
            "remote_revision",
            "ALTER TABLE dashboards ADD COLUMN remote_revision INTEGER CHECK(remote_revision IS NULL OR remote_revision > 0)",
        ),
        (
            "state",
            "ALTER TABLE dashboards ADD COLUMN state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft', 'published', 'archived'))",
        ),
        (
            "owner_member_id",
            "ALTER TABLE dashboards ADD COLUMN owner_member_id TEXT",
        ),
        (
            "updated_by_member_id",
            "ALTER TABLE dashboards ADD COLUMN updated_by_member_id TEXT",
        ),
    ];
    for (column, statement) in columns {
        add_column_if_missing(pool, "dashboards", column, statement).await?;
    }
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_dashboards_workspace_sync
         ON dashboards(workspace_id, sync_status, updated_at DESC)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn set_local_schema_version(pool: &SqlitePool, version: i64) -> AppResult<()> {
    sqlx::query(AssertSqlSafe(format!("PRAGMA user_version = {version}")))
        .execute(pool)
        .await?;
    Ok(())
}

async fn ensure_activity_paging_indexes(pool: &SqlitePool) -> AppResult<()> {
    sqlx::raw_sql(
        "CREATE INDEX IF NOT EXISTS idx_history_scope_recent
             ON query_history(connection_id, account_scope, executed_at DESC);
         CREATE INDEX IF NOT EXISTS idx_audit_connection_row
             ON audit_log(connection_id);",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn column_exists(pool: &SqlitePool, table: &str, column: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
    )
    .bind(table)
    .bind(column)
    .fetch_one(pool)
    .await?
        != 0)
}

async fn add_column_if_missing(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    statement: &'static str,
) -> AppResult<()> {
    if !column_exists(pool, table, column).await? {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

async fn add_legacy_columns(pool: &SqlitePool) -> AppResult<()> {
    let columns = [
        ("connections", "env", "ALTER TABLE connections ADD COLUMN env TEXT"),
        (
            "connections",
            "schema_group",
            "ALTER TABLE connections ADD COLUMN schema_group TEXT",
        ),
        (
            "connections",
            "provider",
            "ALTER TABLE connections ADD COLUMN provider TEXT NOT NULL DEFAULT 'auto'",
        ),
        (
            "connections",
            "driver_id",
            "ALTER TABLE connections ADD COLUMN driver_id TEXT",
        ),
        (
            "connections",
            "workspace_access",
            "ALTER TABLE connections ADD COLUMN workspace_access TEXT NOT NULL DEFAULT 'local'",
        ),
        (
            "connections",
            "credential_mode",
            "ALTER TABLE connections ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'local'",
        ),
        (
            "connections",
            "provider_target",
            "ALTER TABLE connections ADD COLUMN provider_target TEXT",
        ),
        (
            "agent_chat_threads",
            "connection_id",
            "ALTER TABLE agent_chat_threads ADD COLUMN connection_id TEXT",
        ),
        (
            "jobs",
            "pause_requested",
            "ALTER TABLE jobs ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0, 1))",
        ),
        (
            "sql_documents",
            "selected_schema",
            "ALTER TABLE sql_documents ADD COLUMN selected_schema TEXT",
        ),
        (
            "sql_documents",
            "resolve_mode",
            "ALTER TABLE sql_documents ADD COLUMN resolve_mode TEXT NOT NULL DEFAULT 'playground' CHECK(resolve_mode IN ('playground', 'script'))",
        ),
    ];
    for (table, column, statement) in columns {
        add_column_if_missing(pool, table, column, statement).await?;
    }
    Ok(())
}

/// Add the database scope selected by each SQL document and seed legacy rows from
/// the connection column's persisted SQLite name. Rust exposes that value as
/// `ConnectionProfile::database`, but the store schema has always called it
/// `connections.db_name`.
pub(super) async fn add_sql_document_database_scope(pool: &SqlitePool) -> AppResult<()> {
    add_column_if_missing(
        pool,
        "sql_documents",
        "selected_database",
        "ALTER TABLE sql_documents ADD COLUMN selected_database TEXT",
    )
    .await?;
    sqlx::query(
        "UPDATE sql_documents
         SET selected_database = (
           SELECT connections.db_name
           FROM connections
           WHERE connections.id = sql_documents.connection_id
         )
         WHERE selected_database IS NULL",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Add synchronizable resource columns to databases created before the workspace
/// schema existed. SQLite lacks `ADD COLUMN IF NOT EXISTS`, so each statement is
/// preceded by an explicit `pragma_table_info` check.
pub(super) async fn add_workspace_columns(pool: &SqlitePool) -> AppResult<()> {
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
        let column = statement
            .split_whitespace()
            .nth(5)
            .expect("workspace compatibility statement names its column");
        let table = statement
            .split_whitespace()
            .nth(2)
            .expect("workspace compatibility statement names its table");
        add_column_if_missing(pool, table, column, statement).await?;
    }
    Ok(())
}

/// Add account-local execution scope columns to pre-multi-account databases. The
/// default preserves Personal Workspace data until a verified team membership can
/// claim legacy rows during `sync_account_workspaces`.
pub(super) async fn add_local_scope_columns(pool: &SqlitePool) -> AppResult<()> {
    let statements = [
        "ALTER TABLE query_history ADD COLUMN account_scope TEXT NOT NULL DEFAULT 'personal'",
        "ALTER TABLE agent_chat_threads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'",
        "ALTER TABLE agent_chat_threads ADD COLUMN account_scope TEXT NOT NULL DEFAULT 'personal'",
    ];
    for statement in statements {
        let column = statement
            .split_whitespace()
            .nth(5)
            .expect("scope compatibility statement names its column");
        let table = statement
            .split_whitespace()
            .nth(2)
            .expect("scope compatibility statement names its table");
        add_column_if_missing(pool, table, column, statement).await?;
    }
    Ok(())
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
        let column = statement
            .split_whitespace()
            .nth(5)
            .expect("binding compatibility statement names its column");
        add_column_if_missing(pool, "workspace_connection_bindings", column, statement).await?;
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

/// Expand the ACP session provider constraint introduced with the Codex-only
/// preview. SQLite cannot alter a CHECK constraint in place, so rebuild the parent
/// and its event child together while preserving both tables' rows and cascade.
pub(super) async fn migrate_agent_acp_providers(pool: &SqlitePool) -> AppResult<()> {
    let definition: Option<String> = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'agent_acp_sessions'",
    )
    .fetch_optional(pool)
    .await?;
    if definition
        .as_deref()
        .is_some_and(|sql| sql.contains("'claude'"))
    {
        return Ok(());
    }

    let mut transaction = pool.begin().await?;
    sqlx::raw_sql(
        r#"
        CREATE TABLE agent_acp_sessions_provider_migration (
            id             TEXT PRIMARY KEY,
            connection_id  TEXT NOT NULL,
            workspace_id   TEXT NOT NULL,
            account_scope  TEXT NOT NULL,
            provider       TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
            title          TEXT NOT NULL,
            lifecycle      TEXT NOT NULL CHECK(lifecycle IN (
                               'starting', 'ready', 'running', 'waiting_permission',
                               'failed', 'closed'
                           )),
            acp_session_id TEXT,
            error          TEXT,
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        );
        INSERT INTO agent_acp_sessions_provider_migration
            (id, connection_id, workspace_id, account_scope, provider, title,
             lifecycle, acp_session_id, error, created_at, updated_at)
        SELECT id, connection_id, workspace_id, account_scope, provider, title,
               lifecycle, acp_session_id, error, created_at, updated_at
        FROM agent_acp_sessions;

        CREATE TABLE agent_acp_events_provider_migration (
            session_id  TEXT NOT NULL
                        REFERENCES agent_acp_sessions_provider_migration(id) ON DELETE CASCADE,
            sequence    INTEGER NOT NULL CHECK(sequence > 0),
            created_at  TEXT NOT NULL,
            payload     TEXT NOT NULL CHECK(length(payload) <= 524288),
            PRIMARY KEY(session_id, sequence)
        );
        INSERT INTO agent_acp_events_provider_migration
            (session_id, sequence, created_at, payload)
        SELECT session_id, sequence, created_at, payload
        FROM agent_acp_events;

        DROP TABLE agent_acp_events;
        DROP TABLE agent_acp_sessions;
        ALTER TABLE agent_acp_sessions_provider_migration
            RENAME TO agent_acp_sessions;
        ALTER TABLE agent_acp_events_provider_migration
            RENAME TO agent_acp_events;
        CREATE INDEX idx_agent_acp_sessions_scope
            ON agent_acp_sessions(workspace_id, account_scope, updated_at DESC);
        CREATE INDEX idx_agent_acp_events_session
            ON agent_acp_events(session_id, sequence);
        "#,
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
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

/// Queue mutation identity and revision for projected resources. Evidence-bound
/// reports use a separate strict serializer because they have no desktop projection;
/// every other caller keeps `payload_json` NULL and can never serialize `secret_ref`.
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
