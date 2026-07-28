//! Member-local provider credential vertical slice.

mod adapters;
mod application;
mod domain;
pub(crate) mod ports;
pub(crate) mod transport;

use crate::store::Store;

use adapters::{
    HostedProviderAuthority, HostedProviderVerifier, InMemoryProviderReceiptRegistry,
    KeyringProviderCredentialVault, ProductionGcpAdcVerifier, ProviderLocalResolver,
    SqliteProviderBindingRepository,
};
use application::ProviderUseCases;
use ports::{ProviderBindingRevocationHandle, ProviderBindingRevocationPort};

pub(crate) use domain::{
    ProviderBindingStatus, ProviderCredentialMaterial, ProviderCredentialReceipt,
    ProviderIntegrationSummary, RevokeProviderCredential, VerifyProviderCredential,
};

type ComposedProviderApplication = ProviderUseCases<
    SqliteProviderBindingRepository,
    KeyringProviderCredentialVault,
    HostedProviderVerifier,
    ProductionGcpAdcVerifier,
    InMemoryProviderReceiptRegistry,
    HostedProviderAuthority,
>;

/// Feature facade; neither ConnectionManager nor managed DB leases participate.
#[derive(Clone)]
pub(crate) struct ProvidersFeature {
    application: ComposedProviderApplication,
    local_connection: ProviderLocalResolver,
    revocation: ProviderBindingRevocationHandle,
}

pub(crate) fn compose(store: Store) -> ProvidersFeature {
    let repository = SqliteProviderBindingRepository::new(store);
    let vault = KeyringProviderCredentialVault::default();
    let verifier = HostedProviderVerifier::new();
    let authority = HostedProviderAuthority::new();
    let revocation = ProviderBindingRevocationHandle::default();
    ProvidersFeature {
        application: ProviderUseCases::new(
            repository.clone(),
            vault.clone(),
            verifier,
            ProductionGcpAdcVerifier,
            InMemoryProviderReceiptRegistry::default(),
            authority,
            std::sync::Arc::new(revocation.clone()),
        ),
        local_connection: ProviderLocalResolver::new(repository, vault),
        revocation,
    }
}

impl ProvidersFeature {
    /// The sole provider-local port shared with the connection runtime.
    ///
    /// Cloning the facade retains the same repository/vault owner; composing a
    /// second feature would create independent receipt and cache lifecycles.
    pub(crate) fn local_connection_port(
        &self,
    ) -> std::sync::Arc<dyn crate::connection::ProviderLocalConnectionPort> {
        std::sync::Arc::new(self.local_connection.clone())
    }

    /// Bind the one runtime-owned cache fence after the provider-local resolver
    /// has been injected into that runtime.  The application sees only the
    /// explicit port and cannot name `ConnectionManager`.
    pub(crate) fn bind_revocation_port(
        &self,
        port: std::sync::Arc<dyn ProviderBindingRevocationPort>,
    ) -> crate::error::AppResult<()> {
        self.revocation.bind(port)
    }

    pub(crate) async fn list_integrations(
        &self,
    ) -> crate::error::AppResult<Vec<ProviderIntegrationSummary>> {
        self.application.list_integrations().await
    }

    pub(crate) async fn list_bindings(
        &self,
    ) -> crate::error::AppResult<Vec<ProviderBindingStatus>> {
        self.application.list_bindings().await
    }

    pub(crate) async fn begin(
        &self,
        integration_id: crate::kernel::identity::ProviderIntegrationId,
        material: ProviderCredentialMaterial,
    ) -> crate::error::AppResult<ProviderCredentialReceipt> {
        self.application.begin(integration_id, material).await
    }

    pub(crate) async fn verify(
        &self,
        request: VerifyProviderCredential,
    ) -> crate::error::AppResult<ProviderBindingStatus> {
        self.application.verify(request).await
    }

    pub(crate) async fn revoke(
        &self,
        request: RevokeProviderCredential,
    ) -> crate::error::AppResult<()> {
        self.application.revoke(request).await
    }

    pub(crate) async fn reconcile_grants(
        &self,
        grants: &[(
            crate::kernel::identity::AccountId,
            crate::kernel::identity::WorkspaceId,
        )],
    ) -> crate::error::AppResult<()> {
        self.application.reconcile_grants(grants).await
    }

    /// Tombstone local credentials before the workspace service clears the
    /// matching authenticated account. OS-store deletion remains queued.
    pub(crate) async fn sign_out(
        &self,
        account_id: Option<&crate::kernel::identity::AccountId>,
    ) -> crate::error::AppResult<()> {
        self.application.sign_out(account_id).await
    }

    /// Scope switches/sign-out clear memory capabilities and staged credentials.
    pub(crate) async fn invalidate_scope(&self) -> crate::error::AppResult<()> {
        self.application.invalidate_scope().await
    }
}
