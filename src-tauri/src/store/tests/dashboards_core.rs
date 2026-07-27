//! Dashboard persistence and optimistic conflict tests.

use super::fixtures::*;

#[tokio::test]
async fn dashboard_round_trip_delete_and_connection_cascade() {
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
            name: "analytics".into(),
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
            env: None,
            schema_group: None,
            workspace_access: crate::model::WorkspaceConnectionAccess::Local,
            credential_mode: crate::model::WorkspaceCredentialMode::Local,
        })
        .await
        .unwrap();

    let loaded = store.get_connection(connection_id).await.unwrap();
    assert_eq!(loaded.provider, Provider::Generic);
    assert_eq!(loaded.driver_id.as_deref(), Some("sqlx-sqlite"));

    let draft = DashboardDraft {
        connection_id: ConnectionId::from(connection_id),
        title: "Daily visitors".into(),
        description: "Unique visitors per day".into(),
        sql: "SELECT day, visitors FROM daily_visitors".into(),
        visualization: DashboardVisualization {
            version: 1,
            kind: DashboardKind::Line,
            x_column: Some("day".into()),
            y_columns: vec!["visitors".into()],
        },
    };
    let saved = store.save_dashboard(&draft).await.unwrap();
    let listed = store
        .list_dashboards(ConnectionId::from(connection_id))
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, saved.id);
    assert_eq!(listed[0].visualization, draft.visualization);
    assert_eq!(store.get_dashboard(saved.id).await.unwrap().id, saved.id);

    let history = HistoryEntry {
        id: Uuid::new_v4(),
        connection_id,
        sql: "SELECT 1".into(),
        kind: QueryKind::Read,
        status: "ok".into(),
        row_count: Some(1),
        duration_ms: Some(1),
        error: None,
        executed_at: Utc::now(),
        origin: "agent".into(),
    };
    let history_pin = store.pin_connection_for_read(connection_id).await.unwrap();
    store
        .insert_history_if_current(&history_pin, &history)
        .await
        .unwrap();
    assert_eq!(store.get_history(history.id).await.unwrap().id, history.id);

    sqlx::query(
        r#"UPDATE dashboards
               SET visualization_json = '{"version":2,"kind":"line","xColumn":null,"yColumns":[]}'
               WHERE id = ?1"#,
    )
    .bind(saved.id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(matches!(
        store.get_dashboard(saved.id).await,
        Err(AppError::Config(_))
    ));

    store.delete_dashboard(saved.id).await.unwrap();
    assert!(store
        .list_dashboards(ConnectionId::from(connection_id))
        .await
        .unwrap()
        .is_empty());

    store.save_dashboard(&draft).await.unwrap();
    store.delete_connection(connection_id).await.unwrap();
    assert!(matches!(
        store
            .list_dashboards(ConnectionId::from(connection_id))
            .await,
        Err(AppError::NotFound(_))
    ));
}

#[tokio::test]
async fn dashboard_save_never_creates_a_phantom_row_or_outbox() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);

    let missing_id = Uuid::new_v4();
    assert!(matches!(
        store
            .save_dashboard(&dashboard_draft(missing_id, "missing"))
            .await,
        Err(AppError::NotFound(_))
    ));

    let deleted_id = Uuid::new_v4();
    store
        .upsert_connection(&sqlite_profile(deleted_id, "deleted"))
        .await
        .unwrap();
    store.delete_connection(deleted_id).await.unwrap();
    assert!(matches!(
        store
            .save_dashboard(&dashboard_draft(deleted_id, "deleted"))
            .await,
        Err(AppError::NotFound(_))
    ));

    let dashboard_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM dashboards")
        .fetch_one(store.pool())
        .await
        .unwrap();
    let dashboard_outbox: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sync_outbox WHERE resource_type = 'dashboard'")
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(dashboard_rows, 0);
    assert_eq!(dashboard_outbox, 0);
}

#[tokio::test]
async fn dashboard_cas_rejects_a_stale_scope_without_side_effects() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let connection_id = Uuid::new_v4();
    store
        .upsert_connection(&sqlite_profile(connection_id, "stale"))
        .await
        .unwrap();
    let saved = store
        .save_dashboard(&dashboard_draft(connection_id, "existing"))
        .await
        .unwrap();
    let connection_pin = store
        .pin_connection_for_dashboard(connection_id)
        .await
        .unwrap();
    let dashboard_pin = store.pin_dashboard_for_view(saved.id).await.unwrap();
    let before_outbox: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sync_outbox WHERE resource_type = 'dashboard'")
            .fetch_one(store.pool())
            .await
            .unwrap();

    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Scope");
    store.remember_workspace_account(&user).await.unwrap();
    store.activate_workspace_account(&user.id).await.unwrap();

    assert!(matches!(
        store.list_dashboards_if_current(&connection_pin).await,
        Err(AppError::Blocked { .. })
    ));
    assert!(matches!(
        store
            .save_dashboard_if_current(
                &connection_pin,
                &dashboard_draft(connection_id, "stale insert"),
            )
            .await,
        Err(AppError::Blocked { .. })
    ));
    assert!(matches!(
        store.delete_dashboard_if_current(&dashboard_pin).await,
        Err(AppError::Blocked { .. })
    ));

    let dashboard_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dashboards WHERE deleted_at IS NULL")
            .fetch_one(store.pool())
            .await
            .unwrap();
    let after_outbox: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sync_outbox WHERE resource_type = 'dashboard'")
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(dashboard_rows, 1);
    assert_eq!(after_outbox, before_outbox);
}

#[tokio::test]
async fn hidden_account_local_dashboard_delete_does_not_leak_connection_identity() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
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
    let connection_id = Uuid::new_v4();
    store
        .upsert_connection(&sqlite_profile(connection_id, "alpha local"))
        .await
        .unwrap();
    let dashboard = store
        .save_dashboard(&dashboard_draft(connection_id, "alpha only"))
        .await
        .unwrap();

    store
        .activate_workspace(workspace_id, Some(&user_b.id))
        .await
        .unwrap();
    let error = store.delete_dashboard(dashboard.id).await.unwrap_err();
    assert!(matches!(error, AppError::NotFound(_)));
    assert!(!error.to_string().contains(&connection_id.to_string()));
    let deleted_at: Option<String> =
        sqlx::query_scalar("SELECT deleted_at FROM dashboards WHERE id = ?1")
            .bind(dashboard.id.to_string())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert!(deleted_at.is_none());
}

#[tokio::test]
async fn concurrent_dashboard_delete_has_exactly_one_winner_and_outbox_event() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("dashboard-delete-race.db");
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
    store
        .upsert_connection(&sqlite_profile(connection_id, "concurrent"))
        .await
        .unwrap();
    let dashboard = store
        .save_dashboard(&dashboard_draft(connection_id, "one winner"))
        .await
        .unwrap();
    let pin = store.pin_dashboard_for_view(dashboard.id).await.unwrap();
    let other_pin = pin.clone();
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(3));
    let first_store = store.clone();
    let first_barrier = barrier.clone();
    let first = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store.delete_dashboard_if_current(&pin).await
    });
    let other_store = store.clone();
    let second_barrier = barrier.clone();
    let second = tokio::spawn(async move {
        second_barrier.wait().await;
        other_store.delete_dashboard_if_current(&other_pin).await
    });
    barrier.wait().await;
    let (first, second) = (first.await.unwrap(), second.await.unwrap());
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    let loser = if let Err(error) = first {
        error
    } else {
        second.unwrap_err()
    };
    assert!(matches!(loser, AppError::Blocked { .. }));
    let delete_outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sync_outbox
             WHERE resource_type = 'dashboard' AND resource_id = ?1 AND operation = 'delete'",
    )
    .bind(dashboard.id.to_string())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(delete_outbox, 1);
}
