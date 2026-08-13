//! Concrete provider adapters: hosted authority, SQLite, OS credential storage,
//! process-local receipts, and fail-closed verifier clients.

mod authority;
mod gcp_adc;
mod keychain_vault;
mod local_connection;
mod provisioning_authority;
mod receipt_registry;
mod sqlite_bindings;
mod sqlite_repository;

pub(crate) use authority::HostedProviderAuthority;
pub(crate) use gcp_adc::ProductionGcpAdcVerifier;
pub(crate) use keychain_vault::KeyringProviderCredentialVault;
pub(crate) use local_connection::ProviderLocalResolver;
pub(crate) use provisioning_authority::{
    AuthorizedProvisioningResource, AuthorizedProvisioningTarget,
    HostedProvisioningTargetAuthority, ProvisioningTargetAuthorityPort,
};
pub(crate) use receipt_registry::InMemoryProviderReceiptRegistry;
pub(crate) use sqlite_repository::SqliteProviderBindingRepository;
