//! Shared connection binding and catalog scope-isolation tests.

use super::fixtures::*;

#[tokio::test]
async fn remote_template_sync_preserves_member_local_credential_binding() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Owner");
    store
        .sync_account_workspaces(
            &user,
            &[(workspace_id, "Team".into(), WorkspaceRole::Owner)],
        )
        .await
        .unwrap();

    let id = Uuid::new_v4();
    let mut local_binding = sqlite_profile(id, "shared");
    local_binding.workspace_access = crate::model::WorkspaceConnectionAccess::Write;
    local_binding.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(local_binding, 1)])
        .await
        .unwrap();
    let mut member_options = HashMap::new();
    member_options.insert("member-local-option".into(), "on".into());
    let binding_ref = id.to_string();
    store
        .bind_connection_credentials(
            id,
            &user.id,
            "member-account",
            &member_options,
            Some(&binding_ref),
        )
        .await
        .unwrap();

    let mut remote_update = sqlite_profile(id, "renamed");
    remote_update.username.clear();
    remote_update.extra_params.clear();
    remote_update.secret_ref = None;
    remote_update.allow_writes = false;
    remote_update.workspace_access = crate::model::WorkspaceConnectionAccess::Read;
    remote_update.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(remote_update, 2)])
        .await
        .unwrap();
    store
        .activate_workspace(workspace_id, Some(&user.id))
        .await
        .unwrap();

    let loaded = store.get_connection(id).await.unwrap();
    assert_eq!(loaded.name, "renamed");
    assert_eq!(loaded.username, "member-account");
    assert_eq!(
        loaded
            .extra_params
            .get("member-local-option")
            .map(String::as_str),
        Some("on")
    );
    let expected_secret_ref = id.to_string();
    assert_eq!(
        loaded.secret_ref.as_deref(),
        Some(expected_secret_ref.as_str())
    );
    assert_eq!(
        loaded.workspace_access,
        crate::model::WorkspaceConnectionAccess::Read
    );
    assert!(!loaded.allow_writes);

    let removed_credential_ids = store
        .sync_remote_connections(workspace_id, &user.id, &[])
        .await
        .unwrap();
    assert!(removed_credential_ids.contains(&id));
    assert!(store.list_connections().await.unwrap().is_empty());
    let binding_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workspace_connection_bindings WHERE connection_id = ?1",
    )
    .bind(id.to_string())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(binding_count, 0);
}

#[tokio::test]
async fn managed_remote_template_never_reads_or_accepts_a_local_binding() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Owner");
    store
        .sync_account_workspaces(
            &user,
            &[(workspace_id, "Team".into(), WorkspaceRole::Owner)],
        )
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let mut template = sqlite_profile(id, "managed");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::Manage;
    template.credential_mode = crate::model::WorkspaceCredentialMode::Managed;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template, 1)])
        .await
        .unwrap();
    store
        .activate_workspace(workspace_id, Some(&user.id))
        .await
        .unwrap();

    let loaded = store.get_connection(id).await.unwrap();
    assert_eq!(
        loaded.credential_mode,
        crate::model::WorkspaceCredentialMode::Managed
    );
    assert!(loaded.username.is_empty());
    assert!(loaded.secret_ref.is_none());
    assert!(matches!(
        store
            .bind_connection_credentials(
                id,
                &user.id,
                "should-not-persist",
                &HashMap::new(),
                Some(&Uuid::new_v4().to_string()),
            )
            .await,
        Err(AppError::Blocked { .. })
    ));
    let pin = store.pin_connection_for_read(id).await.unwrap();
    assert_eq!(pin.catalog_cache_policy, CatalogCachePolicy::EphemeralOnly);
    let snapshot = catalog_snapshot(id, ":memory:", 'c');
    assert_eq!(
        store.put_catalog_if_current(&pin, &snapshot).await.unwrap(),
        CacheWriteOutcome::NotPersisted
    );
    let v2_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM schema_cache_v2")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(v2_rows, 0);
}

#[tokio::test]
async fn shared_connection_bindings_are_isolated_per_signed_in_account() {
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
                &[(workspace_id, "Shared".into(), WorkspaceRole::Analyst)],
            )
            .await
            .unwrap();
    }
    let mut template = sqlite_profile(connection_id, "shared");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::Write;
    template.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    template.allow_writes = true;
    let mut read_only_template = template.clone();
    read_only_template.workspace_access = crate::model::WorkspaceConnectionAccess::Read;
    read_only_template.allow_writes = false;
    store
        .sync_remote_connections(workspace_id, &user_a.id, &[(template, 1)])
        .await
        .unwrap();
    store
        .sync_remote_connections(workspace_id, &user_b.id, &[(read_only_template, 1)])
        .await
        .unwrap();
    let ref_a = Uuid::new_v4().to_string();
    let ref_b = Uuid::new_v4().to_string();
    let empty_options = HashMap::new();
    store
        .bind_connection_credentials(
            connection_id,
            &user_a.id,
            "alpha-db-user",
            &empty_options,
            Some(&ref_a),
        )
        .await
        .unwrap();
    store
        .bind_connection_credentials(
            connection_id,
            &user_b.id,
            "beta-db-user",
            &empty_options,
            Some(&ref_b),
        )
        .await
        .unwrap();

    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    let profile_a = store.get_connection(connection_id).await.unwrap();
    assert_eq!(profile_a.username, "alpha-db-user");
    assert_eq!(profile_a.secret_ref.as_deref(), Some(ref_a.as_str()));
    assert_eq!(
        profile_a.workspace_access,
        crate::model::WorkspaceConnectionAccess::Write
    );
    assert!(profile_a.allow_writes);
    store
        .set_schema_cache(connection_id, r#"{"owner":"alpha"}"#)
        .await
        .unwrap();
    let execution_pin_a = store.pin_connection_for_read(connection_id).await.unwrap();
    store
        .insert_history_if_current(
            &execution_pin_a,
            &HistoryEntry {
                id: Uuid::new_v4(),
                connection_id,
                sql: "SELECT 'alpha'".into(),
                kind: QueryKind::Read,
                status: "ok".into(),
                row_count: Some(1),
                duration_ms: Some(1),
                error: None,
                executed_at: Utc::now(),
                origin: "manual".into(),
            },
        )
        .await
        .unwrap();
    seed_legacy_chat_thread(&store, connection_id, "alpha archive").await;

    store
        .activate_workspace(workspace_id, Some(&user_b.id))
        .await
        .unwrap();
    let profile_b = store.get_connection(connection_id).await.unwrap();
    assert_eq!(profile_b.username, "beta-db-user");
    assert_eq!(profile_b.secret_ref.as_deref(), Some(ref_b.as_str()));
    assert_eq!(
        profile_b.workspace_access,
        crate::model::WorkspaceConnectionAccess::Read
    );
    assert!(!profile_b.allow_writes);
    assert!(matches!(
        store
            .insert_history_if_current(
                &execution_pin_a,
                &HistoryEntry {
                    id: Uuid::new_v4(),
                    connection_id,
                    sql: "SELECT 'stale-alpha'".into(),
                    kind: QueryKind::Read,
                    status: "error".into(),
                    row_count: None,
                    duration_ms: None,
                    error: Some("connection failed".into()),
                    executed_at: Utc::now(),
                    origin: "agent".into(),
                },
            )
            .await,
        Err(AppError::Blocked { .. })
    ));
    assert!(store
        .get_schema_cache(connection_id)
        .await
        .unwrap()
        .is_none());
    assert!(store.list_history(connection_id).await.unwrap().is_empty());
    assert!(store
        .list_retired_chat_archive_threads()
        .await
        .unwrap()
        .is_empty());
    store
        .set_schema_cache(connection_id, r#"{"owner":"beta"}"#)
        .await
        .unwrap();

    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    assert_eq!(
        store
            .get_schema_cache(connection_id)
            .await
            .unwrap()
            .as_deref(),
        Some(r#"{"owner":"alpha"}"#)
    );
    assert_eq!(store.list_history(connection_id).await.unwrap().len(), 1);
    assert_eq!(
        store
            .list_retired_chat_archive_threads()
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn pinned_catalog_cache_rejects_scope_aba_and_keeps_accounts_isolated() {
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
                &[(workspace_id, "Shared".into(), WorkspaceRole::Analyst)],
            )
            .await
            .unwrap();
    }
    let mut template = sqlite_profile(connection_id, "shared");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::Read;
    template.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    for user in [&user_a, &user_b] {
        store
            .sync_remote_connections(workspace_id, &user.id, &[(template.clone(), 1)])
            .await
            .unwrap();
        store
            .bind_connection_credentials(
                connection_id,
                &user.id,
                &format!("{}-db-user", user.display_name.to_lowercase()),
                &HashMap::new(),
                Some(&Uuid::new_v4().to_string()),
            )
            .await
            .unwrap();
    }

    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    let pin_a = store.pin_connection_for_read(connection_id).await.unwrap();
    assert_eq!(pin_a.scope.workspace_id, workspace_id);
    assert_eq!(pin_a.scope.account_scope.storage_key(), user_a.id.as_str());
    assert_eq!(pin_a.profile.username, "alpha-db-user");
    assert!(pin_a.requires_remote_rbac);
    assert_eq!(pin_a.catalog_cache_policy, CatalogCachePolicy::Persistent);
    assert!(store.is_pin_current(&pin_a).await.unwrap());

    // V1 rows have no revision provenance and must never be promoted/read by V2.
    sqlx::query(
        "INSERT INTO schema_cache
                (connection_id, account_scope, introspected_at, catalog_json)
             VALUES (?1, ?2, '2026-01-01', '{\"legacy\":true}')",
    )
    .bind(connection_id.to_string())
    .bind(user_a.id.as_str())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&pin_a)
        .await
        .unwrap()
        .is_none());

    let snapshot = catalog_snapshot(connection_id, ":memory:", 'a');
    assert_eq!(
        store
            .put_catalog_if_current(&pin_a, &snapshot)
            .await
            .unwrap(),
        CacheWriteOutcome::Stored
    );
    assert_eq!(
        store.get_catalog_if_current(&pin_a).await.unwrap().unwrap(),
        snapshot
    );
    let legacy_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM schema_cache
             WHERE connection_id = ?1 AND account_scope = ?2",
    )
    .bind(connection_id.to_string())
    .bind(user_a.id.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(legacy_rows, 0);

    store
        .activate_workspace(workspace_id, Some(&user_b.id))
        .await
        .unwrap();
    assert!(!store.is_pin_current(&pin_a).await.unwrap());
    assert_eq!(
        store
            .put_catalog_if_current(&pin_a, &snapshot)
            .await
            .unwrap(),
        CacheWriteOutcome::Stale
    );
    let pin_b = store.pin_connection_for_read(connection_id).await.unwrap();
    assert_eq!(pin_b.scope.account_scope.storage_key(), user_b.id.as_str());
    assert_eq!(pin_b.profile.username, "beta-db-user");
    assert!(store
        .get_catalog_if_current(&pin_b)
        .await
        .unwrap()
        .is_none());

    // Returning to A does not revive an in-flight A pin: generation defeats ABA.
    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    let repinned_a = store.pin_connection_for_read(connection_id).await.unwrap();
    assert!(repinned_a.scope.generation > pin_a.scope.generation);
    assert!(!store.is_pin_current(&pin_a).await.unwrap());
    assert_eq!(
        store
            .get_catalog_if_current(&repinned_a)
            .await
            .unwrap()
            .unwrap(),
        snapshot,
        "a current pin may reuse the same account/revision cache after re-selection"
    );

    // A rollback binary can only write V1. Its row acts as a freshness marker:
    // after re-upgrade, the new runtime must miss instead of reviving older V2.
    sqlx::query(
        "INSERT INTO schema_cache
                (connection_id, account_scope, introspected_at, catalog_json)
             VALUES (?1, ?2, '2026-07-24T00:01:00Z', '{\"rollback\":true}')
             ON CONFLICT(connection_id, account_scope) DO UPDATE SET
                introspected_at = excluded.introspected_at,
                catalog_json = excluded.catalog_json",
    )
    .bind(connection_id.to_string())
    .bind(user_a.id.as_str())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
    let refreshed = catalog_snapshot(connection_id, ":memory:", 'd');
    assert_eq!(
        store
            .put_catalog_if_current(&repinned_a, &refreshed)
            .await
            .unwrap(),
        CacheWriteOutcome::Stored
    );
    assert_eq!(
        store
            .get_catalog_if_current(&repinned_a)
            .await
            .unwrap()
            .unwrap(),
        refreshed
    );

    sqlx::query(
        "UPDATE schema_cache_v2 SET captured_at = 'not-a-time'
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3",
    )
    .bind(workspace_id.to_string())
    .bind(user_a.id.as_str())
    .bind(connection_id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
    store
        .put_catalog_if_current(&repinned_a, &refreshed)
        .await
        .unwrap();

    sqlx::query(
        "UPDATE schema_cache_v2 SET catalog_json = '{'
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3",
    )
    .bind(workspace_id.to_string())
    .bind(user_a.id.as_str())
    .bind(connection_id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
    store
        .put_catalog_if_current(&repinned_a, &refreshed)
        .await
        .unwrap();

    let mut tampered = serde_json::to_value(&refreshed).unwrap();
    tampered["fingerprint"] = serde_json::Value::String("e".repeat(64));
    sqlx::query(
        "UPDATE schema_cache_v2
             SET fingerprint = ?1, catalog_json = ?2
             WHERE workspace_id = ?3 AND account_scope = ?4 AND connection_id = ?5",
    )
    .bind("e".repeat(64))
    .bind(serde_json::to_string(&tampered).unwrap())
    .bind(workspace_id.to_string())
    .bind(user_a.id.as_str())
    .bind(connection_id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
    store
        .put_catalog_if_current(&repinned_a, &refreshed)
        .await
        .unwrap();

    sqlx::query(
        "UPDATE schema_cache_v2 SET catalog_schema_version = 1
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3",
    )
    .bind(workspace_id.to_string())
    .bind(user_a.id.as_str())
    .bind(connection_id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
}
