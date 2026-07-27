//! Workspace application contract tests.

use super::application::*;

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;
    use zeroize::Zeroizing;

    use super::*;
    use crate::connection::ConnectionManager;
    use crate::error::{AppError, AppResult};
    use crate::features::connections::ConnectionCredentialVault;
    use crate::features::workspaces::adapters::{
        ConnectionWorkspaceRuntime, HostedWorkspaceControlPlane, ProcessWorkspaceConfiguration,
        SqliteWorkspaceRepository,
    };
    use crate::features::workspaces::{WorkspaceAuthUser, WorkspaceKind, WorkspaceRole};
    use crate::kernel::identity::AccountId;
    use crate::model::{
        ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
    };
    use crate::store::Store;
    use crate::store::TEST_SCHEMA;

    type TestWorkspaceFeature = WorkspaceUseCases<
        SqliteWorkspaceRepository,
        ConnectionWorkspaceRuntime,
        HostedWorkspaceControlPlane,
        MemoryCredentials,
        ProcessWorkspaceConfiguration,
    >;

    #[derive(Default)]
    struct MemoryCredentials {
        items: Mutex<HashMap<Uuid, String>>,
        fetches: AtomicUsize,
    }

    impl MemoryCredentials {
        fn snapshot(&self) -> HashMap<Uuid, String> {
            self.items.lock().unwrap().clone()
        }

        fn fetch_count(&self) -> usize {
            self.fetches.load(Ordering::Relaxed)
        }
    }

    impl ConnectionCredentialVault for MemoryCredentials {
        fn fetch_profile(&self, profile: &ConnectionProfile) -> AppResult<Zeroizing<String>> {
            self.fetches.fetch_add(1, Ordering::Relaxed);
            let Some(secret_ref) = profile.secret_ref.as_deref() else {
                if profile.workspace_access == WorkspaceConnectionAccess::Local {
                    return Ok(Zeroizing::new(String::new()));
                }
                return Err(AppError::NotFound(format!(
                    "no credential binding for shared connection {}",
                    profile.id
                )));
            };
            let id = Uuid::parse_str(secret_ref)
                .map_err(|_| AppError::Config("invalid test credential reference".into()))?;
            self.items
                .lock()
                .unwrap()
                .get(&id)
                .cloned()
                .map(Zeroizing::new)
                .ok_or_else(|| AppError::NotFound(format!("test credential {id}")))
        }

        fn store(&self, id: &Uuid, secret: &str) -> AppResult<()> {
            self.items.lock().unwrap().insert(*id, secret.to_string());
            Ok(())
        }

        fn delete(&self, id: &Uuid) -> AppResult<()> {
            self.items.lock().unwrap().remove(id);
            Ok(())
        }
    }

    async fn harness() -> (
        TestWorkspaceFeature,
        Store,
        ConnectionManager,
        Arc<MemoryCredentials>,
    ) {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
        let store = Store::from_pool_for_test(pool);
        let connections = ConnectionManager::new(store.clone());
        let credentials = Arc::new(MemoryCredentials::default());
        (
            WorkspaceUseCases::new(
                SqliteWorkspaceRepository::new(store.clone()),
                ConnectionWorkspaceRuntime::new(connections.clone()),
                HostedWorkspaceControlPlane,
                credentials.clone(),
                ProcessWorkspaceConfiguration,
            ),
            store,
            connections,
            credentials,
        )
    }

    fn local_profile(id: Uuid) -> ConnectionProfile {
        ConnectionProfile {
            id,
            name: "local".into(),
            engine: Engine::Sqlite,
            provider: Provider::Generic,
            driver_id: Some("sqlx-sqlite".into()),
            host: String::new(),
            port: 0,
            database: ":memory:".into(),
            username: "tester".into(),
            sslmode: "disable".into(),
            extra_params: HashMap::new(),
            readonly_default: true,
            allow_writes: false,
            secret_ref: None,
            env: Some("test".into()),
            schema_group: None,
            workspace_access: WorkspaceConnectionAccess::Local,
            credential_mode: WorkspaceCredentialMode::Local,
        }
    }

    #[tokio::test]
    async fn fresh_auth_state_preserves_the_unauthenticated_wire_and_personal_scope() {
        let (service, store, _, _) = harness().await;

        assert_eq!(
            serde_json::to_value(service.auth_state().await.unwrap()).unwrap(),
            json!({
                "authenticated": false,
                "user": null,
                "accounts": [],
            })
        );
        let workspaces = service.list().await.unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(service.active().await.unwrap().id, workspaces[0].id);
        assert_eq!(workspaces[0].kind, WorkspaceKind::Personal);
        store.pool().close().await;
    }

    #[tokio::test]
    async fn single_account_sign_out_resolution_keeps_none_scoped_to_the_active_typed_account() {
        let (service, store, _, _) = harness().await;
        assert!(matches!(
            service.resolve_sign_out_account(None).await,
            Err(AppError::Config(message)) if message == "no workspace account is signed in"
        ));

        let active = WorkspaceAuthUser {
            id: AccountId::new("active-account").unwrap(),
            email: "active@example.com".into(),
            display_name: "Active".into(),
        };
        let non_active = WorkspaceAuthUser {
            id: AccountId::new("non-active-account").unwrap(),
            email: "other@example.com".into(),
            display_name: "Other".into(),
        };
        store.remember_workspace_account(&active).await.unwrap();
        store.remember_workspace_account(&non_active).await.unwrap();
        store
            .activate_workspace_account(active.id.as_str())
            .await
            .unwrap();

        assert_eq!(
            service.resolve_sign_out_account(None).await.unwrap(),
            active.id
        );
        // An explicit account remains typed and is never rewritten to the UI's
        // active account before the provider tombstone-first boundary.
        assert_eq!(
            service
                .resolve_sign_out_account(Some(non_active.id.clone()))
                .await
                .unwrap(),
            non_active.id
        );
        store.pool().close().await;
    }

    #[tokio::test]
    async fn cached_accounts_select_their_own_team_membership_without_exposing_a_session() {
        let (service, store, connections, _) = harness().await;
        let team_id = Uuid::new_v4();
        let user = WorkspaceAuthUser {
            id: AccountId::new(Uuid::new_v4().to_string()).unwrap(),
            email: "member@example.com".into(),
            display_name: "Member".into(),
        };
        store.remember_workspace_account(&user).await.unwrap();
        connections
            .sync_account_workspaces(&user, &[(team_id, "Team".into(), WorkspaceRole::Editor)])
            .await
            .unwrap();
        let active = connections
            .activate_workspace_account(&user.id)
            .await
            .unwrap();
        assert_eq!(active.id, team_id.into());

        let auth = service.auth_state().await.unwrap();
        assert!(auth.authenticated);
        assert_eq!(
            auth.user.as_ref().map(|user| user.id.as_str()),
            Some(user.id.as_str())
        );
        assert_eq!(auth.accounts.len(), 1);
        assert_eq!(auth.accounts[0].memberships.len(), 1);
        let serialized = serde_json::to_string(&auth).unwrap();
        assert!(!serialized.contains("access_token"));
        assert!(!serialized.contains("session"));
        store.pool().close().await;
    }

    #[tokio::test]
    async fn missing_workspace_selection_keeps_the_exact_not_found_contract() {
        let (service, store, _, _) = harness().await;
        let missing = Uuid::new_v4();
        assert!(matches!(
            service.activate(missing.into(), None).await,
            Err(AppError::NotFound(message)) if message == format!("workspace {missing}")
        ));
        store.pool().close().await;
    }

    #[tokio::test]
    async fn copy_resolves_local_scope_before_reading_or_publishing_credentials() {
        let (service, store, _, credentials) = harness().await;
        let connection_id = Uuid::new_v4();
        let secret_id = Uuid::new_v4();
        credentials
            .store(&secret_id, "never-read-for-a-missing-team")
            .unwrap();
        let mut profile = local_profile(connection_id);
        profile.secret_ref = Some(secret_id.to_string());
        store.upsert_connection(&profile).await.unwrap();
        let missing_team = Uuid::new_v4();

        assert!(matches!(
            service
                .copy_connection(WorkspaceConnectionCopyRequest {
                    connection_id: connection_id.into(),
                    workspace_id: missing_team.into(),
                    account_user_id: AccountId::new(Uuid::new_v4().to_string()).unwrap(),
                })
                .await,
            Err(AppError::NotFound(message))
                if message == format!("team workspace {missing_team}")
        ));
        assert_eq!(
            credentials.snapshot().get(&secret_id).map(String::as_str),
            Some("never-read-for-a-missing-team")
        );
        assert_eq!(credentials.fetch_count(), 0);
        store.pool().close().await;
    }

    #[tokio::test]
    async fn binding_validates_secrets_before_scope_mutation_and_rejects_local_profiles() {
        let (service, store, _, credentials) = harness().await;
        let connection_id = Uuid::new_v4();
        store
            .upsert_connection(&local_profile(connection_id))
            .await
            .unwrap();

        assert!(matches!(
            service
                .bind_connection_credentials(WorkspaceCredentialBindingRequest {
                    connection_id: connection_id.into(),
                    username: "bad\nname".into(),
                    password: Zeroizing::new("secret".into()),
                })
                .await,
            Err(AppError::Config(message)) if message == "username is invalid"
        ));
        assert!(matches!(
            service
                .bind_connection_credentials(WorkspaceCredentialBindingRequest {
                    connection_id: connection_id.into(),
                    username: "member".into(),
                    password: Zeroizing::new(String::new()),
                })
                .await,
            Err(AppError::Config(message))
                if message == "connection credential is empty or exceeds the size limit"
        ));
        assert!(matches!(
            service
                .bind_connection_credentials(WorkspaceCredentialBindingRequest {
                    connection_id: connection_id.into(),
                    username: " member ".into(),
                    password: Zeroizing::new("secret".into()),
                })
                .await,
            Err(AppError::Config(message))
                if message == "connection is not a shared workspace template"
        ));
        assert!(credentials.snapshot().is_empty());
        store.pool().close().await;
    }
}
