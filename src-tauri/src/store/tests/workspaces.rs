//! Workspace account, membership, and active-scope tests.

use super::fixtures::*;

#[tokio::test]
async fn remembered_account_can_activate_personal_scope_before_membership_sync() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Offline");

    store.remember_workspace_account(&user).await.unwrap();
    let active = store.activate_workspace_account(&user.id).await.unwrap();

    assert_eq!(active.id.to_string(), migrations::PERSONAL_WORKSPACE_ID);
    assert_eq!(
        store.workspace_accounts().await.unwrap()[0].user.id,
        user.id
    );
}

#[tokio::test]
async fn active_workspace_scopes_connections_and_tombstones_mutations() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let personal_id = Uuid::parse_str(migrations::PERSONAL_WORKSPACE_ID).unwrap();
    let personal_connection = sqlite_profile(Uuid::new_v4(), "personal");
    store.upsert_connection(&personal_connection).await.unwrap();
    let personal_dashboard = store
        .save_dashboard(&DashboardDraft {
            connection_id: ConnectionId::from(personal_connection.id),
            title: "personal dashboard".into(),
            description: String::new(),
            sql: "SELECT 1".into(),
            visualization: DashboardVisualization {
                version: 1,
                kind: DashboardKind::Table,
                x_column: None,
                y_columns: Vec::new(),
            },
        })
        .await
        .unwrap();

    let team_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Owner");
    store
        .sync_account_workspaces(&user, &[(team_id, "Team".into(), WorkspaceRole::Owner)])
        .await
        .unwrap();
    store
        .activate_workspace(team_id, Some(&user.id))
        .await
        .unwrap();
    assert!(store.list_connections().await.unwrap().is_empty());
    assert!(matches!(
        store.get_connection(personal_connection.id).await,
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        store.get_dashboard(personal_dashboard.id).await,
        Err(AppError::NotFound(_))
    ));

    let team_connection = sqlite_profile(Uuid::new_v4(), "team");
    store.upsert_connection(&team_connection).await.unwrap();
    assert_eq!(
        store.list_connections().await.unwrap()[0].id,
        team_connection.id
    );
    store.delete_connection(team_connection.id).await.unwrap();
    assert!(store.list_connections().await.unwrap().is_empty());
    let tombstone: Option<String> =
        sqlx::query_scalar("SELECT deleted_at FROM connections WHERE id = ?1")
            .bind(team_connection.id.to_string())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert!(tombstone.is_some());
    let delete_payload: Option<String> = sqlx::query_scalar(
        "SELECT payload_json FROM sync_outbox
             WHERE resource_id = ?1 AND operation = 'delete' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(team_connection.id.to_string())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert!(delete_payload.is_none());

    store
        .activate_workspace(personal_id, Some(&user.id))
        .await
        .unwrap();
    assert_eq!(
        store.list_connections().await.unwrap()[0].id,
        personal_connection.id
    );
}

#[tokio::test]
async fn account_membership_sync_preserves_other_accounts_and_restores_scope() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let alpha = Uuid::new_v4();
    let beta = Uuid::new_v4();
    let user_a = workspace_user("10000000-0000-0000-0000-000000000001", "Alpha");
    let user_b = workspace_user("20000000-0000-0000-0000-000000000002", "Beta");

    store
        .sync_account_workspaces(
            &user_a,
            &[
                (alpha, "Alpha".into(), WorkspaceRole::Owner),
                (beta, "Beta".into(), WorkspaceRole::Editor),
            ],
        )
        .await
        .unwrap();
    store
        .sync_account_workspaces(
            &user_b,
            &[(alpha, "Alpha shared".into(), WorkspaceRole::Viewer)],
        )
        .await
        .unwrap();
    let listed = store.list_workspaces().await.unwrap();
    assert_eq!(listed.len(), 3);
    assert!(listed
        .iter()
        .any(|workspace| workspace.id == WorkspaceId::from(alpha)));
    assert!(listed
        .iter()
        .any(|workspace| workspace.id == WorkspaceId::from(beta)));

    store
        .activate_workspace(alpha, Some(&user_a.id))
        .await
        .unwrap();
    store
        .sync_account_workspaces(
            &user_a,
            &[(beta, "Beta renamed".into(), WorkspaceRole::Admin)],
        )
        .await
        .unwrap();
    let listed = store.list_workspaces().await.unwrap();
    assert_eq!(listed.len(), 3);
    assert!(listed
        .iter()
        .any(|workspace| workspace.id == WorkspaceId::from(alpha)));
    assert_eq!(
        listed
            .iter()
            .find(|workspace| workspace.id == WorkspaceId::from(beta))
            .unwrap()
            .name,
        "Beta renamed"
    );
    assert_eq!(
        store.active_workspace().await.unwrap().id,
        WorkspaceId::from(beta)
    );
    let accounts = store.workspace_accounts().await.unwrap();
    assert_eq!(accounts.len(), 2);
    assert_eq!(accounts[0].user.id, user_a.id);
    assert_eq!(accounts[0].memberships[0].role, WorkspaceRole::Admin);

    store.sync_account_workspaces(&user_b, &[]).await.unwrap();
    let alpha_state: String =
        sqlx::query_scalar("SELECT lifecycle_state FROM workspaces WHERE id = ?1")
            .bind(alpha.to_string())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(alpha_state, "archived");
}

#[tokio::test]
async fn membership_revocation_repairs_active_scope_in_the_same_transaction() {
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
                &[(
                    workspace_id,
                    "Still active for Beta".into(),
                    WorkspaceRole::Analyst,
                )],
            )
            .await
            .unwrap();
    }
    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    let before = store.active_resource_scope().await.unwrap();

    // The workspace remains globally active through Beta, but Alpha's exact
    // membership disappears. The committed scope must already be repaired.
    store.sync_account_workspaces(&user_a, &[]).await.unwrap();
    let after = store.active_resource_scope().await.unwrap();
    assert_eq!(
        after.workspace_id.to_string(),
        migrations::PERSONAL_WORKSPACE_ID
    );
    assert_eq!(
        after.selected_account_id.as_deref(),
        Some(user_a.id.as_str())
    );
    assert!(after.generation > before.generation);
    let workspace_state: String =
        sqlx::query_scalar("SELECT lifecycle_state FROM workspaces WHERE id = ?1")
            .bind(workspace_id.to_string())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(workspace_state, "active");
}

#[tokio::test]
async fn startup_repair_fails_closed_for_legacy_invalid_scope_tuples() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let workspace_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Known");
    sqlx::query(
        "INSERT INTO workspace_accounts
                (user_id, email, display_name, created_at, updated_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?4, ?4)",
    )
    .bind(user.id.as_str())
    .bind(&user.email)
    .bind(&user.display_name)
    .bind(Utc::now())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspaces
                (id, name, kind, lifecycle_state, created_at, updated_at)
             VALUES (?1, 'Revoked team', 'team', 'active', ?2, ?2)",
    )
    .bind(workspace_id.to_string())
    .bind(Utc::now())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE app_settings SET value = ?1 WHERE key = 'active_workspace_id'")
        .bind(workspace_id.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO app_settings (key, value)
             VALUES ('active_workspace_account_id', ?1)",
    )
    .bind(user.id.as_str())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE app_settings SET value = '7'
             WHERE key = 'active_scope_generation'",
    )
    .execute(&pool)
    .await
    .unwrap();

    repair_active_scope_on_open(&pool).await.unwrap();
    repair_active_scope_on_open(&pool).await.unwrap();
    let store = Store::from_pool_for_test(pool.clone());
    let repaired = store.active_resource_scope().await.unwrap();
    assert_eq!(
        repaired.workspace_id.to_string(),
        migrations::PERSONAL_WORKSPACE_ID
    );
    assert_eq!(
        repaired.selected_account_id.as_deref(),
        Some(user.id.as_str())
    );
    assert_eq!(repaired.generation, 8);

    sqlx::query(
        "UPDATE app_settings SET value = 'missing-account'
             WHERE key = 'active_workspace_account_id'",
    )
    .execute(&pool)
    .await
    .unwrap();
    repair_active_scope_on_open(&pool).await.unwrap();
    let repaired = store.active_resource_scope().await.unwrap();
    assert!(repaired.selected_account_id.is_none());
    assert_eq!(repaired.generation, 9);
}
