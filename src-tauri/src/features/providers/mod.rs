//! Member-local provider credential vertical slice.

mod adapters;
mod application;
mod domain;
pub(crate) mod ports;
pub(crate) mod provisioning;
pub(crate) mod transport;

use crate::operations::OperationRuntime;
use crate::store::Store;

use adapters::{
    HostedProviderAuthority, HostedProviderVerifier, HostedProvisioningTargetAuthority,
    InMemoryProviderReceiptRegistry, KeyringProviderCredentialVault, ProductionGcpAdcVerifier,
    ProviderLocalResolver, SqliteProviderBindingRepository,
};
use application::ProviderUseCases;
use ports::{
    ProviderBindingRevocationHandle, ProviderBindingRevocationPort, ProvisioningRuntimeHandle,
    ProvisioningRuntimePort,
};
use provisioning::{
    managed_provider_registry, GcpCloudSqlProvisioningDriver, NeonProvisioningDriver,
    PlanetScaleProvisioningDriver, ProvisioningCoordinator,
};

pub(crate) use domain::{
    LocalProvider, ProviderBindingStatus, ProviderCredentialMaterial, ProviderCredentialReceipt,
    ProviderIntegrationSummary, RevokeProviderCredential, VerifyProviderCredential,
};
pub(crate) use provisioning::ProvisioningReceipt;
pub(crate) use provisioning::{
    ProvisioningAccessMode, ProvisioningDriverStatus, ProvisioningPlanProjection,
    ProvisioningTargetSummary,
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
    provisioning_runtime: ProvisioningRuntimeHandle,
    provisioning: ProvisioningCoordinator,
}

pub(crate) fn compose(store: Store, operation: OperationRuntime) -> ProvidersFeature {
    let repository = SqliteProviderBindingRepository::new(store.clone());
    let vault = KeyringProviderCredentialVault::default();
    let verifier = HostedProviderVerifier::new();
    let authority = HostedProviderAuthority::new();
    let revocation = ProviderBindingRevocationHandle::default();
    let provisioning_runtime = ProvisioningRuntimeHandle::default();
    let provisioning_driver = PlanetScaleProvisioningDriver::new(
        store.clone(),
        HostedProvisioningTargetAuthority::new(),
        std::sync::Arc::new(provisioning_runtime.clone()),
    );
    let gcp_provisioning_driver = GcpCloudSqlProvisioningDriver::new(
        store.clone(),
        HostedProvisioningTargetAuthority::new(),
        std::sync::Arc::new(provisioning_runtime.clone()),
    );
    let neon_provisioning_driver = NeonProvisioningDriver::new(
        store.clone(),
        HostedProvisioningTargetAuthority::new(),
        std::sync::Arc::new(provisioning_runtime.clone()),
    );
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
        provisioning_runtime,
        provisioning: ProvisioningCoordinator::new(
            store,
            operation,
            managed_provider_registry(
                provisioning_driver,
                gcp_provisioning_driver,
                neon_provisioning_driver,
            ),
        ),
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

    pub(crate) fn bind_provisioning_runtime(
        &self,
        port: std::sync::Arc<dyn ProvisioningRuntimePort>,
    ) -> crate::error::AppResult<()> {
        self.provisioning_runtime.bind(port)
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

    pub(crate) async fn execute_provisioning(
        &self,
        receipt_id: uuid::Uuid,
    ) -> crate::error::AppResult<ProvisioningReceipt> {
        self.provisioning.execute(receipt_id).await
    }

    pub(crate) async fn provisioning_driver_statuses(
        &self,
    ) -> crate::error::AppResult<Vec<ProvisioningDriverStatus>> {
        self.provisioning.driver_statuses().await
    }

    pub(crate) async fn discover_provisioning_targets(
        &self,
        provider: domain::LocalProvider,
        connection_id: uuid::Uuid,
    ) -> crate::error::AppResult<Vec<ProvisioningTargetSummary>> {
        self.provisioning.discover(provider, connection_id).await
    }

    pub(crate) async fn prepare_provisioning_apply(
        &self,
        discovery_id: uuid::Uuid,
        connection_id: uuid::Uuid,
        access: ProvisioningAccessMode,
    ) -> crate::error::AppResult<ProvisioningPlanProjection> {
        self.provisioning
            .prepare_apply(discovery_id, connection_id, access)
            .await
    }

    pub(crate) async fn provisioning_status(
        &self,
        receipt_id: uuid::Uuid,
    ) -> crate::error::AppResult<ProvisioningPlanProjection> {
        self.provisioning.status(receipt_id).await
    }

    pub(crate) async fn list_provisioning_for_connection(
        &self,
        connection_id: uuid::Uuid,
    ) -> crate::error::AppResult<Vec<ProvisioningPlanProjection>> {
        self.provisioning.list_for_connection(connection_id).await
    }

    pub(crate) async fn prepare_provisioning_destroy(
        &self,
        receipt_id: uuid::Uuid,
    ) -> crate::error::AppResult<ProvisioningPlanProjection> {
        self.provisioning.prepare_destroy(receipt_id).await
    }

    pub(crate) async fn prepare_provisioning_repair(
        &self,
        receipt_id: uuid::Uuid,
    ) -> crate::error::AppResult<ProvisioningPlanProjection> {
        self.provisioning.prepare_repair(receipt_id).await
    }

    pub(crate) async fn reconcile_provisioning(
        &self,
        receipt_id: uuid::Uuid,
    ) -> crate::error::AppResult<ProvisioningPlanProjection> {
        self.provisioning.reconcile(receipt_id).await
    }

    pub(crate) async fn cancel_provisioning(
        &self,
        receipt_id: uuid::Uuid,
    ) -> crate::error::AppResult<()> {
        self.provisioning.cancel(receipt_id).await
    }

    pub(crate) async fn recover_provisioning(
        &self,
        operation_ids: &[uuid::Uuid],
    ) -> crate::error::AppResult<()> {
        self.provisioning
            .recover_previous_runtimes(operation_ids)
            .await
            .map(|_| ())
    }
}
