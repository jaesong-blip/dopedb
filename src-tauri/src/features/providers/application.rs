//! Provider credential use cases with hosted authority revalidation.

use chrono::Utc;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{DeviceId, ProviderBindingId, ProviderIntegrationId};

use super::domain::{
    LocalProvider, ProviderBindingState, ProviderBindingStatus, ProviderCredentialCleanup,
    ProviderCredentialMaterial, ProviderCredentialReceipt, ProviderVerification,
    RevokeProviderCredential, TombstonedProviderBinding, VerifyProviderCredential,
};
use super::ports::{
    GcpAdcVerifier, ProviderAuthorityPort, ProviderBindingRepository,
    ProviderBindingRevocationPort, ProviderCredentialVault, ProviderReceiptRegistry,
    ProviderVerifier,
};

#[derive(Clone)]
pub(crate) struct ProviderUseCases<R, V, P, G, Q, A> {
    repository: R,
    vault: V,
    verifier: P,
    gcp_verifier: G,
    receipts: Q,
    authority: A,
    revocation: std::sync::Arc<dyn ProviderBindingRevocationPort>,
    process_device: DeviceId,
}

impl<R, V, P, G, Q, A> ProviderUseCases<R, V, P, G, Q, A>
where
    R: ProviderBindingRepository,
    V: ProviderCredentialVault,
    P: ProviderVerifier,
    G: GcpAdcVerifier,
    Q: ProviderReceiptRegistry,
    A: ProviderAuthorityPort,
{
    pub(crate) fn new(
        repository: R,
        vault: V,
        verifier: P,
        gcp_verifier: G,
        receipts: Q,
        authority: A,
        revocation: std::sync::Arc<dyn ProviderBindingRevocationPort>,
    ) -> Self {
        Self {
            repository,
            vault,
            verifier,
            gcp_verifier,
            receipts,
            authority,
            revocation,
            process_device: DeviceId::from(Uuid::new_v4()),
        }
    }

    pub(crate) async fn list_integrations(
        &self,
    ) -> AppResult<Vec<super::domain::ProviderIntegrationSummary>> {
        self.retry_pending_cleanup().await;
        let scope = self.repository.active_scope().await?;
        let mut integrations = self.authority.list_integrations(&scope).await?;
        // Only a successful, authenticated inventory is authoritative. Network
        // and auth failures must never infer that a durable local binding is gone.
        let tombstoned = self.repository.reconcile_authority(&integrations).await?;
        self.fence_tombstoned(tombstoned).await?;
        let bindings = self.repository.list().await?;
        for integration in &mut integrations {
            if integration.state == super::domain::ProviderIntegrationState::Active
                && bindings.iter().any(|binding| {
                    binding.provider == integration.provider
                        && binding.integration_id == integration.id
                        && binding.integration_generation == integration.generation
                        && binding.state == ProviderBindingState::Ready
                })
            {
                integration.state = super::domain::ProviderIntegrationState::Ready;
            }
        }
        self.retry_pending_cleanup().await;
        Ok(integrations)
    }

    pub(crate) async fn list_bindings(&self) -> AppResult<Vec<ProviderBindingStatus>> {
        self.retry_pending_cleanup().await;
        self.repository.list().await
    }

    pub(crate) async fn begin(
        &self,
        integration_id: ProviderIntegrationId,
        material: ProviderCredentialMaterial,
    ) -> AppResult<ProviderCredentialReceipt> {
        self.cleanup_expired(Utc::now()).await?;
        self.retry_pending_cleanup().await;
        let scope = self.repository.active_scope().await?;
        let binding = self.authority.revalidate(&scope, integration_id).await?;
        let staged = match material {
            ProviderCredentialMaterial::NeonApiKey(secret) => {
                if binding.provider != LocalProvider::Neon || secret.is_empty() {
                    return Err(AppError::Blocked {
                        reason: "Neon API key is not allowed for this provider integration".into(),
                    });
                }
                let id = ProviderBindingId::from(Uuid::new_v4());
                self.vault.store(&binding, id, &secret)?;
                Some(id)
            }
            ProviderCredentialMaterial::GcpAdc => {
                if binding.provider != LocalProvider::GcpCloudSql {
                    return Err(AppError::Blocked {
                        reason: "GCP ADC is not allowed for this provider integration".into(),
                    });
                }
                None
            }
        };
        // The receipt needs one opaque binding identity even for keyless ADC.
        let staged_id = staged.unwrap_or_else(|| ProviderBindingId::from(Uuid::new_v4()));
        match self
            .receipts
            .issue(binding.clone(), self.process_device, staged_id, Utc::now())
        {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                if staged.is_some() {
                    self.cleanup_staged(&binding, staged_id).await?;
                }
                Err(error)
            }
        }
    }

    pub(crate) async fn verify(
        &self,
        request: VerifyProviderCredential,
    ) -> AppResult<ProviderBindingStatus> {
        let now = Utc::now();
        self.cleanup_expired(now).await?;
        let (receipt_binding, staged_id) =
            self.receipts
                .claim(request.receipt_id, self.process_device, now)?;
        // Receipt is capability-pinned but authority is re-fetched before any
        // keyring read or durable mutation to prevent stale hosted grants.
        let scope = self.repository.active_scope().await?;
        if scope != receipt_binding.scope {
            self.cleanup_staged(&receipt_binding, staged_id).await?;
            return Err(AppError::Blocked {
                reason: "workspace authority changed before provider verification".into(),
            });
        }
        let binding = match self
            .authority
            .revalidate(&scope, receipt_binding.integration_id)
            .await
        {
            Ok(binding) if binding == receipt_binding => binding,
            Ok(_) | Err(_) => {
                self.cleanup_staged(&receipt_binding, staged_id).await?;
                return Err(AppError::Blocked {
                    reason: "provider integration authority changed before verification".into(),
                });
            }
        };
        let verification_result = match binding.provider {
            LocalProvider::Neon => {
                let secret = match self.vault.fetch(&binding, staged_id) {
                    Ok(secret) => secret,
                    Err(error) => {
                        self.cleanup_staged(&binding, staged_id).await?;
                        return Err(error);
                    }
                };
                self.verifier
                    .verify(&binding, secret)
                    .await
                    .map(|value| (value, Some(staged_id)))
            }
            LocalProvider::GcpCloudSql => self
                .gcp_verifier
                .verify_adc(&binding)
                .await
                .map(|value| (value, None)),
            LocalProvider::PlanetScale => {
                self.cleanup_staged(&binding, staged_id).await?;
                return Err(AppError::Blocked {
                    reason: "PlanetScale local credentials are unsupported; use managed OAuth"
                        .into(),
                });
            }
        };
        let (verification, keyring_ref) = match verification_result {
            Ok(result) => result,
            Err(error) => {
                self.cleanup_staged(&binding, staged_id).await?;
                return Err(error);
            }
        };
        let principal = match verification {
            ProviderVerification::Verified(principal) => principal,
            ProviderVerification::Unsupported => {
                self.cleanup_staged(&binding, staged_id).await?;
                return Err(AppError::Blocked {
                    reason: "provider credential method is unsupported".into(),
                });
            }
        };
        let old = match self
            .repository
            .commit(&binding, staged_id, keyring_ref, &principal.display)
            .await
        {
            Ok(old) => old,
            Err(error) => {
                self.cleanup_staged(&binding, staged_id).await?;
                return Err(error);
            }
        };
        if let Some(old) = old.filter(|old| old.cleanup.keyring_ref != staged_id) {
            self.try_cleanup(old.cleanup).await?;
        }
        Ok(ProviderBindingStatus {
            binding_id: staged_id,
            provider: binding.provider,
            integration_id: binding.integration_id,
            integration_generation: binding.integration_generation,
            state: ProviderBindingState::Ready,
            updated_at: now,
        })
    }

    pub(crate) async fn revoke(&self, request: RevokeProviderCredential) -> AppResult<()> {
        self.retry_pending_cleanup().await;
        let Some(tombstone) = self.repository.tombstone(request.binding_id).await? else {
            return Ok(());
        };
        // Revocation is local tombstone-first work. It intentionally does not
        // ask the remote integration authority, so a remote revoke cannot keep
        // a local credential usable. Fence the matching runtime cache before
        // keyring cleanup: an active lease must lose its target pool even when
        // OS deletion becomes a durable retry.
        let cleanup = tombstone.cleanup.clone();
        self.fence_tombstoned(vec![tombstone]).await?;
        if let Some(cleanup) = cleanup {
            self.try_cleanup(cleanup)
                .await
                .map_err(|_| AppError::Blocked {
                    reason: "provider credential cleanup is pending".into(),
                })
        } else {
            Ok(())
        }
    }

    pub(crate) async fn invalidate_scope(&self) -> AppResult<()> {
        let mut failure = None;
        for (binding, staged) in self.receipts.clear_scope(None) {
            if let Err(error) = self.cleanup_staged(&binding, staged).await {
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        self.vault.clear_scope(None);
        Ok(())
    }

    pub(crate) async fn reconcile_grants(
        &self,
        grants: &[(
            crate::kernel::identity::AccountId,
            crate::kernel::identity::WorkspaceId,
        )],
    ) -> AppResult<()> {
        let tombstoned = self.repository.reconcile_grants(grants).await?;
        self.fence_tombstoned(tombstoned).await
    }

    pub(crate) async fn sign_out(
        &self,
        account_id: Option<&crate::kernel::identity::AccountId>,
    ) -> AppResult<()> {
        let tombstoned = self.repository.tombstone_account(account_id).await?;
        self.fence_tombstoned(tombstoned).await?;
        // Forgetting staged/renderer-local cache is independent from durable
        // cleanup; entries stay queued until their exact keyring delete works.
        self.invalidate_scope().await
    }

    async fn cleanup_expired(&self, now: chrono::DateTime<Utc>) -> AppResult<()> {
        let mut failure = None;
        for (binding, staged) in self.receipts.drain_expired(now) {
            if let Err(error) = self.cleanup_staged(&binding, staged).await {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// Runtime fencing is deliberately applied only after the repository has
    /// committed each durable tombstone. Attempt every exact binding even if a
    /// prior runtime fence fails, then surface the first failure so a missing
    /// composition cannot silently leave a local capability usable.
    async fn fence_tombstoned(&self, tombstoned: Vec<TombstonedProviderBinding>) -> AppResult<()> {
        let mut failure = None;
        for tombstone in tombstoned {
            if let Err(error) = self.revocation.force_fence(tombstone.binding_id).await {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
    async fn cleanup_staged(
        &self,
        binding: &super::domain::ProviderBindingScope,
        staged: ProviderBindingId,
    ) -> AppResult<()> {
        if binding.provider == LocalProvider::Neon {
            let cleanup = ProviderCredentialCleanup {
                scope: binding.scope.clone(),
                provider: binding.provider,
                integration_id: binding.integration_id,
                integration_generation: binding.integration_generation.clone(),
                binding_id: staged,
                keyring_ref: staged,
            };
            if self.vault.delete(&cleanup).is_err() {
                self.repository
                    .enqueue_cleanup(&cleanup)
                    .await
                    .map_err(|_| AppError::Blocked {
                        reason: "provider credential compensation is pending".into(),
                    })?;
            }
        }
        Ok(())
    }

    async fn retry_pending_cleanup(&self) {
        let Ok(cleanups) = self.repository.pending_cleanup().await else {
            return;
        };
        for cleanup in cleanups {
            let _ = self.try_cleanup(cleanup).await;
        }
    }

    async fn try_cleanup(&self, cleanup: ProviderCredentialCleanup) -> AppResult<()> {
        self.vault.delete(&cleanup).map_err(|_| AppError::Blocked {
            reason: "provider credential cleanup is pending".into(),
        })?;
        self.repository.complete_cleanup(&cleanup).await
    }
}
