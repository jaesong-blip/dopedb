//! Tauri boundary for member-local provider credentials.
//!
//! The renderer gets only redacted inventory, binding state, and opaque receipt
//! ids. Device identity and receipt ownership are process-local implementation
//! details; provider family and generation are never renderer-selected inputs.

use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::AppResult;
use crate::kernel::identity::{
    ProviderBindingId, ProviderCredentialReceiptId, ProviderIntegrationId,
};
use crate::state::AppState;

use super::{
    ProviderBindingStatus, ProviderCredentialMaterial, ProviderCredentialReceipt,
    ProviderIntegrationSummary, RevokeProviderCredential, VerifyProviderCredential,
};

/// Only the Neon secret-bearing variant crosses this boundary. GCP is an
/// explicit keyless ADC/WIF request and therefore cannot stage a secret.
pub(crate) enum BeginCredentialInput {
    NeonApiKey { api_key: String },
    GcpAdc,
}

impl<'de> serde::Deserialize<'de> for BeginCredentialInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("credential must be an object"))?;
        let kind = object
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("credential type is required"))?;
        match kind {
            "neonApiKey" if object.len() == 2 => object
                .get("apiKey")
                .and_then(serde_json::Value::as_str)
                .map(|api_key| Self::NeonApiKey {
                    api_key: api_key.into(),
                })
                .ok_or_else(|| serde::de::Error::custom("Neon API key is required")),
            "gcpAdc" if object.len() == 1 => Ok(Self::GcpAdc),
            _ => Err(serde::de::Error::custom(
                "unsupported provider credential input",
            )),
        }
    }
}

#[tauri::command]
pub(crate) async fn list_provider_integrations(
    state: State<'_, AppState>,
) -> AppResult<Vec<ProviderIntegrationSummary>> {
    state.services.providers.list_integrations().await
}

#[tauri::command]
pub(crate) async fn list_provider_credential_bindings(
    state: State<'_, AppState>,
) -> AppResult<Vec<ProviderBindingStatus>> {
    state.services.providers.list_bindings().await
}

#[tauri::command]
pub(crate) async fn begin_provider_credential_binding(
    state: State<'_, AppState>,
    integration_id: Uuid,
    credential: BeginCredentialInput,
) -> AppResult<ProviderCredentialReceipt> {
    let material = match credential {
        BeginCredentialInput::NeonApiKey { api_key } => {
            ProviderCredentialMaterial::NeonApiKey(Zeroizing::new(api_key))
        }
        BeginCredentialInput::GcpAdc => ProviderCredentialMaterial::GcpAdc,
    };
    state
        .services
        .providers
        .begin(ProviderIntegrationId::from(integration_id), material)
        .await
}

#[tauri::command]
pub(crate) async fn verify_provider_credential_binding(
    state: State<'_, AppState>,
    receipt_id: Uuid,
) -> AppResult<ProviderBindingStatus> {
    state
        .services
        .providers
        .verify(VerifyProviderCredential {
            receipt_id: ProviderCredentialReceiptId::from(receipt_id),
        })
        .await
}

#[tauri::command]
pub(crate) async fn revoke_provider_credential_binding(
    state: State<'_, AppState>,
    id: Uuid,
) -> AppResult<()> {
    state
        .services
        .providers
        .revoke(RevokeProviderCredential {
            binding_id: ProviderBindingId::from(id),
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::BeginCredentialInput;
    use crate::features::providers::domain::{
        LocalProvider, ProviderCredentialMethod, ProviderIntegrationState,
        ProviderIntegrationSummary,
    };
    use crate::kernel::identity::ProviderIntegrationId;

    #[test]
    fn begin_wire_is_a_tagged_secret_boundary() {
        let input: BeginCredentialInput =
            serde_json::from_str(r#"{"type":"neonApiKey","apiKey":"secret"}"#).unwrap();
        assert!(matches!(input, BeginCredentialInput::NeonApiKey { .. }));
        assert!(serde_json::from_str::<BeginCredentialInput>(
            r#"{"type":"gcpAdc","serviceAccountJson":"secret"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<BeginCredentialInput>(
            r#"{"type":"planetScale","token":"x"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<BeginCredentialInput>(
            r#"{"kind":"neonApiKey","apiKey":"secret"}"#
        )
        .is_err());
    }

    #[test]
    fn integration_wire_is_the_canonical_redacted_shape() {
        let value = serde_json::to_value(ProviderIntegrationSummary {
            id: ProviderIntegrationId::from(uuid::Uuid::nil()),
            provider: LocalProvider::Neon,
            display_name: "Neon".into(),
            generation: "9007199254740993".into(),
            credential_method: ProviderCredentialMethod::NeonApiKey,
            state: ProviderIntegrationState::Active,
            granted_scope: "projects:0:x".into(),
            verification_target: None,
        })
        .unwrap();
        let object = value.as_object().unwrap();
        for field in [
            "id",
            "provider",
            "displayName",
            "integrationGeneration",
            "credentialMethod",
            "state",
        ] {
            assert!(object.contains_key(field));
        }
        assert!(!object.contains_key("grantedScope"));
        assert_eq!(object["credentialMethod"], "apiKey");
        assert_eq!(object["state"], "credentialsRequired");

        let scope_insufficient =
            serde_json::to_value(ProviderIntegrationState::ScopeInsufficient).unwrap();
        assert_eq!(scope_insufficient, "scopeInsufficient");
    }
}
