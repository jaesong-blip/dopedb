//! Compatibility migrations for durable operation records.

use super::*;

pub(super) async fn migrate_retired_operation_kind(pool: &SqlitePool) -> AppResult<()> {
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
