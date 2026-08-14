//! SQLite adapter for local provider binding metadata.

use chrono::{DateTime, Utc};

use crate::error::{AppError, AppResult};
use crate::kernel::access::{AccountScope, ActiveResourceScope, WorkspaceKind};
use crate::kernel::identity::{AccountId, ProviderBindingId, ProviderIntegrationId, WorkspaceId};
use crate::store::Store;

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
            workspace_kind: WorkspaceKind::Team,
            selected_account_id: Some(scope.account_id.as_str().to_owned()),
            account_scope: AccountScope::WorkspaceUser(scope.account_id.as_str().to_owned()),
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
