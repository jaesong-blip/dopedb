//! Concrete provider adapters: hosted authority, SQLite, OS credential storage,
//! process-local receipts, and fail-closed verifier clients.

mod authority;
mod gcp_adc;
mod keychain_vault;
mod local_connection;
#[allow(
    dead_code,
    reason = "the exact managed target port is consumed when #100 registers its first complete driver"
)]
mod provisioning_authority;
mod receipt_registry;
mod sqlite_bindings;
mod sqlite_repository;
mod verifier;

pub(crate) use authority::HostedProviderAuthority;
pub(crate) use gcp_adc::ProductionGcpAdcVerifier;
pub(crate) use keychain_vault::KeyringProviderCredentialVault;
pub(crate) use local_connection::ProviderLocalResolver;
#[allow(
    unused_imports,
    reason = "the exact managed target port is consumed when #100 registers its first complete driver"
)]
pub(crate) use provisioning_authority::{
    AuthorizedProvisioningResource, AuthorizedProvisioningTarget,
    HostedProvisioningTargetAuthority, ProvisioningTargetAuthorityPort,
};
pub(crate) use receipt_registry::InMemoryProviderReceiptRegistry;
pub(crate) use sqlite_repository::SqliteProviderBindingRepository;
pub(crate) use verifier::HostedProviderVerifier;
