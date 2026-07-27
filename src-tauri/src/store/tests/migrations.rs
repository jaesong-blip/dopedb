//! Bootstrap and legacy migration compatibility tests.

use super::fixtures::*;

#[tokio::test]
async fn legacy_resources_migrate_without_uuid_or_secret_changes() {
    let pool = memory_pool().await;
    sqlx::raw_sql(
            r#"
            CREATE TABLE connections (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, engine TEXT NOT NULL,
                provider TEXT NOT NULL DEFAULT 'auto', driver_id TEXT, host TEXT NOT NULL,
                port INTEGER NOT NULL, db_name TEXT NOT NULL, username TEXT NOT NULL,
                sslmode TEXT NOT NULL, extra_params TEXT NOT NULL DEFAULT '{}', secret_ref TEXT,
                readonly_default INTEGER NOT NULL DEFAULT 1, allow_writes INTEGER NOT NULL DEFAULT 0,
                env TEXT, schema_group TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE snippets (
                id TEXT PRIMARY KEY, connection_id TEXT, title TEXT NOT NULL, sql TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
            );
            CREATE TABLE dashboards (
                id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '', sql TEXT NOT NULL,
                visualization_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            INSERT INTO connections
                (id,name,engine,host,port,db_name,username,sslmode,secret_ref,created_at,updated_at)
            VALUES ('10000000-0000-0000-0000-000000000001','legacy','sqlite','',0,':memory:','',
                    'disable','keychain-only','2026-01-01','2026-01-01');
            INSERT INTO snippets (id,connection_id,title,sql,updated_at)
            VALUES ('10000000-0000-0000-0000-000000000002',NULL,'s','SELECT 1','2026-01-01');
            INSERT INTO dashboards
                (id,connection_id,title,sql,visualization_json,created_at,updated_at)
            VALUES ('10000000-0000-0000-0000-000000000003',
                    '10000000-0000-0000-0000-000000000001','d','SELECT 1',
                    '{"version":1,"kind":"table","xColumn":null,"yColumns":[]}',
                    '2026-01-01','2026-01-01');
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    add_workspace_columns(&pool).await;
    migrate_workspace_foundation(&pool).await.unwrap();

    for table in ["connections", "dashboards", "snippets"] {
        let workspace_id: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT workspace_id FROM {table} LIMIT 1"
        )))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(workspace_id, migrations::PERSONAL_WORKSPACE_ID);
    }
    let secret_ref: String = sqlx::query_scalar("SELECT secret_ref FROM connections")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(secret_ref, "keychain-only");
    let outbox_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_outbox")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        outbox_rows, 0,
        "migration must not serialize legacy resources"
    );
}

#[tokio::test]
async fn legacy_schema_cache_migrates_to_account_scoped_composite_key() {
    let pool = memory_pool().await;
    sqlx::raw_sql(
        r#"
            CREATE TABLE connections (id TEXT PRIMARY KEY);
            INSERT INTO connections (id) VALUES ('10000000-0000-0000-0000-000000000001');
            CREATE TABLE schema_cache (
                connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
                introspected_at TEXT NOT NULL,
                catalog_json TEXT NOT NULL
            );
            INSERT INTO schema_cache (connection_id, introspected_at, catalog_json)
            VALUES ('10000000-0000-0000-0000-000000000001', '2026-01-01', '{}');
            "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    migrate_schema_cache_scopes(&pool).await.unwrap();
    migrate_schema_cache_scopes(&pool).await.unwrap();
    let scope: String = sqlx::query_scalar("SELECT account_scope FROM schema_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(scope, "personal");
    sqlx::query(
        "INSERT INTO schema_cache
             (connection_id, account_scope, introspected_at, catalog_json)
             VALUES (?1, 'account-b', '2026-01-02', '{}')",
    )
    .bind("10000000-0000-0000-0000-000000000001")
    .execute(&pool)
    .await
    .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM schema_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 2);
}

#[tokio::test]
async fn catalog_v2_bootstrap_preserves_rollback_schema_without_claiming_legacy_rows() {
    let pool = memory_pool().await;
    sqlx::raw_sql(
        r#"
            CREATE TABLE connections (id TEXT PRIMARY KEY);
            INSERT INTO connections (id) VALUES ('10000000-0000-0000-0000-000000000001');
            CREATE TABLE schema_cache (
                connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
                introspected_at TEXT NOT NULL,
                catalog_json TEXT NOT NULL
            );
            INSERT INTO schema_cache (connection_id, introspected_at, catalog_json)
            VALUES ('10000000-0000-0000-0000-000000000001', '2026-01-01', '{\"legacy\":true}');
            CREATE TABLE workspace_connection_bindings (
                connection_id TEXT NOT NULL,
                account_user_id TEXT NOT NULL,
                username TEXT NOT NULL DEFAULT '',
                extra_params TEXT NOT NULL DEFAULT '{}',
                secret_ref TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (connection_id, account_user_id)
            );
            INSERT INTO workspace_connection_bindings
                (connection_id, account_user_id, username, updated_at)
            VALUES
                ('10000000-0000-0000-0000-000000000001', 'account-a', 'db-user', '2026-01-01');
            CREATE TABLE schema_cache_v2 (
                workspace_id TEXT PRIMARY KEY
            );
            "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    add_connection_binding_scope_columns(&pool).await.unwrap();
    add_connection_binding_scope_columns(&pool).await.unwrap();
    ensure_schema_cache_v2(&pool).await.unwrap();
    ensure_schema_cache_v2(&pool).await.unwrap();
    migrate_schema_cache_scopes(&pool).await.unwrap();
    migrate_schema_cache_scopes(&pool).await.unwrap();

    let generation: String =
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'active_scope_generation'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(generation, "0");
    let binding_revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM workspace_connection_bindings
             WHERE connection_id = '10000000-0000-0000-0000-000000000001'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(binding_revision, 1);
    let legacy_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM schema_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    let v2_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM schema_cache_v2")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(legacy_rows, 1);
    assert_eq!(
        v2_rows, 0,
        "legacy cache has no trustworthy workspace or revision provenance"
    );
    let v2_columns: i64 =
        sqlx::query_scalar("SELECT count(*) FROM pragma_table_info('schema_cache_v2')")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(v2_columns, 10);
    let v2_index: bool = sqlx::query_scalar(
        "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_schema_cache_v2_connection'
             )",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(v2_index);
}

#[tokio::test]
async fn scope_indexes_are_created_only_after_legacy_columns_are_added() {
    let pool = memory_pool().await;
    sqlx::raw_sql(
        r#"
            CREATE TABLE connections (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE query_history (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                executed_at TEXT NOT NULL
            );
            CREATE TABLE agent_chat_threads (
                id TEXT PRIMARY KEY,
                updated_at TEXT NOT NULL
            );
            "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    add_workspace_columns(&pool).await;
    add_local_scope_columns(&pool).await;
    ensure_local_scope_indexes(&pool).await.unwrap();
    ensure_local_scope_indexes(&pool).await.unwrap();

    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master
             WHERE type = 'index' AND name IN (
                 'idx_connections_workspace_account',
                 'idx_history_conn_scope_executed',
                 'idx_agent_chat_threads_scope_updated'
             ) ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(indexes.len(), 3);
}
