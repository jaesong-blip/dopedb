//! Platform ports for provider credential use cases.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use zeroize::Zeroizing;

use crate::error::AppResult;
use crate::kernel::identity::{
    ProviderBindingId, ProviderCredentialReceiptId, ProviderIntegrationId,
};

use super::domain::{
    ProviderBindingScope, ProviderBindingStatus, ProviderCredentialCleanup,
    ProviderCredentialReceipt, ProviderIntegrationSummary, ProviderScope, ProviderVerification,
    ReplacedProviderCredential, TombstonedProviderBinding,
};

/// OS credential store isolated from connection and workspace-session vaults.
pub(crate) trait ProviderCredentialVault: Clone + Send + Sync + 'static {
    fn store(
        &self,
        scope: &ProviderBindingScope,
        id: ProviderBindingId,
        secret: &str,
    ) -> AppResult<()>;
    fn fetch(
        &self,
        scope: &ProviderBindingScope,
        id: ProviderBindingId,
    ) -> AppResult<Zeroizing<String>>;
    fn delete(&self, cleanup: &ProviderCredentialCleanup) -> AppResult<()>;
    fn clear_scope(&self, scope: Option<&ProviderScope>);
}

/// Local-only SQLite binding persistence. Every write rechecks the active scope.
pub(crate) trait ProviderBindingRepository: Clone + Send + Sync + 'static {
    fn active_scope(&self) -> impl Future<Output = AppResult<ProviderScope>> + Send;
    fn list(&self) -> impl Future<Output = AppResult<Vec<ProviderBindingStatus>>> + Send;
    fn commit(
        &self,
        scope: &ProviderBindingScope,
        binding_id: ProviderBindingId,
        keyring_ref: Option<ProviderBindingId>,
        principal: &str,
    ) -> impl Future<Output = AppResult<Option<ReplacedProviderCredential>>> + Send;
    fn tombstone(
        &self,
        id: ProviderBindingId,
    ) -> impl Future<Output = AppResult<Option<TombstonedProviderBinding>>> + Send;
    fn pending_cleanup(
        &self,
    ) -> impl Future<Output = AppResult<Vec<ProviderCredentialCleanup>>> + Send;
    fn complete_cleanup(
        &self,
        cleanup: &ProviderCredentialCleanup,
    ) -> impl Future<Output = AppResult<()>> + Send;
    fn enqueue_cleanup(
        &self,
        cleanup: &ProviderCredentialCleanup,
    ) -> impl Future<Output = AppResult<()>> + Send;
    fn reconcile_authority(
        &self,
        integrations: &[ProviderIntegrationSummary],
    ) -> impl Future<Output = AppResult<Vec<TombstonedProviderBinding>>> + Send;
    fn reconcile_grants(
        &self,
        grants: &[(
            crate::kernel::identity::AccountId,
            crate::kernel::identity::WorkspaceId,
        )],
    ) -> impl Future<Output = AppResult<Vec<TombstonedProviderBinding>>> + Send;
    fn tombstone_account(
        &self,
        account_id: Option<&crate::kernel::identity::AccountId>,
    ) -> impl Future<Output = AppResult<Vec<TombstonedProviderBinding>>> + Send;
}

/// Injected provider verifier. Production adapters may make hosted requests;
/// tests supply deterministic fakes and no use case starts a process or network.
pub(crate) trait ProviderVerifier: Clone + Send + Sync + 'static {
    fn verify(
        &self,
        binding: &ProviderBindingScope,
        secret: Zeroizing<String>,
    ) -> impl Future<Output = AppResult<ProviderVerification>> + Send;
}

/// Keyless GCP ADC/WIF verification. Implementations must never read a
/// service-account JSON file or ambient credential environment implicitly.
pub(crate) trait GcpAdcVerifier: Clone + Send + Sync + 'static {
    fn verify_adc(
        &self,
        binding: &ProviderBindingScope,
    ) -> impl Future<Output = AppResult<ProviderVerification>> + Send;
}

/// Hosted control-plane authority. The adapter owns Bearer session retrieval;
/// applications receive only redacted inventory and exact capability pins.
pub(crate) trait ProviderAuthorityPort: Clone + Send + Sync + 'static {
    fn list_integrations(
        &self,
        scope: &ProviderScope,
    ) -> impl Future<Output = AppResult<Vec<ProviderIntegrationSummary>>> + Send;
    fn revalidate(
        &self,
        scope: &ProviderScope,
        integration_id: ProviderIntegrationId,
    ) -> impl Future<Output = AppResult<ProviderBindingScope>> + Send;
}

/// Runtime fence for a durable provider-binding tombstone.  The provider
/// application owns the revocation decision; the injected runtime adapter owns
/// pool detachment and must never expose a concrete connection manager here.
pub(crate) trait ProviderBindingRevocationPort: Send + Sync + 'static {
    fn force_fence<'a>(
        &'a self,
        binding_id: ProviderBindingId,
    ) -> Pin<Box<dyn Future<Output = AppResult<()>> + Send + 'a>>;
}

/// Composition-only holder used because the connection runtime consumes the
/// provider-local resolver while the provider application consumes this fence.
/// It fails closed if a non-desktop composition forgets to bind the runtime.
#[derive(Clone, Default)]
pub(crate) struct ProviderBindingRevocationHandle {
    target: Arc<std::sync::OnceLock<Arc<dyn ProviderBindingRevocationPort>>>,
}

impl ProviderBindingRevocationHandle {
    pub(crate) fn bind(&self, target: Arc<dyn ProviderBindingRevocationPort>) -> AppResult<()> {
        self.target.set(target).map_err(|_| {
            crate::error::AppError::Config(
                "provider binding revocation port was bound more than once".into(),
            )
        })
    }
}

impl ProviderBindingRevocationPort for ProviderBindingRevocationHandle {
    fn force_fence<'a>(
        &'a self,
        binding_id: ProviderBindingId,
    ) -> Pin<Box<dyn Future<Output = AppResult<()>> + Send + 'a>> {
        let target = self.target.get().cloned();
        Box::pin(async move {
            let target = target.ok_or_else(|| crate::error::AppError::Blocked {
                reason: "provider binding revocation runtime is unavailable".into(),
            })?;
            target.force_fence(binding_id).await
        })
    }
}

/// Single-owner memory-only receipt state. A process restart intentionally loses it.
pub(crate) trait ProviderReceiptRegistry: Clone + Send + Sync + 'static {
    fn drain_expired(&self, now: DateTime<Utc>) -> Vec<(ProviderBindingScope, ProviderBindingId)>;
    fn issue(
        &self,
        binding: ProviderBindingScope,
        device_id: crate::kernel::identity::DeviceId,
        staged_binding_id: ProviderBindingId,
        now: DateTime<Utc>,
    ) -> AppResult<ProviderCredentialReceipt>;
    fn claim(
        &self,
        id: ProviderCredentialReceiptId,
        device_id: crate::kernel::identity::DeviceId,
        now: DateTime<Utc>,
    ) -> AppResult<(ProviderBindingScope, ProviderBindingId)>;
    fn clear_scope(
        &self,
        scope: Option<&ProviderScope>,
    ) -> Vec<(ProviderBindingScope, ProviderBindingId)>;
}
