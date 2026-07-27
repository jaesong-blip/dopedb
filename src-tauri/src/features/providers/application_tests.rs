//! Use-case authority, compensation, and wire tests with injected ports.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{AccountId, ProviderBindingId, ProviderIntegrationId, WorkspaceId};

use super::adapters::InMemoryProviderReceiptRegistry;
use super::application::ProviderUseCases;
use super::domain::{
    LocalProvider, ProviderBindingScope, ProviderBindingStatus, ProviderCredentialCleanup,
    ProviderCredentialMaterial, ProviderIntegrationSummary, ProviderScope, ProviderVerification,
    RedactedProviderPrincipal, TombstonedProviderBinding, VerifyProviderCredential,
};
use super::ports::{
    GcpAdcVerifier, ProviderAuthorityPort, ProviderBindingRepository,
    ProviderBindingRevocationPort, ProviderCredentialVault, ProviderVerifier,
};

#[derive(Clone)]
struct Repository {
    active: ProviderScope,
    fail_commit: bool,
    tombstone: Option<TombstonedProviderBinding>,
}

impl ProviderBindingRepository for Repository {
    async fn active_scope(&self) -> AppResult<ProviderScope> {
        Ok(self.active.clone())
    }
    async fn list(&self) -> AppResult<Vec<ProviderBindingStatus>> {
        Ok(Vec::new())
    }
    async fn commit(
        &self,
        _: &ProviderBindingScope,
        _: ProviderBindingId,
        _: Option<ProviderBindingId>,
        _: &str,
    ) -> AppResult<Option<super::domain::ReplacedProviderCredential>> {
        if self.fail_commit {
            Err(AppError::Io(std::io::Error::other("fixture")))
        } else {
            Ok(None)
        }
    }
    async fn tombstone(
        &self,
        _: ProviderBindingId,
    ) -> AppResult<Option<TombstonedProviderBinding>> {
        Ok(self.tombstone.clone())
    }
    async fn pending_cleanup(&self) -> AppResult<Vec<ProviderCredentialCleanup>> {
        Ok(Vec::new())
    }
    async fn complete_cleanup(&self, _: &ProviderCredentialCleanup) -> AppResult<()> {
        Ok(())
    }
    async fn enqueue_cleanup(&self, _: &ProviderCredentialCleanup) -> AppResult<()> {
        Ok(())
    }
    async fn reconcile_authority(
        &self,
        _: &[ProviderIntegrationSummary],
    ) -> AppResult<Vec<TombstonedProviderBinding>> {
        Ok(self.tombstone.clone().into_iter().collect())
    }
    async fn reconcile_grants(
        &self,
        _: &[(AccountId, WorkspaceId)],
    ) -> AppResult<Vec<TombstonedProviderBinding>> {
        Ok(self.tombstone.clone().into_iter().collect())
    }
    async fn tombstone_account(
        &self,
        _: Option<&AccountId>,
    ) -> AppResult<Vec<TombstonedProviderBinding>> {
        Ok(self.tombstone.clone().into_iter().collect())
    }
}

#[derive(Clone, Default)]
struct Vault(Arc<Mutex<HashMap<ProviderBindingId, Zeroizing<String>>>>);
impl ProviderCredentialVault for Vault {
    fn store(
        &self,
        _: &ProviderBindingScope,
        id: ProviderBindingId,
        secret: &str,
    ) -> AppResult<()> {
        self.0
            .lock()
            .unwrap()
            .insert(id, Zeroizing::new(secret.into()));
        Ok(())
    }
    fn fetch(
        &self,
        _: &ProviderBindingScope,
        id: ProviderBindingId,
    ) -> AppResult<Zeroizing<String>> {
        self.0
            .lock()
            .unwrap()
            .get(&id)
            .map(|value| Zeroizing::new(value.to_string()))
            .ok_or_else(|| AppError::NotFound("fixture".into()))
    }
    fn delete(&self, cleanup: &ProviderCredentialCleanup) -> AppResult<()> {
        self.0.lock().unwrap().remove(&cleanup.keyring_ref);
        Ok(())
    }
    fn clear_scope(&self, _: Option<&ProviderScope>) {
        self.0.lock().unwrap().clear();
    }
}

#[derive(Clone)]
struct Verifier;
impl ProviderVerifier for Verifier {
    async fn verify(
        &self,
        _: &ProviderBindingScope,
        _: Zeroizing<String>,
    ) -> AppResult<ProviderVerification> {
        Ok(ProviderVerification::Verified(RedactedProviderPrincipal {
            display: "redacted fixture principal".into(),
        }))
    }
}
#[derive(Clone)]
struct GcpVerifier;
impl GcpAdcVerifier for GcpVerifier {
    async fn verify_adc(&self, _: &ProviderBindingScope) -> AppResult<ProviderVerification> {
        Ok(ProviderVerification::Verified(RedactedProviderPrincipal {
            display: "GCP ADC fixture".into(),
        }))
    }
}

#[derive(Clone)]
struct Authority {
    binding: ProviderBindingScope,
}
impl ProviderAuthorityPort for Authority {
    async fn list_integrations(
        &self,
        _: &ProviderScope,
    ) -> AppResult<Vec<ProviderIntegrationSummary>> {
        Ok(Vec::new())
    }
    async fn revalidate(
        &self,
        _: &ProviderScope,
        integration: ProviderIntegrationId,
    ) -> AppResult<ProviderBindingScope> {
        if integration == self.binding.integration_id {
            Ok(self.binding.clone())
        } else {
            Err(AppError::Blocked {
                reason: "stale provider integration".into(),
            })
        }
    }
}

#[derive(Clone)]
struct NoopFence;

impl ProviderBindingRevocationPort for NoopFence {
    fn force_fence<'a>(
        &'a self,
        _: ProviderBindingId,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Clone, Default)]
struct RecordingFence(Arc<Mutex<Vec<ProviderBindingId>>>);

impl ProviderBindingRevocationPort for RecordingFence {
    fn force_fence<'a>(
        &'a self,
        binding_id: ProviderBindingId,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
        self.0.lock().unwrap().push(binding_id);
        Box::pin(async { Ok(()) })
    }
}

fn scope() -> ProviderScope {
    ProviderScope {
        workspace_id: WorkspaceId::from(uuid::Uuid::new_v4()),
        account_id: AccountId::new("member-fixture").unwrap(),
        scope_generation: 1,
    }
}
fn binding(scope: ProviderScope) -> ProviderBindingScope {
    ProviderBindingScope {
        scope,
        provider: LocalProvider::Neon,
        integration_id: ProviderIntegrationId::from(uuid::Uuid::new_v4()),
        integration_generation: "9007199254740993".into(),
        granted_scope: "projects:1:fixture".into(),
        verification_target: None,
    }
}

#[tokio::test]
async fn commit_failure_deletes_unpublished_staged_credential() {
    let active = scope();
    let binding = binding(active.clone());
    let vault = Vault::default();
    let app = ProviderUseCases::new(
        Repository {
            active,
            fail_commit: true,
            tombstone: None,
        },
        vault.clone(),
        Verifier,
        GcpVerifier,
        InMemoryProviderReceiptRegistry::default(),
        Authority {
            binding: binding.clone(),
        },
        Arc::new(NoopFence),
    );
    let receipt = app
        .begin(
            binding.integration_id,
            ProviderCredentialMaterial::NeonApiKey(Zeroizing::new("fixture-secret".into())),
        )
        .await
        .unwrap();
    assert!(app
        .verify(VerifyProviderCredential {
            receipt_id: receipt.receipt_id
        })
        .await
        .is_err());
    assert!(vault.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn stale_control_plane_integration_cannot_stage_or_verify() {
    let active = scope();
    let binding = binding(active.clone());
    let vault = Vault::default();
    let app = ProviderUseCases::new(
        Repository {
            active,
            fail_commit: false,
            tombstone: None,
        },
        vault.clone(),
        Verifier,
        GcpVerifier,
        InMemoryProviderReceiptRegistry::default(),
        Authority {
            binding: binding.clone(),
        },
        Arc::new(NoopFence),
    );
    assert!(app
        .begin(
            ProviderIntegrationId::from(uuid::Uuid::new_v4()),
            ProviderCredentialMaterial::NeonApiKey(Zeroizing::new("fixture".into()))
        )
        .await
        .is_err());
    let receipt = app
        .begin(
            binding.integration_id,
            ProviderCredentialMaterial::NeonApiKey(Zeroizing::new("fixture".into())),
        )
        .await
        .unwrap();
    app.invalidate_scope().await.unwrap();
    assert!(app
        .verify(VerifyProviderCredential {
            receipt_id: receipt.receipt_id
        })
        .await
        .is_err());
    assert!(vault.0.lock().unwrap().is_empty());
}

#[test]
fn receipt_and_binding_wire_are_secret_free_and_exact() {
    let receipt = super::domain::ProviderCredentialReceipt {
        receipt_id: crate::kernel::identity::ProviderCredentialReceiptId::from(uuid::Uuid::nil()),
        expires_at: Utc::now(),
    };
    let json = serde_json::to_value(receipt).unwrap();
    assert_eq!(
        json.as_object().unwrap().keys().collect::<Vec<_>>(),
        vec!["receiptId", "expiresAt"]
    );
    let schema = crate::store::TEST_SCHEMA.to_ascii_lowercase();
    assert!(schema.contains("keyring_ref"));
    assert!(!schema.contains("access_token"));
    assert!(!schema.contains("private_key"));
}

#[tokio::test]
async fn gcp_adc_never_stages_a_keyring_secret() {
    let active = scope();
    let mut binding = binding(active.clone());
    binding.provider = LocalProvider::GcpCloudSql;
    let vault = Vault::default();
    let app = ProviderUseCases::new(
        Repository {
            active,
            fail_commit: false,
            tombstone: None,
        },
        vault.clone(),
        Verifier,
        GcpVerifier,
        InMemoryProviderReceiptRegistry::default(),
        Authority {
            binding: binding.clone(),
        },
        Arc::new(NoopFence),
    );
    let receipt = app
        .begin(binding.integration_id, ProviderCredentialMaterial::GcpAdc)
        .await
        .unwrap();
    assert!(vault.0.lock().unwrap().is_empty());
    let result = app
        .verify(VerifyProviderCredential {
            receipt_id: receipt.receipt_id,
        })
        .await
        .unwrap();
    assert_eq!(result.provider, LocalProvider::GcpCloudSql);
    assert!(vault.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn tombstone_fences_the_exact_runtime_binding_before_keyring_cleanup() {
    let active = scope();
    let binding = binding(active.clone());
    let binding_id = ProviderBindingId::from(uuid::Uuid::new_v4());
    let cleanup = ProviderCredentialCleanup {
        scope: binding.scope.clone(),
        provider: LocalProvider::Neon,
        integration_id: binding.integration_id,
        integration_generation: binding.integration_generation.clone(),
        binding_id,
        keyring_ref: binding_id,
    };
    let fence = RecordingFence::default();
    let app = ProviderUseCases::new(
        Repository {
            active,
            fail_commit: false,
            tombstone: Some(TombstonedProviderBinding {
                binding_id,
                cleanup: Some(cleanup),
            }),
        },
        Vault::default(),
        Verifier,
        GcpVerifier,
        InMemoryProviderReceiptRegistry::default(),
        Authority { binding },
        Arc::new(fence.clone()),
    );

    app.revoke(super::domain::RevokeProviderCredential { binding_id })
        .await
        .expect("tombstone cleanup succeeds in this fixture");
    assert_eq!(*fence.0.lock().unwrap(), vec![binding_id]);
}

#[tokio::test]
async fn keyless_binding_tombstone_still_fences_its_runtime_pool() {
    let active = scope();
    let mut binding = binding(active.clone());
    binding.provider = LocalProvider::GcpCloudSql;
    let binding_id = ProviderBindingId::from(uuid::Uuid::new_v4());
    let fence = RecordingFence::default();
    let app = ProviderUseCases::new(
        Repository {
            active,
            fail_commit: false,
            tombstone: Some(TombstonedProviderBinding {
                binding_id,
                cleanup: None,
            }),
        },
        Vault::default(),
        Verifier,
        GcpVerifier,
        InMemoryProviderReceiptRegistry::default(),
        Authority { binding },
        Arc::new(fence.clone()),
    );

    app.revoke(super::domain::RevokeProviderCredential { binding_id })
        .await
        .expect("keyless tombstone has no OS cleanup to block the fence");
    assert_eq!(*fence.0.lock().unwrap(), vec![binding_id]);
}

#[tokio::test]
async fn hosted_reconcile_tombstone_routes_the_exact_binding_to_the_runtime_fence() {
    let active = scope();
    let binding = binding(active.clone());
    let binding_id = ProviderBindingId::from(uuid::Uuid::new_v4());
    let fence = RecordingFence::default();
    let app = ProviderUseCases::new(
        Repository {
            active,
            fail_commit: false,
            tombstone: Some(TombstonedProviderBinding {
                binding_id,
                cleanup: None,
            }),
        },
        Vault::default(),
        Verifier,
        GcpVerifier,
        InMemoryProviderReceiptRegistry::default(),
        Authority { binding },
        Arc::new(fence.clone()),
    );

    app.list_integrations().await.unwrap();
    assert_eq!(*fence.0.lock().unwrap(), vec![binding_id]);
}

#[tokio::test]
async fn grant_reconcile_and_sign_out_fence_every_committed_tombstone() {
    let active = scope();
    let binding = binding(active.clone());
    let binding_id = ProviderBindingId::from(uuid::Uuid::new_v4());
    let fence = RecordingFence::default();
    let app = ProviderUseCases::new(
        Repository {
            active: active.clone(),
            fail_commit: false,
            tombstone: Some(TombstonedProviderBinding {
                binding_id,
                cleanup: None,
            }),
        },
        Vault::default(),
        Verifier,
        GcpVerifier,
        InMemoryProviderReceiptRegistry::default(),
        Authority { binding },
        Arc::new(fence.clone()),
    );

    app.reconcile_grants(&[(active.account_id.clone(), active.workspace_id)])
        .await
        .unwrap();
    app.sign_out(Some(&active.account_id)).await.unwrap();
    assert_eq!(*fence.0.lock().unwrap(), vec![binding_id, binding_id]);
}

#[test]
fn binding_wire_uses_id_and_provider_neutral_state_only() {
    let status = ProviderBindingStatus {
        binding_id: ProviderBindingId::from(uuid::Uuid::nil()),
        provider: LocalProvider::Neon,
        integration_id: ProviderIntegrationId::from(uuid::Uuid::nil()),
        integration_generation: "9007199254740993".into(),
        state: super::domain::ProviderBindingState::DeletionPending,
        updated_at: Utc::now(),
    };
    let object = serde_json::to_value(status).unwrap();
    let object = object.as_object().unwrap();
    for name in [
        "id",
        "integrationId",
        "provider",
        "integrationGeneration",
        "state",
        "updatedAt",
    ] {
        assert!(object.contains_key(name));
    }
    assert!(!object.contains_key("bindingId"));
    assert!(!object.contains_key("principal"));
}
