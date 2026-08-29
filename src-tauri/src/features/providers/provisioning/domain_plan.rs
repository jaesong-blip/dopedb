//! Pure, secret-free provisioning plan and receipt state machine.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, ProviderIntegrationId};
use crate::model::Engine;
use crate::operations::canonical_hash;

use super::super::super::domain::LocalProvider;

const PLAN_SCHEMA_VERSION: u32 = 1;
const MAX_PLAN_STEPS: usize = 64;
const MAX_SELECTOR_BYTES: usize = 255;
pub(crate) const MAX_AUDIT_ID_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningAccessMode {
    Read,
    Write,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningIntent {
    Apply,
    Destroy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningState {
    NeedsSetup,
    ReadyToApply,
    Applying,
    Verifying,
    Ready,
    NeedsRepair,
    Destroying,
}

impl ProvisioningState {
    pub(crate) const fn storage_key(self) -> &'static str {
        match self {
            Self::NeedsSetup => "needs_setup",
            Self::ReadyToApply => "ready_to_apply",
            Self::Applying => "applying",
            Self::Verifying => "verifying",
            Self::Ready => "ready",
            Self::NeedsRepair => "needs_repair",
            Self::Destroying => "destroying",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningPhase {
    Detect,
    Discover,
    Plan,
    Approve,
    Apply,
    Verify,
    Issue,
    Reconcile,
    Destroy,
}

impl ProvisioningPhase {
    pub(crate) const fn storage_key(self) -> &'static str {
        match self {
            Self::Detect => "detect",
            Self::Discover => "discover",
            Self::Plan => "plan",
            Self::Approve => "approve",
            Self::Apply => "apply",
            Self::Verify => "verify",
            Self::Issue => "issue",
            Self::Reconcile => "reconcile",
            Self::Destroy => "destroy",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningTargetSelector {
    Account,
    Project,
    Region,
    Instance,
    Organization,
    Branch,
    Database,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProvisioningTarget {
    provider: LocalProvider,
    connection_id: ConnectionId,
    connection_revision: i64,
    integration_id: ProviderIntegrationId,
    integration_generation: i64,
    resource_fingerprint: String,
    display_name: String,
    detail: String,
    selectors: BTreeMap<ProvisioningTargetSelector, String>,
    engine: Engine,
    production: bool,
    safe_migrations: Option<bool>,
    write_available: bool,
    provider_audit_id: String,
}

impl ProvisioningTarget {
    #[expect(
        clippy::too_many_arguments,
        reason = "the immutable exact-target constructor names every authority pin explicitly"
    )]
    pub(crate) fn new(
        provider: LocalProvider,
        connection_id: ConnectionId,
        connection_revision: i64,
        integration_id: ProviderIntegrationId,
        integration_generation: i64,
        resource_fingerprint: String,
        display_name: String,
        detail: String,
        selectors: BTreeMap<ProvisioningTargetSelector, String>,
        engine: Engine,
        production: bool,
        safe_migrations: Option<bool>,
        write_available: bool,
        provider_audit_id: String,
    ) -> AppResult<Self> {
        let target = Self {
            provider,
            connection_id,
            connection_revision,
            integration_id,
            integration_generation,
            resource_fingerprint,
            display_name,
            detail,
            selectors,
            engine,
            production,
            safe_migrations,
            write_available,
            provider_audit_id,
        };
        target.validate()?;
        Ok(target)
    }

    pub(crate) const fn provider(&self) -> LocalProvider {
        self.provider
    }

    pub(crate) const fn connection_id(&self) -> ConnectionId {
        self.connection_id
    }

    pub(crate) const fn connection_revision(&self) -> i64 {
        self.connection_revision
    }

    pub(crate) const fn integration_id(&self) -> ProviderIntegrationId {
        self.integration_id
    }

    pub(crate) const fn integration_generation(&self) -> i64 {
        self.integration_generation
    }

    pub(crate) fn resource_fingerprint(&self) -> &str {
        &self.resource_fingerprint
    }

    pub(crate) fn display_name(&self) -> &str {
        &self.display_name
    }

    pub(crate) fn detail(&self) -> &str {
        &self.detail
    }

    pub(crate) const fn engine(&self) -> Engine {
        self.engine
    }

    pub(crate) const fn production(&self) -> bool {
        self.production
    }

    pub(crate) const fn write_available(&self) -> bool {
        self.write_available
    }

    pub(crate) const fn safe_migrations(&self) -> Option<bool> {
        self.safe_migrations
    }

    pub(crate) fn provider_audit_id(&self) -> &str {
        &self.provider_audit_id
    }

    pub(crate) fn selector(&self, selector: ProvisioningTargetSelector) -> Option<&str> {
        self.selectors.get(&selector).map(String::as_str)
    }

    fn validate(&self) -> AppResult<()> {
        if Uuid::from(self.connection_id).is_nil()
            || self.connection_revision < 1
            || Uuid::from(self.integration_id).is_nil()
            || self.integration_generation < 1
            || !is_sha256(&self.resource_fingerprint)
            || !safe_target_label(&self.display_name)
            || !safe_target_label(&self.detail)
            || !safe_audit_id(&self.provider_audit_id)
            || !matches!(self.engine, Engine::Postgres | Engine::Mysql)
            || self.selectors.keys().copied().collect::<BTreeSet<_>>()
                != required_selectors(self.provider)
            || self.selectors.values().any(|value| !safe_selector(value))
        {
            return Err(blocked("provider provisioning target is invalid"));
        }
        if self.provider == LocalProvider::Neon && self.engine != Engine::Postgres {
            return Err(blocked("provider provisioning target engine is invalid"));
        }
        if !matches!(
            (self.provider, self.engine, self.safe_migrations),
            (LocalProvider::PlanetScale, Engine::Mysql, Some(_))
                | (LocalProvider::PlanetScale, Engine::Postgres, None)
                | (LocalProvider::GcpCloudSql, _, None)
                | (LocalProvider::Neon, Engine::Postgres, None)
        ) {
            return Err(blocked("provider provisioning target policy is invalid"));
        }
        Ok(())
    }
}

fn safe_target_label(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_SELECTOR_BYTES && !value.chars().any(char::is_control)
}

fn safe_audit_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_AUDIT_ID_BYTES
        && value.is_ascii()
        && !value.chars().any(char::is_control)
}

fn required_selectors(provider: LocalProvider) -> BTreeSet<ProvisioningTargetSelector> {
    use ProvisioningTargetSelector::{
        Account, Branch, Database, Instance, Organization, Project, Region,
    };
    match provider {
        LocalProvider::GcpCloudSql => {
            BTreeSet::from([Account, Project, Region, Instance, Database])
        }
        LocalProvider::Neon => BTreeSet::from([Account, Project, Branch, Database]),
        LocalProvider::PlanetScale => BTreeSet::from([Account, Organization, Database, Branch]),
    }
}

fn safe_selector(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SELECTOR_BYTES
        && value.is_ascii()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'.' | b'_' | b'-' | b':')
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningAction {
    EnableProviderService,
    CreateProviderIdentity,
    BindProviderRole,
    ConfigureDatabaseAuthentication,
    CreateDatabasePrincipal,
    CreateReadRole,
    CreateWriteRole,
    GrantExistingObjects,
    GrantFutureObjects,
    VerifyProviderTarget,
    VerifyDatabasePolicy,
    SmokeTestReadCredential,
    SmokeTestWriteCredential,
    ReconcileProviderPolicy,
    ReconcileDatabasePolicy,
    RevokeIssuedCredentials,
    RemoveOwnedDatabasePrincipal,
    RemoveOwnedProviderIdentity,
}

impl ProvisioningAction {
    const fn is_destroy(self) -> bool {
        matches!(
            self,
            Self::RevokeIssuedCredentials
                | Self::RemoveOwnedDatabasePrincipal
                | Self::RemoveOwnedProviderIdentity
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProvisioningPlanStep {
    sequence: u16,
    phase: ProvisioningPhase,
    action: ProvisioningAction,
    access: Option<ProvisioningAccessMode>,
    execution_sha256: String,
}

impl ProvisioningPlanStep {
    pub(crate) fn new(
        sequence: u16,
        phase: ProvisioningPhase,
        action: ProvisioningAction,
        access: Option<ProvisioningAccessMode>,
        execution_sha256: String,
    ) -> AppResult<Self> {
        let step = Self {
            sequence,
            phase,
            action,
            access,
            execution_sha256,
        };
        if sequence == 0
            || !matches!(phase, ProvisioningPhase::Apply | ProvisioningPhase::Destroy)
            || !is_sha256(&step.execution_sha256)
        {
            return Err(blocked("provider provisioning step is invalid"));
        }
        Ok(step)
    }

    pub(crate) const fn sequence(&self) -> u16 {
        self.sequence
    }

    pub(crate) const fn action(&self) -> ProvisioningAction {
        self.action
    }

    pub(crate) const fn access(&self) -> Option<ProvisioningAccessMode> {
        self.access
    }

    pub(crate) fn execution_sha256(&self) -> &str {
        &self.execution_sha256
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ManagedAccessCapability {
    Detect,
    Discover,
    Plan,
    Apply,
    Verify,
    Issue,
    Reconcile,
    Destroy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProvisioningCapabilityManifest {
    capabilities: BTreeSet<ManagedAccessCapability>,
}

impl ProvisioningCapabilityManifest {
    pub(crate) fn new(capabilities: impl IntoIterator<Item = ManagedAccessCapability>) -> Self {
        Self {
            capabilities: capabilities.into_iter().collect(),
        }
    }

    pub(crate) fn managed_access_available(&self) -> bool {
        use ManagedAccessCapability::{
            Apply, Destroy, Detect, Discover, Issue, Plan, Reconcile, Verify,
        };
        self.capabilities
            == BTreeSet::from([
                Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
            ])
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProvisioningPlanPayload {
    schema_version: u32,
    adapter_manifest_sha256: String,
    intent: ProvisioningIntent,
    target: ProvisioningTarget,
    access: ProvisioningAccessMode,
    capabilities: ProvisioningCapabilityManifest,
    steps: Vec<ProvisioningPlanStep>,
    ownership_marker: String,
    idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProvisioningPlan {
    payload: ProvisioningPlanPayload,
    payload_sha256: String,
}

impl ProvisioningPlan {
    #[expect(
        clippy::too_many_arguments,
        reason = "the immutable provisioning plan constructor names every approved hash input explicitly"
    )]
    pub(crate) fn new(
        intent: ProvisioningIntent,
        adapter_manifest_sha256: String,
        target: ProvisioningTarget,
        access: ProvisioningAccessMode,
        capabilities: ProvisioningCapabilityManifest,
        steps: Vec<ProvisioningPlanStep>,
        ownership_marker: String,
        idempotency_key: String,
    ) -> AppResult<Self> {
        target.validate()?;
        if steps.is_empty()
            || steps.len() > MAX_PLAN_STEPS
            || !is_sha256(&adapter_manifest_sha256)
            || !valid_ownership_marker(target.provider, &ownership_marker)
            || !safe_idempotency_key(&idempotency_key)
        {
            return Err(blocked("provider provisioning plan is invalid"));
        }
        for (index, step) in steps.iter().enumerate() {
            if usize::from(step.sequence) != index + 1
                || (intent == ProvisioningIntent::Apply && step.action.is_destroy())
                || (intent == ProvisioningIntent::Destroy && !step.action.is_destroy())
                || (intent == ProvisioningIntent::Apply && step.phase != ProvisioningPhase::Apply)
                || (intent == ProvisioningIntent::Destroy
                    && step.phase != ProvisioningPhase::Destroy)
            {
                return Err(blocked("provider provisioning plan is invalid"));
            }
        }
        let payload = ProvisioningPlanPayload {
            schema_version: PLAN_SCHEMA_VERSION,
            adapter_manifest_sha256,
            intent,
            target,
            access,
            capabilities,
            steps,
            ownership_marker,
            idempotency_key,
        };
        let payload_sha256 = canonical_hash(&serde_json::to_value(&payload)?)?;
        Ok(Self {
            payload,
            payload_sha256,
        })
    }

    pub(crate) fn payload_sha256(&self) -> &str {
        &self.payload_sha256
    }

    pub(crate) fn idempotency_key(&self) -> &str {
        &self.payload.idempotency_key
    }

    pub(crate) fn ownership_marker(&self) -> &str {
        &self.payload.ownership_marker
    }

    pub(crate) fn target(&self) -> &ProvisioningTarget {
        &self.payload.target
    }

    pub(crate) fn adapter_manifest_sha256(&self) -> &str {
        &self.payload.adapter_manifest_sha256
    }

    pub(crate) fn steps(&self) -> &[ProvisioningPlanStep] {
        &self.payload.steps
    }

    pub(crate) const fn intent(&self) -> ProvisioningIntent {
        self.payload.intent
    }

    pub(crate) const fn access(&self) -> ProvisioningAccessMode {
        self.payload.access
    }

    pub(crate) fn capabilities(&self) -> &ProvisioningCapabilityManifest {
        &self.payload.capabilities
    }

    pub(crate) fn operation_payload(&self) -> AppResult<serde_json::Value> {
        serde_json::to_value(&self.payload).map_err(Into::into)
    }

    pub(crate) fn from_operation_payload(
        value: serde_json::Value,
        expected_sha256: &str,
    ) -> AppResult<Self> {
        let payload: ProvisioningPlanPayload = serde_json::from_value(value)
            .map_err(|_| AppError::Config("invalid provider provisioning plan".into()))?;
        let plan = Self {
            payload,
            payload_sha256: expected_sha256.to_owned(),
        };
        plan.validate()?;
        Ok(plan)
    }

    pub(crate) fn validate(&self) -> AppResult<()> {
        if !is_sha256(&self.payload_sha256)
            || canonical_hash(&serde_json::to_value(&self.payload)?)? != self.payload_sha256
        {
            return Err(blocked("provider provisioning plan hash is invalid"));
        }
        Self::new(
            self.payload.intent,
            self.payload.adapter_manifest_sha256.clone(),
            self.payload.target.clone(),
            self.payload.access,
            self.payload.capabilities.clone(),
            self.payload.steps.clone(),
            self.payload.ownership_marker.clone(),
            self.payload.idempotency_key.clone(),
        )
        .map(|_| ())
    }
}

pub(crate) fn valid_ownership_marker(provider: LocalProvider, value: &str) -> bool {
    let Some(id) = value.strip_prefix(&format!("dopedb:{}:", provider.storage_key())) else {
        return false;
    };
    Uuid::parse_str(id).is_ok()
}

pub(crate) fn safe_idempotency_key(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) fn safe_account_scope(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
}

pub(crate) fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn blocked(reason: &'static str) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
}
