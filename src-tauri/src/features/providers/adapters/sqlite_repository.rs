//! SQLite adapter for local provider binding metadata.

use chrono::{DateTime, Utc};

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{AccountId, ProviderBindingId, ProviderIntegrationId, WorkspaceId};
use crate::store::{ActiveResourceScope, Store};

use super::sqlite_bindings::{ProviderBindingCommit, ProviderBindingRow, ProviderCleanupRow};

use super::super::domain::{
    LocalProvider, ProviderBindingScope, ProviderBindingState, ProviderBindingStatus,
    ProviderCredentialCleanup, ProviderScope, ReplacedProviderCredential,
};
use super::super::ports::ProviderBindingRepository;

#[derive(Clone)]
pub(crate) struct SqliteProviderBindingRepository {
    store: Store,
}

impl SqliteProviderBindingRepository {
    pub(crate) fn new(store: Store) -> Self {
        Self { store }
    }

    fn scope(scope: ActiveResourceScope) -> AppResult<ProviderScope> {
        let account_id = scope
            .selected_account_id
            .and_then(AccountId::new)
            .ok_or_else(|| AppError::Blocked {
                reason: "provider credentials require an active workspace account".into(),
            })?;
        Ok(ProviderScope {
            workspace_id: WorkspaceId::from(scope.workspace_id),
            account_id,
            scope_generation: scope.generation,
        })
    }

    fn active_scope(scope: &ProviderScope) -> ActiveResourceScope {
        // Store only accepts this full value to run its final same-transaction
        // authority predicate. The other fields are not security inputs there.
        ActiveResourceScope {
            workspace_id: scope.workspace_id.into(),
            workspace_kind: crate::features::workspaces::WorkspaceKind::Team,
            selected_account_id: Some(scope.account_id.as_str().to_owned()),
            account_scope: crate::store::AccountScope::WorkspaceUser(
                scope.account_id.as_str().to_owned(),
            ),
            generation: scope.scope_generation,
        }
    }

    /// Reads the complete current scope snapshot used to bind a local
    /// credential to this desktop account/workspace selection.
    pub(crate) async fn current_scope(&self) -> AppResult<ProviderScope> {
        Self::scope(self.store.active_resource_scope().await?)
    }

    fn cleanup_from_binding(
        row: &ProviderBindingRow,
    ) -> AppResult<Option<ProviderCredentialCleanup>> {
        let Some(keyring_ref) = row.keyring_ref else {
            return Ok(None);
        };
        Ok(Some(ProviderCredentialCleanup {
            scope: ProviderScope {
                workspace_id: WorkspaceId::from(row.workspace_id),
                account_id: AccountId::new(&row.account_user_id)
                    .ok_or_else(|| AppError::Config("invalid provider cleanup account".into()))?,
                scope_generation: 0,
            },
            provider: LocalProvider::parse(&row.provider)
                .ok_or_else(|| AppError::Config("invalid provider cleanup provider".into()))?,
            integration_id: ProviderIntegrationId::from(row.integration_id),
            integration_generation: row.integration_generation.clone(),
            binding_id: ProviderBindingId::from(row.binding_id),
            keyring_ref: ProviderBindingId::from(keyring_ref),
        }))
    }

    fn cleanup_from_row(row: ProviderCleanupRow) -> AppResult<ProviderCredentialCleanup> {
        Ok(ProviderCredentialCleanup {
            scope: ProviderScope {
                workspace_id: WorkspaceId::from(row.workspace_id),
                account_id: AccountId::new(&row.account_user_id)
                    .ok_or_else(|| AppError::Config("invalid provider cleanup account".into()))?,
                scope_generation: 0,
            },
            provider: LocalProvider::parse(&row.provider)
                .ok_or_else(|| AppError::Config("invalid provider cleanup provider".into()))?,
            integration_id: ProviderIntegrationId::from(row.integration_id),
            integration_generation: row.integration_generation,
            binding_id: ProviderBindingId::from(row.binding_id),
            keyring_ref: ProviderBindingId::from(row.keyring_ref),
        })
    }

    fn tombstoned_from_binding(
        row: ProviderBindingRow,
    ) -> AppResult<super::super::domain::TombstonedProviderBinding> {
        Ok(super::super::domain::TombstonedProviderBinding {
            binding_id: ProviderBindingId::from(row.binding_id),
            cleanup: Self::cleanup_from_binding(&row)?,
        })
    }

    /// Reads the current durable binding only after proving the requested
    /// account/workspace is still the active local scope.  This is intentionally
    /// separate from the application repository trait: the returned row carries
    /// an opaque keyring reference and is private to provider-local resolution.
    pub(crate) async fn local_binding(
        &self,
        scope: &ProviderScope,
        provider: LocalProvider,
        integration_id: ProviderIntegrationId,
        integration_generation: &str,
    ) -> AppResult<ProviderBindingRow> {
        let active = self.current_scope().await?;
        if active != *scope {
            return Err(AppError::Blocked {
                reason: "provider-local credential binding is no longer authorized".into(),
            });
        }
        self.store
            .provider_binding_for_local_authority(
                scope.workspace_id.into(),
                scope.account_id.as_str(),
                provider.storage_key(),
                integration_id.into(),
                integration_generation,
                &scope.fingerprint(),
            )
            .await?
            .ok_or_else(|| AppError::Blocked {
                reason: "provider-local credential binding is unavailable".into(),
            })
    }
}

impl ProviderBindingRepository for SqliteProviderBindingRepository {
    async fn active_scope(&self) -> AppResult<ProviderScope> {
        Self::scope(self.store.active_resource_scope().await?)
    }

    async fn list(&self) -> AppResult<Vec<ProviderBindingStatus>> {
        let raw = self.store.active_resource_scope().await?;
        self.store
            .list_provider_bindings(&raw)
            .await?
            .into_iter()
            .map(|row| {
                let updated_at = DateTime::parse_from_rfc3339(&row.updated_at)
                    .map(|value| value.with_timezone(&Utc))
                    .map_err(|_| AppError::Config("invalid provider binding timestamp".into()))?;
                Ok(ProviderBindingStatus {
                    binding_id: ProviderBindingId::from(row.binding_id),
                    provider: LocalProvider::parse(&row.provider).ok_or_else(|| {
                        AppError::Config("invalid provider binding provider".into())
                    })?,
                    integration_id: ProviderIntegrationId::from(row.integration_id),
                    integration_generation: row.integration_generation,
                    state: if row.tombstoned_at.is_some() {
                        if row.delete_pending {
                            ProviderBindingState::DeletionPending
                        } else {
                            ProviderBindingState::Revoked
                        }
                    } else if row.provider == "neon" && row.keyring_ref.is_none() {
                        ProviderBindingState::Unavailable
                    } else {
                        ProviderBindingState::Ready
                    },
                    updated_at,
                })
            })
            .collect()
    }

    async fn commit(
        &self,
        binding: &ProviderBindingScope,
        binding_id: ProviderBindingId,
        keyring_ref: Option<ProviderBindingId>,
        principal: &str,
    ) -> AppResult<Option<ReplacedProviderCredential>> {
        let active = Self::active_scope(&binding.scope);
        let scope_fingerprint = binding.scope.fingerprint();
        self.store
            .commit_provider_binding(ProviderBindingCommit {
                scope: &active,
                provider: binding.provider.storage_key(),
                integration_id: binding.integration_id.into(),
                integration_generation: &binding.integration_generation,
                binding_id: binding_id.into(),
                keyring_ref: keyring_ref.map(Into::into),
                principal_redacted: principal,
                scope_fingerprint: &scope_fingerprint,
            })
            .await
            .map(|old| {
                old.map(|old| ReplacedProviderCredential {
                    cleanup: ProviderCredentialCleanup {
                        scope: binding.scope.clone(),
                        provider: LocalProvider::parse(&old.provider)
                            .expect("stored provider is valid"),
                        integration_id: ProviderIntegrationId::from(old.integration_id),
                        integration_generation: old.integration_generation,
                        binding_id: ProviderBindingId::from(old.binding_id),
                        keyring_ref: ProviderBindingId::from(old.keyring_ref),
                    },
                })
            })
    }

    async fn tombstone(
        &self,
        binding_id: ProviderBindingId,
    ) -> AppResult<Option<super::super::domain::TombstonedProviderBinding>> {
        let scope = self.active_scope().await?;
        let active = Self::active_scope(&scope);
        self.store
            .tombstone_provider_binding(&active, binding_id.into())
            .await
            .and_then(|row| row.map(Self::tombstoned_from_binding).transpose())
    }

    async fn pending_cleanup(&self) -> AppResult<Vec<ProviderCredentialCleanup>> {
        self.store
            .list_provider_cleanup_global()
            .await?
            .into_iter()
            .map(Self::cleanup_from_row)
            .collect()
    }

    async fn complete_cleanup(&self, cleanup: &ProviderCredentialCleanup) -> AppResult<()> {
        self.store
            .complete_provider_cleanup(&ProviderCleanupRow {
                workspace_id: cleanup.scope.workspace_id.into(),
                account_user_id: cleanup.scope.account_id.as_str().to_owned(),
                provider: cleanup.provider.storage_key().into(),
                integration_id: cleanup.integration_id.into(),
                integration_generation: cleanup.integration_generation.clone(),
                binding_id: cleanup.binding_id.into(),
                keyring_ref: cleanup.keyring_ref.into(),
            })
            .await
    }

    async fn enqueue_cleanup(&self, cleanup: &ProviderCredentialCleanup) -> AppResult<()> {
        self.store
            .enqueue_provider_cleanup(&ProviderCleanupRow {
                workspace_id: cleanup.scope.workspace_id.into(),
                account_user_id: cleanup.scope.account_id.as_str().to_owned(),
                provider: cleanup.provider.storage_key().into(),
                integration_id: cleanup.integration_id.into(),
                integration_generation: cleanup.integration_generation.clone(),
                binding_id: cleanup.binding_id.into(),
                keyring_ref: cleanup.keyring_ref.into(),
            })
            .await
    }

    async fn reconcile_authority(
        &self,
        integrations: &[super::super::domain::ProviderIntegrationSummary],
    ) -> AppResult<Vec<super::super::domain::TombstonedProviderBinding>> {
        let scope = self.active_scope().await?;
        let active = Self::active_scope(&scope);
        let bindings = self.store.list_provider_bindings(&active).await?;
        let mut tombstoned = Vec::new();
        for binding in bindings
            .into_iter()
            .filter(|binding| binding.tombstoned_at.is_none())
        {
            let current = integrations.iter().any(|integration| {
                integration.id == ProviderIntegrationId::from(binding.integration_id)
                    && integration.provider.storage_key() == binding.provider
                    && integration.generation == binding.integration_generation
                    && integration.state == super::super::domain::ProviderIntegrationState::Active
            });
            if !current {
                if let Some(binding) = self
                    .store
                    .tombstone_provider_binding(&active, binding.binding_id)
                    .await?
                {
                    tombstoned.push(Self::tombstoned_from_binding(binding)?);
                }
            }
        }
        Ok(tombstoned)
    }

    async fn tombstone_account(
        &self,
        account_id: Option<&AccountId>,
    ) -> AppResult<Vec<super::super::domain::TombstonedProviderBinding>> {
        self.store
            .tombstone_provider_bindings_for_account(account_id.map(AccountId::as_str))
            .await
            .and_then(|bindings| {
                bindings
                    .into_iter()
                    .map(Self::tombstoned_from_binding)
                    .collect()
            })
    }

    async fn reconcile_grants(
        &self,
        grants: &[(AccountId, WorkspaceId)],
    ) -> AppResult<Vec<super::super::domain::TombstonedProviderBinding>> {
        let grants = grants
            .iter()
            .map(|(account, workspace)| (account.as_str().to_owned(), (*workspace).into()))
            .collect::<Vec<_>>();
        self.store
            .reconcile_provider_grants(&grants)
            .await
            .and_then(|bindings| {
                bindings
                    .into_iter()
                    .map(Self::tombstoned_from_binding)
                    .collect()
            })
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use crate::features::providers::domain::{LocalProvider, ProviderScope};
    use crate::kernel::identity::{AccountId, ProviderIntegrationId, WorkspaceId};
    use crate::store::{Store, TEST_SCHEMA};

    use super::SqliteProviderBindingRepository;

    async fn store() -> Store {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
        Store::from_pool_for_test(pool)
    }

    async fn seed(store: &Store, workspace: Uuid, account: &str, binding: Uuid, integration: Uuid) {
        sqlx::query("INSERT INTO workspaces (id,name,kind,lifecycle_state,created_at,updated_at) VALUES (?1,'Team','team','active','now','now')")
            .bind(workspace.to_string()).execute(store.pool()).await.unwrap();
        sqlx::query("INSERT INTO workspace_members (id,workspace_id,user_id,display_name,role,status,joined_at) VALUES (?1,?2,?3,'Member','viewer','active','now')")
            .bind(Uuid::new_v4().to_string()).bind(workspace.to_string()).bind(account).execute(store.pool()).await.unwrap();
        sqlx::query("INSERT INTO app_settings (key,value) VALUES ('active_workspace_account_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(account).execute(store.pool()).await.unwrap();
        sqlx::query("INSERT INTO app_settings (key,value) VALUES ('active_workspace_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(workspace.to_string()).execute(store.pool()).await.unwrap();
        sqlx::query("INSERT INTO app_settings (key,value) VALUES ('active_scope_generation','9') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .execute(store.pool()).await.unwrap();
        let fingerprint = format!("provider-scope:v1:{workspace}:{account}:9");
        sqlx::query("INSERT INTO workspace_provider_bindings (binding_id,workspace_id,account_user_id,provider,integration_id,integration_generation,keyring_ref,principal_redacted,scope_fingerprint,verified_at,revision,tombstoned_at,delete_pending,created_at,updated_at) VALUES (?1,?2,?3,'neon',?4,'7',?1,'redacted',?5,'now',3,NULL,0,'now','now')")
            .bind(binding.to_string()).bind(workspace.to_string()).bind(account).bind(integration.to_string()).bind(fingerprint).execute(store.pool()).await.unwrap();
    }

    #[tokio::test]
    async fn local_binding_requires_exact_active_account_workspace_generation_and_live_row() {
        let store = store().await;
        let workspace = Uuid::new_v4();
        let binding = Uuid::new_v4();
        let integration = Uuid::new_v4();
        seed(&store, workspace, "member-a", binding, integration).await;
        let repository = SqliteProviderBindingRepository::new(store.clone());
        let scope = ProviderScope {
            workspace_id: WorkspaceId::from(workspace),
            account_id: AccountId::new("member-a").unwrap(),
            scope_generation: 9,
        };
        let loaded = repository
            .local_binding(
                &scope,
                LocalProvider::Neon,
                ProviderIntegrationId::from(integration),
                "7",
            )
            .await
            .unwrap();
        assert_eq!(loaded.binding_id, binding);
        assert_eq!(loaded.revision, 3);
        let stale_scope = ProviderScope {
            scope_generation: 8,
            ..scope.clone()
        };
        assert!(repository
            .local_binding(
                &stale_scope,
                LocalProvider::Neon,
                ProviderIntegrationId::from(integration),
                "7",
            )
            .await
            .is_err());
        sqlx::query(
            "UPDATE workspace_provider_bindings SET scope_fingerprint='wrong' WHERE binding_id=?1",
        )
        .bind(binding.to_string())
        .execute(store.pool())
        .await
        .unwrap();
        assert!(repository
            .local_binding(
                &scope,
                LocalProvider::Neon,
                ProviderIntegrationId::from(integration),
                "7",
            )
            .await
            .is_err());
        sqlx::query(
            "UPDATE workspace_provider_bindings SET scope_fingerprint=?1 WHERE binding_id=?2",
        )
        .bind(scope.fingerprint())
        .bind(binding.to_string())
        .execute(store.pool())
        .await
        .unwrap();
        assert!(repository
            .local_binding(
                &scope,
                LocalProvider::Neon,
                ProviderIntegrationId::from(integration),
                "8",
            )
            .await
            .is_err());
        let other_scope = ProviderScope {
            account_id: AccountId::new("member-b").unwrap(),
            ..scope
        };
        assert!(repository
            .local_binding(
                &other_scope,
                LocalProvider::Neon,
                ProviderIntegrationId::from(integration),
                "7",
            )
            .await
            .is_err());
        sqlx::query(
            "UPDATE workspace_provider_bindings SET tombstoned_at='now' WHERE binding_id=?1",
        )
        .bind(binding.to_string())
        .execute(store.pool())
        .await
        .unwrap();
        assert!(repository
            .local_binding(
                &scope,
                LocalProvider::Neon,
                ProviderIntegrationId::from(integration),
                "7",
            )
            .await
            .is_err());
    }
}
