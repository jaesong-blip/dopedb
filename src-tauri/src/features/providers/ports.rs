//! Platform ports for provider credential use cases.

use crate::error::AppResult;
use crate::kernel::identity::{
    ProviderBindingId, ProviderCredentialReceiptId, ProviderIntegrationId,
};
use crate::model::Engine;
use chrono::{DateTime, Utc};
use std::future::Future;
use std::pin::Pin;

use super::domain::{
    ProviderBindingScope, ProviderBindingStatus, ProviderCredentialCleanup,
    ProviderCredentialReceipt, ProviderIntegrationSummary, ProviderScope, ProviderVerification,
    ReplacedProviderCredential, TombstonedProviderBinding,
};

/// OS credential store isolated from connection and workspace-session vaults.
pub(crate) trait ProviderCredentialVault: Clone + Send + Sync + 'static {
    fn delete(&self, cleanup: &ProviderCredentialCleanup) -> AppResult<()>;
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

/// Narrow connection-runtime boundary consumed by complete managed-access
/// provisioners. It can open one exact uncached short lease or fence one
/// connection, but cannot execute arbitrary SQL or inspect credential material.
pub(crate) trait ProvisioningRuntimePort: Send + Sync + 'static {
    fn smoke<'a>(
        &'a self,
        connection_id: uuid::Uuid,
        connection_revision: i64,
        provider: super::domain::LocalProvider,
        engine: Engine,
        access: super::provisioning::ProvisioningAccessMode,
    ) -> Pin<Box<dyn Future<Output = AppResult<()>> + Send + 'a>>;

    fn force_fence<'a>(
        &'a self,
        connection_id: uuid::Uuid,
    ) -> Pin<Box<dyn Future<Output = AppResult<()>> + Send + 'a>>;
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
