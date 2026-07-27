//! Focused security tests for provider-local keyring and receipt adapters.

use crate::kernel::identity::{
    AccountId, DeviceId, ProviderBindingId, ProviderIntegrationId, WorkspaceId,
};
use chrono::{Duration, Utc};

use super::super::domain::{LocalProvider, ProviderBindingScope, ProviderScope};
use super::super::ports::ProviderReceiptRegistry;
use super::{InMemoryProviderReceiptRegistry, KeyringProviderCredentialVault};

fn binding() -> ProviderBindingScope {
    ProviderBindingScope {
        scope: ProviderScope {
            workspace_id: WorkspaceId::from(
                uuid::Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap(),
            ),
            account_id: AccountId::new("member-a").unwrap(),
            scope_generation: 7,
        },
        provider: LocalProvider::Neon,
        integration_id: ProviderIntegrationId::from(
            uuid::Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap(),
        ),
        integration_generation: "9007199254740993".into(),
        granted_scope: "projects:1:fixture".into(),
        verification_target: None,
    }
}

#[test]
fn keyring_account_is_versioned_and_complete_scope_isolated() {
    let first = binding();
    let mut second = first.clone();
    second.scope.account_id = AccountId::new("member-b").unwrap();
    let binding_id = ProviderBindingId::from(
        uuid::Uuid::parse_str("33333333-3333-3333-3333-333333333333").unwrap(),
    );
    let first_account = KeyringProviderCredentialVault::account_for_test(&first, binding_id);
    let second_account = KeyringProviderCredentialVault::account_for_test(&second, binding_id);
    assert!(first_account.starts_with("provider-credential:v1:member-a:"));
    assert_ne!(first_account, second_account);
    assert!(!first_account.contains("napi_"));
}

#[test]
fn receipt_is_single_use_owner_bound_and_expires_at_five_minutes() {
    let registry = InMemoryProviderReceiptRegistry::default();
    let now = Utc::now();
    let device =
        DeviceId::from(uuid::Uuid::parse_str("44444444-4444-4444-4444-444444444444").unwrap());
    let staged = ProviderBindingId::from(
        uuid::Uuid::parse_str("55555555-5555-5555-5555-555555555555").unwrap(),
    );
    let receipt = registry.issue(binding(), device, staged, now).unwrap();
    assert_eq!(receipt.expires_at, now + Duration::minutes(5));
    assert!(registry
        .claim(
            receipt.receipt_id,
            DeviceId::from(uuid::Uuid::new_v4()),
            now
        )
        .is_err());
    assert!(registry.claim(receipt.receipt_id, device, now).is_ok());
    assert!(registry.claim(receipt.receipt_id, device, now).is_err());

    let receipt = registry.issue(binding(), device, staged, now).unwrap();
    assert!(registry
        .claim(receipt.receipt_id, device, now + Duration::minutes(5))
        .is_err());
}

#[test]
fn receipt_capacity_is_hard_bound_and_restart_rejects_prior_receipt() {
    let registry = InMemoryProviderReceiptRegistry::default();
    let now = Utc::now();
    let device = DeviceId::from(uuid::Uuid::new_v4());
    for _ in 0..256 {
        registry
            .issue(
                binding(),
                device,
                ProviderBindingId::from(uuid::Uuid::new_v4()),
                now,
            )
            .unwrap();
    }
    assert!(registry
        .issue(
            binding(),
            device,
            ProviderBindingId::from(uuid::Uuid::new_v4()),
            now
        )
        .is_err());

    let registry = InMemoryProviderReceiptRegistry::default();
    let receipt = registry
        .issue(
            binding(),
            device,
            ProviderBindingId::from(uuid::Uuid::new_v4()),
            now,
        )
        .unwrap();
    let restarted = InMemoryProviderReceiptRegistry::default();
    assert!(restarted.claim(receipt.receipt_id, device, now).is_err());
}

#[test]
fn local_provider_tags_keep_planetscale_out_of_local_credential_paths() {
    assert_eq!(LocalProvider::PlanetScale.storage_key(), "planetscale");
    assert_ne!(LocalProvider::PlanetScale, LocalProvider::Neon);
}
