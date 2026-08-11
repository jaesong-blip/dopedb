//! Store bootstrap and compatibility migrations.

use super::*;
use sqlx::Acquire;

/// Version 1 introduced ordered local migrations. Version 2 adds bounded Activity
/// paging indexes. Version 5 replaces the workspace-only hosted pull checkpoint
/// with an account-scoped cursor table.
/// Version 7 adds immutable Project Knowledge revisions and an atomically selected
/// last-good head. Version 8 stores only a bounded source manifest so incremental
/// extraction can compare content hashes; roots, credentials, and source bodies
/// still have no representable column. Version 9 makes the last-good head
/// source-specific so an Environment can own multiple active graph revisions.
/// Version 10 binds multiple exact connection revisions to that Environment.
/// Version 11 pins an Environment KnowledgeGrant to its complete graph revision set.
/// Version 12 persists the exact Knowledge scope of resumable ACP sessions.
/// Version 13 adds the session's immutable Environment connection allowlist.
/// Version 14 persists the exact member KnowledgeGrant used by a resumable session.
/// Versions 15–16 hosted retired Funnel/Signal prototypes. Version 17 removes
/// every executable local BI projection. Version 18 adds the device-local sample
/// store used by the Analysis Article runner; definitions remain control-plane
/// authoritative and result recovery remains encrypted. Version 19 replaces the
/// final retired Dashboard operation vocabulary while preserving its immutable
/// approval and event provenance.
pub(super) const LOCAL_SCHEMA_VERSION: i64 = 19;

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
        set_local_schema_version(pool, 3).await?;
        migrated = true;
    }
    if version < 4 {
        set_local_schema_version(pool, 4).await?;
        migrated = true;
    }
    if version < 5 {
        ensure_workspace_sync_state(pool).await?;
        set_local_schema_version(pool, 5).await?;
        migrated = true;
    }
    if version < 6 {
        set_local_schema_version(pool, 6).await?;
        migrated = true;
    }
    if version < 7 {
        ensure_project_knowledge_schema(pool).await?;
        set_local_schema_version(pool, 7).await?;
        migrated = true;
    }
    if version < 8 {
        ensure_project_knowledge_snapshot_columns(pool).await?;
        set_local_schema_version(pool, 8).await?;
        migrated = true;
    }
    if version < 9 {
        ensure_project_knowledge_revision_set(pool).await?;
        set_local_schema_version(pool, 9).await?;
        migrated = true;
    }
    if version < 10 {
        ensure_project_environment_connections(pool).await?;
        set_local_schema_version(pool, 10).await?;
        migrated = true;
    }
    if version < 11 {
        ensure_knowledge_grant_revision_sets(pool).await?;
        set_local_schema_version(pool, 11).await?;
        migrated = true;
    }
    if version < 12 {
        ensure_agent_acp_knowledge_scope(pool).await?;
        set_local_schema_version(pool, 12).await?;
        migrated = true;
    }
    if version < 13 {
        ensure_agent_acp_environment_connections(pool).await?;
        set_local_schema_version(pool, 13).await?;
        migrated = true;
    }
    if version < 14 {
        ensure_agent_acp_knowledge_grant(pool).await?;
        set_local_schema_version(pool, 14).await?;
        migrated = true;
    }
    if version < 15 {
        set_local_schema_version(pool, 15).await?;
        migrated = true;
    }
    if version < 16 {
        set_local_schema_version(pool, 16).await?;
        migrated = true;
    }
    if version < 17 {
        remove_retired_bi_schema(pool).await?;
        set_local_schema_version(pool, 17).await?;
        migrated = true;
    }
    if version < 18 {
        ensure_analysis_signal_runtime_schema(pool).await?;
        set_local_schema_version(pool, 18).await?;
        migrated = true;
    }
    if version < 19 {
        migrate_retired_operation_kind(pool).await?;
        set_local_schema_version(pool, 19).await?;
        migrated = true;
    }
    Ok(migrated)
}

/// Rebuild the immutable parent table once so a removed Dashboard command does not
/// remain part of the public Operation vocabulary. Approval and event children keep
/// their original operation ids and hashes; only the retired parent's descriptive
/// kind is normalized. Foreign-key enforcement is disabled on the one acquired
/// startup connection only for the parent-table swap and is verified before return.
async fn migrate_retired_operation_kind(pool: &SqlitePool) -> AppResult<()> {
    let definition: Option<String> = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operations'",
    )
    .fetch_optional(pool)
    .await?;
    if !definition
        .as_deref()
        .is_some_and(|sql| sql.contains("dashboard_create"))
    {
        return Ok(());
    }

    let mut connection = pool.acquire().await?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await?;
    let mut transaction = connection.begin().await?;
    let rebuild = sqlx::raw_sql(
        r#"
        CREATE TABLE operations_retired_kind_migration (
            id                       TEXT PRIMARY KEY,
            runtime_id               TEXT NOT NULL,
            workspace_id             TEXT NOT NULL,
            account_scope            TEXT NOT NULL,
            connection_id            TEXT NOT NULL,
            connection_revision      INTEGER NOT NULL,
            terminal_session_id      TEXT,
            actor_kind               TEXT NOT NULL
                                     CHECK(actor_kind IN (
                                         'local_user', 'workspace_user', 'agent', 'plugin', 'system'
                                     )),
            actor_id                 TEXT NOT NULL CHECK(actor_id <> ''),
            actor_provenance_json    TEXT NOT NULL CHECK(json_valid(actor_provenance_json)),
            operation_kind           TEXT NOT NULL
                                     CHECK(operation_kind IN (
                                         'read_query', 'document_read', 'write_sql', 'ddl',
                                         'privilege', 'sql_script', 'table_data_change',
                                         'schema_change', 'import', 'export', 'migration',
                                         'retired_artifact', 'plugin_action', 'provider_action'
                                     )),
            payload_schema_version   INTEGER NOT NULL CHECK(payload_schema_version > 0),
            payload_json             TEXT NOT NULL CHECK(json_valid(payload_json)),
            payload_hash             TEXT NOT NULL
                                     CHECK(length(payload_hash) = 64
                                       AND payload_hash NOT GLOB '*[^0-9a-f]*'),
            schema_fingerprint       TEXT
                                     CHECK(schema_fingerprint IS NULL OR (
                                         length(schema_fingerprint) = 64
                                         AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'
                                     )),
            risk_level               TEXT NOT NULL
                                     CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
            preview_json             TEXT NOT NULL CHECK(json_valid(preview_json)),
            policy_snapshot_json     TEXT NOT NULL CHECK(json_valid(policy_snapshot_json)),
            policy_revision          TEXT NOT NULL CHECK(policy_revision <> ''),
            state                    TEXT NOT NULL
                                     CHECK(state IN (
                                         'planned', 'pending_approval', 'ready', 'approved',
                                         'rejected', 'expired', 'cancelled', 'executing',
                                         'succeeded', 'failed', 'outcome_unknown'
                                     )),
            single_use               INTEGER NOT NULL CHECK(single_use IN (0, 1)),
            idempotency_key          TEXT NOT NULL CHECK(idempotency_key <> ''),
            expires_at               TEXT,
            started_at               TEXT,
            finished_at              TEXT,
            created_at               TEXT NOT NULL,
            updated_at               TEXT NOT NULL
        );
        INSERT INTO operations_retired_kind_migration (
            id, runtime_id, workspace_id, account_scope, connection_id,
            connection_revision, terminal_session_id, actor_kind, actor_id,
            actor_provenance_json, operation_kind, payload_schema_version,
            payload_json, payload_hash, schema_fingerprint, risk_level,
            preview_json, policy_snapshot_json, policy_revision, state,
            single_use, idempotency_key, expires_at, started_at, finished_at,
            created_at, updated_at
        )
        SELECT
            id, runtime_id, workspace_id, account_scope, connection_id,
            connection_revision, terminal_session_id, actor_kind, actor_id,
            actor_provenance_json,
            CASE operation_kind
                WHEN 'dashboard_create' THEN 'retired_artifact'
                ELSE operation_kind
            END,
            payload_schema_version, payload_json, payload_hash, schema_fingerprint,
            risk_level, preview_json, policy_snapshot_json, policy_revision, state,
            single_use, idempotency_key, expires_at, started_at, finished_at,
            created_at, updated_at
        FROM operations;

        DROP TABLE operations;
        ALTER TABLE operations_retired_kind_migration RENAME TO operations;
        CREATE UNIQUE INDEX idx_operations_idempotency
            ON operations(workspace_id, actor_kind, actor_id, idempotency_key);
        CREATE INDEX idx_operations_state_expiry
            ON operations(state, expires_at);
        CREATE INDEX idx_operations_connection_created
            ON operations(connection_id, created_at DESC);
        CREATE INDEX idx_operations_runtime_state
            ON operations(runtime_id, state);

        CREATE TRIGGER operations_reject_immutable_update
        BEFORE UPDATE ON operations
        WHEN OLD.workspace_id IS NOT NEW.workspace_id
          OR OLD.account_scope IS NOT NEW.account_scope
          OR OLD.connection_id IS NOT NEW.connection_id
          OR OLD.connection_revision IS NOT NEW.connection_revision
          OR OLD.terminal_session_id IS NOT NEW.terminal_session_id
          OR OLD.actor_kind IS NOT NEW.actor_kind
          OR OLD.actor_id IS NOT NEW.actor_id
          OR OLD.actor_provenance_json IS NOT NEW.actor_provenance_json
          OR OLD.operation_kind IS NOT NEW.operation_kind
          OR OLD.payload_schema_version IS NOT NEW.payload_schema_version
          OR OLD.payload_json IS NOT NEW.payload_json
          OR OLD.payload_hash IS NOT NEW.payload_hash
          OR OLD.schema_fingerprint IS NOT NEW.schema_fingerprint
          OR OLD.risk_level IS NOT NEW.risk_level
          OR OLD.preview_json IS NOT NEW.preview_json
          OR OLD.policy_snapshot_json IS NOT NEW.policy_snapshot_json
          OR OLD.policy_revision IS NOT NEW.policy_revision
          OR OLD.single_use IS NOT NEW.single_use
          OR OLD.idempotency_key IS NOT NEW.idempotency_key
          OR OLD.expires_at IS NOT NEW.expires_at
          OR OLD.created_at IS NOT NEW.created_at
        BEGIN
            SELECT RAISE(ABORT, 'operation immutable fields cannot be changed');
        END;
        CREATE TRIGGER operations_reject_delete
        BEFORE DELETE ON operations
        BEGIN
            SELECT RAISE(ABORT, 'operation provenance cannot be deleted');
        END;
        "#,
    )
    .execute(&mut *transaction)
    .await;
    let migration = match rebuild {
        Ok(_) => transaction.commit().await.map_err(AppError::from),
        Err(error) => {
            let _ = transaction.rollback().await;
            Err(AppError::from(error))
        }
    };
    let foreign_keys_restored = sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await
        .map(|_| ())
        .map_err(AppError::from);
    migration?;
    foreign_keys_restored?;

    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&mut *connection)
        .await?;
    if violations != 0 {
        return Err(AppError::Config(format!(
            "retired operation migration left {violations} foreign-key violation(s)"
        )));
    }
    Ok(())
}

async fn remove_retired_bi_schema(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::raw_sql(
        "DROP TABLE IF EXISTS workspace_dashboard_visibility;
         DROP TABLE IF EXISTS funnel_analysis_artifacts;
         DROP TABLE IF EXISTS signal_metric_samples;
         DROP TABLE IF EXISTS signal_runner_identity;
         DROP TABLE IF EXISTS dashboards;
         DROP TABLE IF EXISTS sync_outbox;
         DROP TABLE IF EXISTS sync_state;",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn ensure_analysis_signal_runtime_schema(pool: &SqlitePool) -> AppResult<()> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS analysis_signal_metric_samples (
             workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             account_user_id TEXT NOT NULL CHECK(account_user_id <> ''),
             signal_id TEXT NOT NULL,
             signal_revision INTEGER NOT NULL CHECK(signal_revision > 0),
             scheduled_at TEXT NOT NULL,
             evaluated_at TEXT NOT NULL,
             metric_value REAL,
             sample_count INTEGER NOT NULL CHECK(sample_count >= 0),
             observed_state TEXT NOT NULL
                 CHECK(observed_state IN ('normal', 'firing', 'no_data', 'error', 'stale')),
             schema_fingerprint TEXT NOT NULL
                 CHECK(length(schema_fingerprint) = 64
                   AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'),
             PRIMARY KEY (
               workspace_id, account_user_id, signal_id, signal_revision, scheduled_at
             )
         );
         CREATE INDEX IF NOT EXISTS idx_analysis_signal_samples_recent
           ON analysis_signal_metric_samples(
             workspace_id, account_user_id, signal_id, signal_revision, evaluated_at DESC
           );
         INSERT INTO app_settings (key, value)
           SELECT 'analysis_runner_device_id', value
           FROM app_settings
           WHERE key = 'signal_runner_device_id'
           ON CONFLICT(key) DO NOTHING;
         INSERT INTO app_settings (key, value)
           SELECT 'analysis_runner_background_allowed', value
           FROM app_settings
           WHERE key = 'signal_runner_background_allowed'
           ON CONFLICT(key) DO NOTHING;
         DELETE FROM app_settings
           WHERE key IN ('signal_runner_device_id', 'signal_runner_background_allowed');",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_agent_acp_knowledge_grant(pool: &SqlitePool) -> AppResult<()> {
    add_column_if_missing(
        pool,
        "agent_acp_sessions",
        "knowledge_grant_id",
        "ALTER TABLE agent_acp_sessions ADD COLUMN knowledge_grant_id TEXT",
    )
    .await
}

async fn ensure_agent_acp_environment_connections(pool: &SqlitePool) -> AppResult<()> {
    add_column_if_missing(
        pool,
        "agent_acp_sessions",
        "environment_connections",
        "ALTER TABLE agent_acp_sessions ADD COLUMN environment_connections TEXT NOT NULL DEFAULT '[]'",
    )
    .await
}

async fn ensure_agent_acp_knowledge_scope(pool: &SqlitePool) -> AppResult<()> {
    add_column_if_missing(
        pool,
        "agent_acp_sessions",
        "project_environment_id",
        "ALTER TABLE agent_acp_sessions ADD COLUMN project_environment_id TEXT",
    )
    .await?;
    add_column_if_missing(
        pool,
        "agent_acp_sessions",
        "environment_revision",
        "ALTER TABLE agent_acp_sessions ADD COLUMN environment_revision INTEGER CHECK(environment_revision IS NULL OR environment_revision > 0)",
    )
    .await?;
    add_column_if_missing(
        pool,
        "agent_acp_sessions",
        "graph_revision_ids",
        "ALTER TABLE agent_acp_sessions ADD COLUMN graph_revision_ids TEXT NOT NULL DEFAULT '[]'",
    )
    .await?;
    Ok(())
}

async fn ensure_knowledge_grant_revision_sets(pool: &SqlitePool) -> AppResult<()> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS knowledge_grant_graph_revisions (
             grant_id TEXT NOT NULL REFERENCES knowledge_grants(id) ON DELETE CASCADE,
             graph_revision_id TEXT NOT NULL
                 REFERENCES knowledge_graph_revisions(graph_revision_id),
             PRIMARY KEY (grant_id, graph_revision_id)
         );
         INSERT OR IGNORE INTO knowledge_grant_graph_revisions (grant_id, graph_revision_id)
         SELECT id, graph_revision_id FROM knowledge_grants;",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_project_environment_connections(pool: &SqlitePool) -> AppResult<()> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS knowledge_environment_connections (
             id TEXT PRIMARY KEY,
             workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             project_environment_id TEXT NOT NULL
                 REFERENCES knowledge_project_environments(id) ON DELETE CASCADE,
             environment_revision INTEGER NOT NULL CHECK(environment_revision > 0),
             connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
             connection_revision INTEGER NOT NULL CHECK(connection_revision > 0),
             role TEXT NOT NULL CHECK(length(role) BETWEEN 1 AND 64),
             alias TEXT NOT NULL CHECK(length(alias) BETWEEN 1 AND 128),
             created_at TEXT NOT NULL,
             revoked_at TEXT
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_environment_connection_active
           ON knowledge_environment_connections(project_environment_id, connection_id)
           WHERE revoked_at IS NULL;
         CREATE INDEX IF NOT EXISTS idx_knowledge_environment_connection_scope
           ON knowledge_environment_connections(workspace_id, project_environment_id, revoked_at);",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_project_knowledge_revision_set(pool: &SqlitePool) -> AppResult<()> {
    add_column_if_missing(
        pool,
        "knowledge_project_environments",
        "risk_class",
        "ALTER TABLE knowledge_project_environments ADD COLUMN risk_class TEXT NOT NULL DEFAULT 'custom'",
    )
    .await?;
    sqlx::query(
        "UPDATE knowledge_project_environments
         SET risk_class = CASE WHEN production = 1 THEN 'production' ELSE 'custom' END
         WHERE risk_class = 'custom'",
    )
    .execute(pool)
    .await?;
    let has_source_id: bool = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM pragma_table_info('knowledge_environment_heads')
             WHERE name = 'source_id'
         )",
    )
    .fetch_one(pool)
    .await?;
    if has_source_id {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    sqlx::raw_sql(
        "DROP TRIGGER IF EXISTS knowledge_graph_revisions_reject_delete_active;
         ALTER TABLE knowledge_environment_heads RENAME TO knowledge_environment_heads_v8;
         CREATE TABLE knowledge_environment_heads (
             project_environment_id TEXT NOT NULL
                 REFERENCES knowledge_project_environments(id) ON DELETE CASCADE,
             source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
             graph_revision_id TEXT NOT NULL UNIQUE
                 REFERENCES knowledge_graph_revisions(graph_revision_id),
             environment_revision INTEGER NOT NULL CHECK(environment_revision > 0),
             activated_at TEXT NOT NULL,
             PRIMARY KEY (project_environment_id, source_id)
         );
         INSERT INTO knowledge_environment_heads
             (project_environment_id, source_id, graph_revision_id,
              environment_revision, activated_at)
         SELECT old.project_environment_id, revision.source_id,
                old.graph_revision_id, old.environment_revision, old.activated_at
         FROM knowledge_environment_heads_v8 old
         JOIN knowledge_graph_revisions revision
           ON revision.graph_revision_id = old.graph_revision_id;
         DROP TABLE knowledge_environment_heads_v8;
         CREATE TRIGGER knowledge_graph_revisions_reject_delete_active
         BEFORE DELETE ON knowledge_graph_revisions
         WHEN EXISTS (
             SELECT 1 FROM knowledge_environment_heads
             WHERE graph_revision_id = OLD.graph_revision_id
         )
         BEGIN
             SELECT RAISE(ABORT, 'active knowledge graph revision cannot be deleted');
         END;",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn ensure_project_knowledge_snapshot_columns(pool: &SqlitePool) -> AppResult<()> {
    add_column_if_missing(
        pool,
        "knowledge_sources",
        "source_revision_sha256",
        "ALTER TABLE knowledge_sources ADD COLUMN source_revision_sha256 TEXT",
    )
    .await?;
    add_column_if_missing(
        pool,
        "knowledge_sources",
        "snapshot_json",
        "ALTER TABLE knowledge_sources ADD COLUMN snapshot_json TEXT",
    )
    .await?;
    add_column_if_missing(
        pool,
        "knowledge_sources",
        "revoked_at",
        "ALTER TABLE knowledge_sources ADD COLUMN revoked_at TEXT",
    )
    .await?;
    Ok(())
}

async fn ensure_project_knowledge_schema(pool: &SqlitePool) -> AppResult<()> {
    sqlx::raw_sql(migrations::KNOWLEDGE_SCHEMA)
        .execute(pool)
        .await?;
    Ok(())
}

async fn ensure_workspace_sync_state(pool: &SqlitePool) -> AppResult<()> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS workspace_sync_state (
             workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             account_scope TEXT NOT NULL CHECK(account_scope <> ''),
             pull_cursor   INTEGER NOT NULL CHECK(pull_cursor >= 0),
             last_pulled_at TEXT NOT NULL,
             PRIMARY KEY (workspace_id, account_scope)
         );",
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
    for table in ["connections", "snippets"] {
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
    tx.commit().await?;
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
