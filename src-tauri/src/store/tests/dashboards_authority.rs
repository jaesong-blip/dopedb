//! Dashboard authority, history provenance, and archive tests.

use super::fixtures::*;

#[tokio::test]
async fn viewer_dashboard_metadata_is_allowed_but_execution_pin_is_blocked() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Viewer");
    store
        .sync_account_workspaces(
            &user,
            &[(workspace_id, "Shared".into(), WorkspaceRole::Viewer)],
        )
        .await
        .unwrap();
    let connection_id = Uuid::new_v4();
    let mut template = sqlite_profile(connection_id, "viewer");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::View;
    template.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template, 1)])
        .await
        .unwrap();
    store
        .activate_workspace(workspace_id, Some(&user.id))
        .await
        .unwrap();

    let pin = store
        .pin_connection_for_dashboard(connection_id)
        .await
        .unwrap();
    assert_eq!(
        pin.profile.workspace_access,
        crate::model::WorkspaceConnectionAccess::View
    );
    assert!(matches!(
        store.pin_connection_for_read(connection_id).await,
        Err(AppError::Blocked { .. })
    ));
    let saved = store
        .save_dashboard_if_current(&pin, &dashboard_draft(connection_id, "viewer metadata"))
        .await
        .unwrap();
    assert_eq!(
        store.list_dashboards_if_current(&pin).await.unwrap().len(),
        1
    );
    let dashboard_pin = store.pin_dashboard_for_view(saved.id).await.unwrap();
    store
        .delete_dashboard_if_current(&dashboard_pin)
        .await
        .unwrap();
}

#[tokio::test]
async fn malformed_dashboard_can_be_pinned_and_deleted_without_deserializing_it() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let connection_id = Uuid::new_v4();
    store
        .upsert_connection(&sqlite_profile(connection_id, "legacy"))
        .await
        .unwrap();
    let dashboard = store
        .save_dashboard(&dashboard_draft(connection_id, "malformed"))
        .await
        .unwrap();
    sqlx::query("UPDATE dashboards SET visualization_json = 'not-json' WHERE id = ?1")
        .bind(dashboard.id.to_string())
        .execute(store.pool())
        .await
        .unwrap();

    let pin = store.pin_dashboard_for_view(dashboard.id).await.unwrap();
    store.delete_dashboard_if_current(&pin).await.unwrap();
    assert!(matches!(
        store.get_dashboard(dashboard.id).await,
        Err(AppError::NotFound(_))
    ));
}

#[tokio::test]
async fn history_dashboard_prepare_rejects_scope_aba() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let user_a = workspace_user("10000000-0000-0000-0000-000000000001", "Alpha");
    let user_b = workspace_user("20000000-0000-0000-0000-000000000002", "Beta");
    for user in [&user_a, &user_b] {
        store.remember_workspace_account(user).await.unwrap();
    }
    store.activate_workspace_account(&user_a.id).await.unwrap();
    let connection_id = Uuid::new_v4();
    store
        .upsert_connection(&sqlite_profile(connection_id, "history"))
        .await
        .unwrap();
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
    let execution_pin = store.pin_connection_for_read(connection_id).await.unwrap();
    store
        .insert_history_if_current(&execution_pin, &history)
        .await
        .unwrap();
    let resolved = store
        .resolve_history_for_dashboard_prepare(history.id)
        .await
        .unwrap();

    store.activate_workspace_account(&user_b.id).await.unwrap();
    store.activate_workspace_account(&user_a.id).await.unwrap();
    let repinned = store
        .pin_connection_for_dashboard(connection_id)
        .await
        .unwrap();
    assert!(matches!(
        store.get_history_if_current(&repinned, &resolved).await,
        Err(AppError::Blocked { .. })
    ));
}

#[tokio::test]
async fn viewer_can_revalidate_existing_agent_history_for_dashboard_metadata() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Member");
    store
        .sync_account_workspaces(
            &user,
            &[(workspace_id, "Shared".into(), WorkspaceRole::Analyst)],
        )
        .await
        .unwrap();
    let connection_id = Uuid::new_v4();
    let mut template = sqlite_profile(connection_id, "shared");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::Read;
    template.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template.clone(), 1)])
        .await
        .unwrap();
    store
        .activate_workspace(workspace_id, Some(&user.id))
        .await
        .unwrap();
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
    let read_pin = store.pin_connection_for_read(connection_id).await.unwrap();
    store
        .insert_history_if_current(&read_pin, &history)
        .await
        .unwrap();

    template.workspace_access = crate::model::WorkspaceConnectionAccess::View;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template, 2)])
        .await
        .unwrap();
    store
        .sync_account_workspaces(
            &user,
            &[(workspace_id, "Shared".into(), WorkspaceRole::Viewer)],
        )
        .await
        .unwrap();
    let resolved = store
        .resolve_history_for_dashboard_prepare(history.id)
        .await
        .unwrap();
    let dashboard_pin = store
        .pin_connection_for_dashboard(connection_id)
        .await
        .unwrap();
    assert!(matches!(
        store.pin_connection_for_read(connection_id).await,
        Err(AppError::Blocked { .. })
    ));
    assert_eq!(
        store
            .get_history_if_current(&dashboard_pin, &resolved)
            .await
            .unwrap()
            .id,
        history.id
    );
}

#[test]
fn mongodb_engine_text_round_trips() {
    assert_eq!(engine_str(Engine::Mongodb), "mongodb");
    assert_eq!(parse_engine("mongodb".into()).unwrap(), Engine::Mongodb);
}

#[tokio::test]
async fn legacy_chat_archive_remains_readable_without_mutation_paths() {
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
        .upsert_connection(&sqlite_profile(connection_id, "chat-context"))
        .await
        .unwrap();

    let thread_id = seed_legacy_chat_thread(&store, connection_id, "Legacy conversation").await;
    let user_id = seed_legacy_chat_message(&store, thread_id, "user", "hello there").await;
    let assistant_id = seed_legacy_chat_message(&store, thread_id, "assistant", "hi!").await;

    let messages = store
        .list_retired_chat_archive_messages(RetiredChatThreadId::from(thread_id))
        .await
        .unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(Uuid::from(messages[0].id), user_id);
    assert_eq!(messages[0].role, "user");
    assert_eq!(Uuid::from(messages[1].id), assistant_id);
    assert_eq!(messages[1].role, "assistant");

    let listed = store.list_retired_chat_archive_threads().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(Uuid::from(listed[0].id), thread_id);
    assert_eq!(listed[0].title, "Legacy conversation");
    assert_eq!(listed[0].cli_session_id.as_deref(), Some("legacy-session"));
    assert_eq!(listed[0].model.as_deref(), Some("legacy-model"));
    assert_eq!(listed[0].effort.as_deref(), Some("high"));
}
