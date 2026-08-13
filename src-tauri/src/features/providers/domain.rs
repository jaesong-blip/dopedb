//! Pure contracts for member-local hosted-provider credentials.
//!
//! Secrets never appear in these values. They are accepted only by transport,
//! immediately wrapped in `Zeroizing`, and live in the credential vault.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::kernel::identity::{
    AccountId, ProviderBindingId, ProviderCredentialReceiptId, ProviderIntegrationId, WorkspaceId,
};

/// Hosted provider family with deliberately separate local capability rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LocalProvider {
    Neon,
    GcpCloudSql,
    PlanetScale,
}

/// Hosted integration credential method. This is capability metadata, not a
/// credential or raw provider response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderCredentialMethod {
    #[serde(rename = "adcWif")]
    GcpAdcWif,
    Unsupported,
}

/// Hosted integration lifecycle, deliberately distinct from local binding
/// state so a stale or revoked server grant cannot look locally ready.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderIntegrationState {
    #[serde(rename = "credentialsRequired")]
    Active,
    #[serde(rename = "accessDenied")]
    Revoked,
    #[serde(rename = "unavailable")]
    ReconnectRequired,
    Unsupported,
    #[serde(rename = "ready")]
    Ready,
}

/// Redacted hosted integration inventory safe for the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderIntegrationSummary {
    pub(crate) id: ProviderIntegrationId,
    pub(crate) provider: LocalProvider,
    pub(crate) display_name: String,
    #[serde(rename = "integrationGeneration")]
    pub(crate) generation: String,
    pub(crate) credential_method: ProviderCredentialMethod,
    pub(crate) state: ProviderIntegrationState,
    #[serde(skip_serializing)]
    pub(crate) granted_scope: String,
    #[serde(skip_serializing)]
    pub(crate) verification_target: Option<ProviderVerificationTarget>,
}

impl LocalProvider {
    pub(crate) const fn storage_key(self) -> &'static str {
        match self {
            Self::Neon => "neon",
            Self::GcpCloudSql => "gcp_cloud_sql",
            Self::PlanetScale => "planetscale",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "neon" => Some(Self::Neon),
            "gcpCloudSql" | "gcp_cloud_sql" => Some(Self::GcpCloudSql),
            "planetScale" | "planetscale" => Some(Self::PlanetScale),
            _ => None,
        }
    }
}

/// Exact local scope frozen into a credential receipt and binding mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderScope {
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) account_id: AccountId,
    pub(crate) scope_generation: i64,
}

impl ProviderScope {
    pub(crate) fn fingerprint(&self) -> String {
        format!(
            "provider-scope:v1:{}:{}:{}",
            self.workspace_id, self.account_id, self.scope_generation
        )
    }
}

/// Complete identity for a local provider credential binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderBindingScope {
    pub(crate) scope: ProviderScope,
    pub(crate) provider: LocalProvider,
    pub(crate) integration_id: ProviderIntegrationId,
    /// Decimal string avoids JavaScript number precision loss for cloud bigint versions.
    pub(crate) integration_generation: String,
    /// Hosted grant descriptor, retained only in the process-local receipt.
    pub(crate) granted_scope: String,
    /// Secret-free, process-local exact target receipt. This never reaches the
    /// renderer or SQLite binding persistence.
    pub(crate) verification_target: Option<ProviderVerificationTarget>,
}

/// Provider-specific authority target carried only from a fresh hosted receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProviderVerificationTarget {
    GcpCloudSql(GcpCloudSqlVerificationTarget),
}

/// Exact dedicated Cloud SQL identity, never a credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GcpCloudSqlVerificationTarget {
    pub(crate) project_id: String,
    pub(crate) instance_id: String,
}

/// Durable local keyring cleanup identity. Unlike `ProviderBindingScope`, this
/// value deliberately carries no hosted grant descriptor: cleanup must remain
/// possible after the remote integration has been revoked or removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderCredentialCleanup {
    pub(crate) scope: ProviderScope,
    pub(crate) provider: LocalProvider,
    pub(crate) integration_id: ProviderIntegrationId,
    pub(crate) integration_generation: String,
    pub(crate) binding_id: ProviderBindingId,
    pub(crate) keyring_ref: ProviderBindingId,
}

/// Result of a durable tombstone transition.  Keyless bindings still carry an
/// exact runtime fence even though they have no OS-keyring cleanup work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TombstonedProviderBinding {
    pub(crate) binding_id: ProviderBindingId,
    pub(crate) cleanup: Option<ProviderCredentialCleanup>,
}

/// Provider-neutral public state for a local binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderBindingState {
    Ready,
    Revoked,
    DeletionPending,
    Unavailable,
}

/// Redacted verified identity; it is safe to persist and render.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RedactedProviderPrincipal {
    pub(crate) display: String,
}

/// Capability response intentionally contains no raw provider resource payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderBindingStatus {
    #[serde(rename = "id")]
    pub(crate) binding_id: ProviderBindingId,
    pub(crate) provider: LocalProvider,
    pub(crate) integration_id: ProviderIntegrationId,
    pub(crate) integration_generation: String,
    pub(crate) state: ProviderBindingState,
    pub(crate) updated_at: DateTime<Utc>,
}

/// Previous keyring identity retained only for copy-on-write cleanup. This is
/// not a transport DTO: its generation selects the exact old keyring account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReplacedProviderCredential {
    pub(crate) cleanup: ProviderCredentialCleanup,
}

/// Opaque capability returned after staging a secret in the OS store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCredentialReceipt {
    pub(crate) receipt_id: ProviderCredentialReceiptId,
    pub(crate) expires_at: DateTime<Utc>,
}

/// Input to consume one staged credential receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifyProviderCredential {
    pub(crate) receipt_id: ProviderCredentialReceiptId,
}

/// Local mutation that prevents all future use before deleting its keyring item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RevokeProviderCredential {
    pub(crate) binding_id: ProviderBindingId,
}

/// Secret material exists only inside application control flow; it is neither
/// serializable nor debug-printable.
pub(crate) enum ProviderCredentialMaterial {
    GcpAdc,
}

/// Provider verification outcome, never a provider API response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProviderVerification {
    Verified(RedactedProviderPrincipal),
}
