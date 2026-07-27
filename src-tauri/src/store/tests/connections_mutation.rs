//! Connection mutation, revision, audit, and batch tests.

use super::fixtures::*;

#[tokio::test]
async fn pinned_catalog_write_is_stale_after_binding_or_template_revision_changes() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let connection_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Owner");
    store
        .sync_account_workspaces(
            &user,
            &[(workspace_id, "Shared".into(), WorkspaceRole::Owner)],
        )
        .await
        .unwrap();
    let mut template = sqlite_profile(connection_id, "shared");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::Read;
    template.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template.clone(), 1)])
        .await
        .unwrap();
    let first_ref = Uuid::new_v4().to_string();
    store
        .bind_connection_credentials(
            connection_id,
            &user.id,
            "first-user",
            &HashMap::new(),
            Some(&first_ref),
        )
        .await
        .unwrap();
    store
        .activate_workspace(workspace_id, Some(&user.id))
        .await
        .unwrap();
    let binding_pin = store.pin_connection_for_read(connection_id).await.unwrap();
    let snapshot = catalog_snapshot(connection_id, ":memory:", 'b');

    let second_ref = Uuid::new_v4().to_string();
    store
        .bind_connection_credentials(
            connection_id,
            &user.id,
            "second-user",
            &HashMap::new(),
            Some(&second_ref),
        )
        .await
        .unwrap();
    assert!(!store.is_pin_current(&binding_pin).await.unwrap());
    assert_eq!(
        store
            .put_catalog_if_current(&binding_pin, &snapshot)
            .await
            .unwrap(),
        CacheWriteOutcome::Stale
    );

    let template_pin = store.pin_connection_for_read(connection_id).await.unwrap();
    template.name = "shared revision two".into();
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template, 2)])
        .await
        .unwrap();
    assert!(!store.is_pin_current(&template_pin).await.unwrap());
    assert_eq!(
        store
            .put_catalog_if_current(&template_pin, &snapshot)
            .await
            .unwrap(),
        CacheWriteOutcome::Stale
    );
}

#[tokio::test]
async fn binding_revision_changes_only_when_material_or_authority_changes() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let connection_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Owner");
    store
        .sync_account_workspaces(
            &user,
            &[(workspace_id, "Shared".into(), WorkspaceRole::Owner)],
        )
        .await
        .unwrap();
    let mut template = sqlite_profile(connection_id, "shared");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::Read;
    template.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template.clone(), 1)])
        .await
        .unwrap();
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template.clone(), 1)])
        .await
        .unwrap();
    let initial: i64 = sqlx::query_scalar(
        "SELECT revision FROM workspace_connection_bindings
             WHERE connection_id = ?1 AND account_user_id = ?2",
    )
    .bind(connection_id.to_string())
    .bind(user.id.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(initial, 1);

    let secret_ref = Uuid::new_v4().to_string();
    for _ in 0..2 {
        store
            .bind_connection_credentials(
                connection_id,
                &user.id,
                "db-user",
                &HashMap::new(),
                Some(&secret_ref),
            )
            .await
            .unwrap();
    }
    let material_revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM workspace_connection_bindings
             WHERE connection_id = ?1 AND account_user_id = ?2",
    )
    .bind(connection_id.to_string())
    .bind(user.id.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(material_revision, 2);

    template.workspace_access = crate::model::WorkspaceConnectionAccess::Write;
    template.allow_writes = true;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template, 2)])
        .await
        .unwrap();
    let authority_revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM workspace_connection_bindings
             WHERE connection_id = ?1 AND account_user_id = ?2",
    )
    .bind(connection_id.to_string())
    .bind(user.id.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(authority_revision, 3);
}

#[tokio::test]
async fn team_local_connections_are_visible_only_to_their_owning_account() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let connection_id = Uuid::new_v4();
    let user_a = workspace_user("10000000-0000-0000-0000-000000000001", "Alpha");
    let user_b = workspace_user("20000000-0000-0000-0000-000000000002", "Beta");
    for user in [&user_a, &user_b] {
        store
            .sync_account_workspaces(
                user,
                &[(workspace_id, "Shared".into(), WorkspaceRole::Editor)],
            )
            .await
            .unwrap();
    }

    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    store
        .upsert_connection(&sqlite_profile(connection_id, "alpha-local"))
        .await
        .unwrap();
    assert_eq!(store.list_connections().await.unwrap().len(), 1);

    store
        .activate_workspace(workspace_id, Some(&user_b.id))
        .await
        .unwrap();
    assert!(store.list_connections().await.unwrap().is_empty());
    assert!(matches!(
        store.get_connection(connection_id).await,
        Err(AppError::NotFound(_))
    ));

    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    assert_eq!(
        store.get_connection(connection_id).await.unwrap().name,
        "alpha-local"
    );
}

#[tokio::test]
async fn concurrent_local_updates_advance_distinct_connection_revisions() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("revision-race.db");
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let connection_id = Uuid::new_v4();
    let initial = sqlite_profile(connection_id, "initial");
    store.upsert_connection(&initial).await.unwrap();
    let original_pin = store.pin_connection_for_read(connection_id).await.unwrap();
    assert_eq!(original_pin.connection_revision, 1);

    let mut alpha = initial.clone();
    alpha.name = "alpha".into();
    let mut beta = initial;
    beta.name = "beta".into();
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(3));
    let first_store = store.clone();
    let first_barrier = barrier.clone();
    let first = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store.upsert_connection(&alpha).await
    });
    let second_store = store.clone();
    let second_barrier = barrier.clone();
    let second = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store.upsert_connection(&beta).await
    });
    barrier.wait().await;
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();

    let revision: i64 = sqlx::query_scalar("SELECT revision FROM connections WHERE id = ?1")
        .bind(connection_id.to_string())
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(revision, 3);
    assert!(!store.is_pin_current(&original_pin).await.unwrap());
}

// The OLD schema cascades; after migration, deleting a connection must NOT erase
// its audit rows (the compliance guarantee), and re-running must be a no-op.
#[tokio::test]
async fn audit_survives_connection_delete_after_migration() {
    // max_connections(1) so the whole test shares one in-memory DB.
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap();

    sqlx::raw_sql(
        r#"
            CREATE TABLE connections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE audit_log (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
                ts TEXT NOT NULL, engine TEXT NOT NULL, agent_prompt TEXT,
                sql TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
                approved_by TEXT, affected_estimate INTEGER, error TEXT,
                prev_hash TEXT, hash TEXT NOT NULL
            );
            INSERT INTO connections (id, name) VALUES ('c1','x');
            INSERT INTO audit_log (id, connection_id, ts, engine, sql, kind, action, hash)
                VALUES ('a1','c1','t','postgres','SELECT 1','read','execute','h');
            "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    migrate_audit_no_cascade(&pool).await.unwrap();
    migrate_audit_no_cascade(&pool).await.unwrap(); // idempotent

    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1, "row preserved by the rebuild");

    sqlx::query("DELETE FROM connections WHERE id='c1'")
        .execute(&pool)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1, "audit history must survive connection deletion");
}

#[tokio::test]
async fn connections_with_legacy_project_dir_column_still_round_trip() {
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap();
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE connections ADD COLUMN project_dir TEXT")
        .execute(&pool)
        .await
        .unwrap();

    let store = Store::from_pool_for_test(pool);
    let profile = ConnectionProfile {
        id: Uuid::new_v4(),
        name: "legacy".into(),
        engine: Engine::Sqlite,
        provider: Provider::Generic,
        driver_id: Some("sqlx-sqlite".into()),
        host: String::new(),
        port: 0,
        database: ":memory:".into(),
        username: String::new(),
        sslmode: "disable".into(),
        extra_params: HashMap::new(),
        readonly_default: true,
        allow_writes: false,
        secret_ref: None,
        env: Some("dev".into()),
        schema_group: Some("core".into()),
        workspace_access: crate::model::WorkspaceConnectionAccess::Local,
        credential_mode: crate::model::WorkspaceCredentialMode::Local,
    };
    store.upsert_connection(&profile).await.unwrap();
    sqlx::query("UPDATE connections SET project_dir = '/old/project' WHERE id = ?1")
        .bind(profile.id.to_string())
        .execute(store.pool())
        .await
        .unwrap();

    let loaded = store.get_connection(profile.id).await.unwrap();
    assert_eq!(loaded.name, "legacy");
    assert_eq!(loaded.schema_group.as_deref(), Some("core"));
    store.upsert_connection(&loaded).await.unwrap();
}

#[tokio::test]
async fn schema_group_batch_rolls_back_when_any_connection_is_missing() {
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap();
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();

    let store = Store::from_pool_for_test(pool);
    let connection_id = Uuid::new_v4();
    store
        .upsert_connection(&ConnectionProfile {
            id: connection_id,
            name: "dev".into(),
            engine: Engine::Sqlite,
            provider: Provider::Generic,
            driver_id: Some("sqlx-sqlite".into()),
            host: String::new(),
            port: 0,
            database: ":memory:".into(),
            username: String::new(),
            sslmode: "disable".into(),
            extra_params: HashMap::new(),
            readonly_default: true,
            allow_writes: false,
            secret_ref: None,
            env: Some("dev".into()),
            schema_group: None,
            workspace_access: crate::model::WorkspaceConnectionAccess::Local,
            credential_mode: crate::model::WorkspaceCredentialMode::Local,
        })
        .await
        .unwrap();

    let missing_id = Uuid::new_v4();
    let error = store
        .set_connections_schema_group(&[connection_id, missing_id], Some("core".into()))
        .await
        .unwrap_err();
    assert!(matches!(error, AppError::NotFound(_)));
    assert_eq!(
        store
            .get_connection(connection_id)
            .await
            .unwrap()
            .schema_group,
        None
    );
}
