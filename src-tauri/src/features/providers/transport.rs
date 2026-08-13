//! Tauri boundary for member-local provider credentials.
//!
//! The renderer gets only redacted inventory, binding state, and opaque receipt
//! ids. Device identity and receipt ownership are process-local implementation
//! details; provider family and generation are never renderer-selected inputs.

use tauri::State;
use uuid::Uuid;

use crate::error::AppResult;
use crate::kernel::identity::{
    ProviderBindingId, ProviderCredentialReceiptId, ProviderIntegrationId,
};
use crate::state::AppState;

use super::domain::LocalProvider;
use super::{
    ProviderBindingStatus, ProviderCredentialMaterial, ProviderCredentialReceipt,
    ProviderIntegrationSummary, ProvisioningAccessMode, ProvisioningDriverStatus,
    ProvisioningPlanProjection, ProvisioningTargetSummary, RevokeProviderCredential,
    VerifyProviderCredential,
};

/// Only an explicit keyless ADC/WIF request crosses this boundary. Provider
/// API keys stay in the workspace service and never enter Desktop.
pub(crate) enum BeginCredentialInput {
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

#[tauri::command]
pub(crate) async fn execute_provider_provisioning(
    state: State<'_, AppState>,
    receipt_id: Uuid,
) -> AppResult<ProvisioningPlanProjection> {
    state
        .services
        .providers
        .execute_provisioning(receipt_id)
        .await?;
    state
        .services
        .providers
        .provisioning_status(receipt_id)
        .await
}

#[tauri::command]
pub(crate) async fn cancel_provider_provisioning(
    state: State<'_, AppState>,
    receipt_id: Uuid,
) -> AppResult<()> {
    state
        .services
        .providers
        .cancel_provisioning(receipt_id)
        .await
}

#[tauri::command]
pub(crate) async fn list_provider_provisioning_statuses(
    state: State<'_, AppState>,
) -> AppResult<Vec<ProvisioningDriverStatus>> {
    state
        .services
        .providers
        .provisioning_driver_statuses()
        .await
}

#[tauri::command]
pub(crate) async fn discover_provider_provisioning_targets(
    state: State<'_, AppState>,
    provider: LocalProvider,
    connection_id: Uuid,
) -> AppResult<Vec<ProvisioningTargetSummary>> {
    state
        .services
        .providers
        .discover_provisioning_targets(provider, connection_id)
        .await
}

#[tauri::command]
pub(crate) async fn prepare_provider_provisioning(
    state: State<'_, AppState>,
    discovery_id: Uuid,
    connection_id: Uuid,
    access: ProvisioningAccessMode,
) -> AppResult<ProvisioningPlanProjection> {
    state
        .services
        .providers
        .prepare_provisioning_apply(discovery_id, connection_id, access)
        .await
}

#[tauri::command]
pub(crate) async fn get_provider_provisioning_status(
    state: State<'_, AppState>,
    receipt_id: Uuid,
) -> AppResult<ProvisioningPlanProjection> {
    state
        .services
        .providers
        .provisioning_status(receipt_id)
        .await
}

#[tauri::command]
pub(crate) async fn list_provider_provisioning_for_connection(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> AppResult<Vec<ProvisioningPlanProjection>> {
    state
        .services
        .providers
        .list_provisioning_for_connection(connection_id)
        .await
}

#[tauri::command]
pub(crate) async fn prepare_provider_provisioning_destroy(
    state: State<'_, AppState>,
    receipt_id: Uuid,
) -> AppResult<ProvisioningPlanProjection> {
    state
        .services
        .providers
        .prepare_provisioning_destroy(receipt_id)
        .await
}

#[tauri::command]
pub(crate) async fn prepare_provider_provisioning_repair(
    state: State<'_, AppState>,
    receipt_id: Uuid,
) -> AppResult<ProvisioningPlanProjection> {
    state
        .services
        .providers
        .prepare_provisioning_repair(receipt_id)
        .await
}

#[tauri::command]
pub(crate) async fn reconcile_provider_provisioning(
    state: State<'_, AppState>,
    receipt_id: Uuid,
) -> AppResult<ProvisioningPlanProjection> {
    state
        .services
        .providers
        .reconcile_provisioning(receipt_id)
        .await
}
