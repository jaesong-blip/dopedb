//! Pure, secret-free provisioning plan and receipt state machine.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, ProviderIntegrationId, WorkspaceId};
use crate::model::Engine;
use crate::operations::canonical_hash;

use super::super::domain::LocalProvider;

const PLAN_SCHEMA_VERSION: u32 = 1;
const MAX_PLAN_STEPS: usize = 64;
const MAX_SELECTOR_BYTES: usize = 255;
const MAX_AUDIT_ID_BYTES: usize = 512;

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
    pub(super) const fn storage_key(self) -> &'static str {
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
    pub(super) const fn storage_key(self) -> &'static str {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProvisioningVerification {
    provider_verified: bool,
    database_verified: bool,
    credential_smoke_tested: bool,
    provider_audit_id: Option<String>,
    verified_at: DateTime<Utc>,
}

impl ProvisioningVerification {
    pub(crate) fn complete(
        provider_audit_id: Option<String>,
        verified_at: DateTime<Utc>,
    ) -> AppResult<Self> {
        if provider_audit_id.as_deref().is_some_and(|value| {
            value.is_empty()
                || value.len() > MAX_AUDIT_ID_BYTES
                || !value.is_ascii()
                || value.chars().any(char::is_control)
        }) {
            return Err(blocked("provider provisioning audit identity is invalid"));
        }
        Ok(Self {
            provider_verified: true,
            database_verified: true,
            credential_smoke_tested: true,
            provider_audit_id,
            verified_at,
        })
    }

    fn is_complete(&self) -> bool {
        self.provider_verified && self.database_verified && self.credential_smoke_tested
    }

    pub(super) fn provider_audit_id(&self) -> Option<&str> {
        self.provider_audit_id.as_deref()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningRepairReason {
    ApplyFailed,
    ApplyOutcomeUnknown,
    VerificationFailed,
    ProviderDrift,
    DatabaseDrift,
    CredentialSmokeFailed,
    CleanupFailed,
    UserCancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProvisioningReceipt {
    id: Uuid,
    workspace_id: WorkspaceId,
    account_scope: String,
    connection_id: ConnectionId,
    operation_id: Uuid,
    provider: LocalProvider,
    target_fingerprint: String,
    plan_hash: String,
    idempotency_key: String,
    ownership_marker: String,
    capabilities: ProvisioningCapabilityManifest,
    state: ProvisioningState,
    phase: ProvisioningPhase,
    completed_steps: u16,
    verification: Option<ProvisioningVerification>,
    repair_reason: Option<ProvisioningRepairReason>,
    revision: u64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl ProvisioningReceipt {
    pub(crate) fn ready_to_apply(
        workspace_id: WorkspaceId,
        account_scope: String,
        connection_id: ConnectionId,
        operation_id: Uuid,
        plan: &ProvisioningPlan,
        now: DateTime<Utc>,
    ) -> AppResult<Self> {
        plan.validate()?;
        if plan.intent() != ProvisioningIntent::Apply
            || !safe_account_scope(&account_scope)
            || connection_id != plan.target().connection_id()
        {
            return Err(blocked("provider provisioning receipt is invalid"));
        }
        Ok(Self {
            id: Uuid::new_v4(),
            workspace_id,
            account_scope,
            connection_id,
            operation_id,
            provider: plan.target().provider(),
            target_fingerprint: plan.target().resource_fingerprint().to_owned(),
            plan_hash: plan.payload_sha256().to_owned(),
            idempotency_key: plan.idempotency_key().to_owned(),
            ownership_marker: plan.payload.ownership_marker.clone(),
            capabilities: plan.capabilities().clone(),
            state: ProvisioningState::ReadyToApply,
            phase: ProvisioningPhase::Approve,
            completed_steps: 0,
            verification: None,
            repair_reason: None,
            revision: 1,
            created_at: now,
            updated_at: now,
        })
    }

    pub(crate) const fn id(&self) -> Uuid {
        self.id
    }

    pub(super) const fn workspace_id(&self) -> WorkspaceId {
        self.workspace_id
    }

    pub(super) fn account_scope(&self) -> &str {
        &self.account_scope
    }

    pub(super) const fn connection_id(&self) -> ConnectionId {
        self.connection_id
    }

    pub(super) const fn operation_id(&self) -> Uuid {
        self.operation_id
    }

    pub(super) const fn provider(&self) -> LocalProvider {
        self.provider
    }

    pub(super) fn target_fingerprint(&self) -> &str {
        &self.target_fingerprint
    }

    pub(super) fn plan_hash(&self) -> &str {
        &self.plan_hash
    }

    pub(super) fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub(super) fn ownership_marker(&self) -> &str {
        &self.ownership_marker
    }

    pub(crate) const fn state(&self) -> ProvisioningState {
        self.state
    }

    pub(crate) const fn phase(&self) -> ProvisioningPhase {
        self.phase
    }

    pub(crate) const fn completed_steps(&self) -> u16 {
        self.completed_steps
    }

    pub(crate) const fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) const fn repair_reason(&self) -> Option<ProvisioningRepairReason> {
        self.repair_reason
    }

    pub(crate) fn reconcile(
        &mut self,
        verification: ProvisioningVerification,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        if self.state != ProvisioningState::Ready
            || !verification.is_complete()
            || !self.capabilities.managed_access_available()
        {
            return Err(blocked(
                "provider provisioning reconciliation is incomplete",
            ));
        }
        self.verification = Some(verification);
        self.repair_reason = None;
        self.phase = ProvisioningPhase::Issue;
        self.bump(now);
        Ok(())
    }

    pub(crate) fn is_recoverable_execution(&self) -> bool {
        matches!(
            self.state,
            ProvisioningState::Applying
                | ProvisioningState::Verifying
                | ProvisioningState::Destroying
        )
    }

    pub(super) const fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }

    pub(super) const fn updated_at(&self) -> DateTime<Utc> {
        self.updated_at
    }

    pub(super) fn encode_snapshot(&self) -> AppResult<String> {
        self.validate()?;
        serde_json::to_string(self).map_err(Into::into)
    }

    pub(super) fn decode_snapshot(value: &str) -> AppResult<Self> {
        let receipt: Self = serde_json::from_str(value)
            .map_err(|_| AppError::Config("invalid provider provisioning receipt".into()))?;
        receipt.validate()?;
        Ok(receipt)
    }

    pub(crate) fn can_issue(&self) -> bool {
        self.state == ProvisioningState::Ready
            && self.capabilities.managed_access_available()
            && self
                .verification
                .as_ref()
                .is_some_and(|proof| proof.is_complete())
            && self.repair_reason.is_none()
    }

    pub(crate) fn begin_apply(
        &mut self,
        plan: &ProvisioningPlan,
        operation_id: Uuid,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        self.ensure_plan(plan, operation_id)?;
        if self.state != ProvisioningState::ReadyToApply {
            return Err(blocked("provider provisioning is not ready to apply"));
        }
        self.transition(ProvisioningState::Applying, ProvisioningPhase::Apply, now);
        Ok(())
    }

    pub(crate) fn checkpoint(
        &mut self,
        plan: &ProvisioningPlan,
        completed_steps: u16,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        self.ensure_plan(plan, self.operation_id)?;
        if self.state != ProvisioningState::Applying
            || completed_steps <= self.completed_steps
            || usize::from(completed_steps) > plan.steps().len()
        {
            return Err(blocked("provider provisioning checkpoint is invalid"));
        }
        self.completed_steps = completed_steps;
        self.bump(now);
        Ok(())
    }

    pub(crate) fn begin_verification(
        &mut self,
        plan: &ProvisioningPlan,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        self.ensure_plan(plan, self.operation_id)?;
        if self.state != ProvisioningState::Applying
            || usize::from(self.completed_steps) != plan.steps().len()
        {
            return Err(blocked("provider provisioning apply is incomplete"));
        }
        self.transition(ProvisioningState::Verifying, ProvisioningPhase::Verify, now);
        Ok(())
    }

    pub(crate) fn complete_verification(
        &mut self,
        verification: ProvisioningVerification,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        if self.state != ProvisioningState::Verifying
            || !verification.is_complete()
            || !self.capabilities.managed_access_available()
        {
            return Err(blocked("provider provisioning verification is incomplete"));
        }
        self.verification = Some(verification);
        self.repair_reason = None;
        self.transition(ProvisioningState::Ready, ProvisioningPhase::Issue, now);
        Ok(())
    }

    pub(crate) fn needs_repair(
        &mut self,
        reason: ProvisioningRepairReason,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        if self.state == ProvisioningState::NeedsSetup {
            return Err(blocked(
                "provider provisioning cannot enter repair from this state",
            ));
        }
        self.verification = None;
        self.repair_reason = Some(reason);
        self.transition(
            ProvisioningState::NeedsRepair,
            ProvisioningPhase::Reconcile,
            now,
        );
        Ok(())
    }

    pub(crate) fn prepare_repair(
        &mut self,
        plan: &ProvisioningPlan,
        operation_id: Uuid,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        plan.validate()?;
        if self.state != ProvisioningState::NeedsRepair
            || plan.intent() != ProvisioningIntent::Apply
            || plan.target().provider() != self.provider
            || plan.target().resource_fingerprint() != self.target_fingerprint
            || plan.ownership_marker() != self.ownership_marker
            || operation_id == self.operation_id
        {
            return Err(blocked("provider provisioning repair authority is invalid"));
        }
        self.operation_id = operation_id;
        self.plan_hash = plan.payload_sha256().to_owned();
        self.idempotency_key = plan.idempotency_key().to_owned();
        self.capabilities = plan.capabilities().clone();
        self.completed_steps = 0;
        self.verification = None;
        self.repair_reason = None;
        self.transition(
            ProvisioningState::ReadyToApply,
            ProvisioningPhase::Approve,
            now,
        );
        Ok(())
    }

    pub(crate) fn begin_destroy(
        &mut self,
        plan: &ProvisioningPlan,
        operation_id: Uuid,
        observed_ownership_marker: &str,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        plan.validate()?;
        if plan.intent() != ProvisioningIntent::Destroy
            || plan.target().provider() != self.provider
            || plan.target().resource_fingerprint() != self.target_fingerprint
            || plan.payload.ownership_marker != self.ownership_marker
            || plan.payload.ownership_marker != observed_ownership_marker
            || operation_id == self.operation_id
            || !matches!(
                self.state,
                ProvisioningState::Ready | ProvisioningState::NeedsRepair
            )
        {
            return Err(blocked(
                "provider provisioning destroy authority is invalid",
            ));
        }
        self.operation_id = operation_id;
        self.plan_hash = plan.payload_sha256().to_owned();
        self.idempotency_key = plan.idempotency_key().to_owned();
        self.completed_steps = 0;
        self.verification = None;
        self.repair_reason = None;
        self.transition(
            ProvisioningState::Destroying,
            ProvisioningPhase::Destroy,
            now,
        );
        Ok(())
    }

    pub(crate) fn finish_destroy(
        &mut self,
        plan: &ProvisioningPlan,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        self.ensure_plan(plan, self.operation_id)?;
        if self.state != ProvisioningState::Destroying
            || usize::from(self.completed_steps) != plan.steps().len()
        {
            return Err(blocked("provider provisioning destroy is incomplete"));
        }
        self.completed_steps = 0;
        self.verification = None;
        self.repair_reason = None;
        self.transition(
            ProvisioningState::NeedsSetup,
            ProvisioningPhase::Destroy,
            now,
        );
        Ok(())
    }

    pub(crate) fn checkpoint_destroy(
        &mut self,
        plan: &ProvisioningPlan,
        completed_steps: u16,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        self.ensure_plan(plan, self.operation_id)?;
        if self.state != ProvisioningState::Destroying
            || completed_steps <= self.completed_steps
            || usize::from(completed_steps) > plan.steps().len()
        {
            return Err(blocked(
                "provider provisioning destroy checkpoint is invalid",
            ));
        }
        self.completed_steps = completed_steps;
        self.bump(now);
        Ok(())
    }

    pub(crate) fn validate(&self) -> AppResult<()> {
        let structurally_valid = self.revision > 0
            && safe_account_scope(&self.account_scope)
            && is_sha256(&self.target_fingerprint)
            && is_sha256(&self.plan_hash)
            && safe_idempotency_key(&self.idempotency_key)
            && valid_ownership_marker(self.provider, &self.ownership_marker)
            && self.updated_at >= self.created_at;
        let state_valid = match self.state {
            ProvisioningState::NeedsSetup => {
                self.completed_steps == 0
                    && self.verification.is_none()
                    && self.repair_reason.is_none()
                    && !self.can_issue()
            }
            ProvisioningState::ReadyToApply => {
                self.phase == ProvisioningPhase::Approve
                    && self.completed_steps == 0
                    && self.verification.is_none()
            }
            ProvisioningState::Applying => {
                self.phase == ProvisioningPhase::Apply && self.verification.is_none()
            }
            ProvisioningState::Verifying => {
                self.phase == ProvisioningPhase::Verify && self.verification.is_none()
            }
            ProvisioningState::Ready => self.phase == ProvisioningPhase::Issue && self.can_issue(),
            ProvisioningState::NeedsRepair => {
                self.phase == ProvisioningPhase::Reconcile
                    && self.repair_reason.is_some()
                    && !self.can_issue()
            }
            ProvisioningState::Destroying => {
                self.phase == ProvisioningPhase::Destroy
                    && self.verification.is_none()
                    && self.repair_reason.is_none()
            }
        };
        if structurally_valid && state_valid {
            Ok(())
        } else {
            Err(blocked("provider provisioning receipt is invalid"))
        }
    }

    fn ensure_plan(&self, plan: &ProvisioningPlan, operation_id: Uuid) -> AppResult<()> {
        plan.validate()?;
        if operation_id != self.operation_id
            || plan.payload_sha256() != self.plan_hash
            || plan.idempotency_key() != self.idempotency_key
            || plan.target().provider() != self.provider
            || plan.target().resource_fingerprint() != self.target_fingerprint
            || plan.payload.ownership_marker != self.ownership_marker
        {
            return Err(blocked("provider provisioning plan authority changed"));
        }
        Ok(())
    }

    fn transition(
        &mut self,
        state: ProvisioningState,
        phase: ProvisioningPhase,
        now: DateTime<Utc>,
    ) {
        self.state = state;
        self.phase = phase;
        self.bump(now);
    }

    fn bump(&mut self, now: DateTime<Utc>) {
        self.revision = self.revision.saturating_add(1);
        self.updated_at = now;
    }
}

fn valid_ownership_marker(provider: LocalProvider, value: &str) -> bool {
    let Some(id) = value.strip_prefix(&format!("dopedb:{}:", provider.storage_key())) else {
        return false;
    };
    Uuid::parse_str(id).is_ok()
}

fn safe_idempotency_key(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn safe_account_scope(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn blocked(reason: &'static str) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
}

#[cfg(test)]
pub(super) fn fixture_plan(
    intent: ProvisioningIntent,
    capabilities: ProvisioningCapabilityManifest,
) -> ProvisioningPlan {
    use ProvisioningTargetSelector::{Account, Database, Instance, Project, Region};

    let target = ProvisioningTarget::new(
        LocalProvider::GcpCloudSql,
        ConnectionId::from(Uuid::from_u128(10)),
        3,
        ProviderIntegrationId::from(Uuid::from_u128(20)),
        4,
        "ab".repeat(32),
        "fixture-instance / app".into(),
        "sample-project-123 · asia-northeast3".into(),
        BTreeMap::from([
            (Account, "owner@example.com".into()),
            (Project, "sample-project-123".into()),
            (Region, "asia-northeast3".into()),
            (Instance, "fixture-instance".into()),
            (Database, "app".into()),
        ]),
        Engine::Postgres,
        true,
        None,
        true,
        "instance-fixture-123".into(),
    )
    .unwrap();
    let (phase, actions) = match intent {
        ProvisioningIntent::Apply => (
            ProvisioningPhase::Apply,
            [
                ProvisioningAction::CreateProviderIdentity,
                ProvisioningAction::GrantExistingObjects,
            ],
        ),
        ProvisioningIntent::Destroy => (
            ProvisioningPhase::Destroy,
            [
                ProvisioningAction::RevokeIssuedCredentials,
                ProvisioningAction::RemoveOwnedProviderIdentity,
            ],
        ),
    };
    let steps = actions
        .into_iter()
        .enumerate()
        .map(|(index, action)| {
            ProvisioningPlanStep::new(
                u16::try_from(index + 1).unwrap(),
                phase,
                action,
                Some(ProvisioningAccessMode::Read),
                format!("{:02x}", index + 1).repeat(32),
            )
            .unwrap()
        })
        .collect();
    let marker = format!(
        "dopedb:{}:{}",
        LocalProvider::GcpCloudSql.storage_key(),
        Uuid::from_u128(21)
    );
    ProvisioningPlan::new(
        intent,
        "cd".repeat(32),
        target,
        ProvisioningAccessMode::Read,
        capabilities,
        steps,
        marker,
        match intent {
            ProvisioningIntent::Apply => "fixture_apply_0001",
            ProvisioningIntent::Destroy => "fixture_destroy_01",
        }
        .into(),
    )
    .unwrap()
}

#[cfg(test)]
pub(super) fn fixture_repair_plan(
    capabilities: ProvisioningCapabilityManifest,
) -> ProvisioningPlan {
    let original = fixture_plan(ProvisioningIntent::Apply, capabilities.clone());
    ProvisioningPlan::new(
        ProvisioningIntent::Apply,
        original.adapter_manifest_sha256().into(),
        original.target().clone(),
        original.access(),
        capabilities,
        original.steps().to_vec(),
        original.ownership_marker().into(),
        "fixture_repair_0001".into(),
    )
    .unwrap()
}

#[cfg(test)]
pub(crate) fn assert_mock_provider_lifecycle() {
    use ManagedAccessCapability::{
        Apply, Destroy, Detect, Discover, Issue, Plan, Reconcile, Verify,
    };

    let full = ProvisioningCapabilityManifest::new([
        Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
    ]);
    let apply = fixture_plan(ProvisioningIntent::Apply, full.clone());
    let operation_id = Uuid::from_u128(22);
    let started = Utc::now();
    assert!(ProvisioningReceipt::ready_to_apply(
        WorkspaceId::from(Uuid::from_u128(1)),
        "fixture-account".into(),
        ConnectionId::from(Uuid::from_u128(999)),
        operation_id,
        &apply,
        started,
    )
    .is_err());
    let mut receipt = ProvisioningReceipt::ready_to_apply(
        WorkspaceId::from(Uuid::from_u128(1)),
        "fixture-account".into(),
        apply.target().connection_id(),
        operation_id,
        &apply,
        started,
    )
    .unwrap();
    assert!(!receipt.can_issue());
    assert!(receipt
        .begin_apply(&apply, Uuid::from_u128(999), started)
        .is_err());
    receipt.begin_apply(&apply, operation_id, started).unwrap();
    receipt.checkpoint(&apply, 1, started).unwrap();
    assert!(receipt.checkpoint(&apply, 1, started).is_err());
    receipt.checkpoint(&apply, 2, started).unwrap();
    receipt.begin_verification(&apply, started).unwrap();
    receipt
        .complete_verification(
            ProvisioningVerification::complete(Some("provider-audit-1".into()), started).unwrap(),
            started,
        )
        .unwrap();
    assert!(receipt.can_issue());
    receipt
        .needs_repair(ProvisioningRepairReason::ProviderDrift, started)
        .unwrap();
    assert!(!receipt.can_issue());

    let destroy = fixture_plan(ProvisioningIntent::Destroy, full);
    assert!(receipt
        .begin_destroy(
            &destroy,
            Uuid::from_u128(24),
            "dopedb:gcp_cloud_sql:not-the-owned-id",
            started,
        )
        .is_err());
    let marker = destroy.payload.ownership_marker.clone();
    receipt
        .begin_destroy(&destroy, Uuid::from_u128(24), &marker, started)
        .unwrap();
    receipt.checkpoint_destroy(&destroy, 1, started).unwrap();
    receipt.checkpoint_destroy(&destroy, 2, started).unwrap();
    receipt.finish_destroy(&destroy, started).unwrap();
    assert_eq!(receipt.state(), ProvisioningState::NeedsSetup);
    assert!(!receipt.can_issue());

    let incomplete = ProvisioningCapabilityManifest::new([Detect, Discover, Plan, Apply, Verify]);
    let incomplete_plan = fixture_plan(ProvisioningIntent::Apply, incomplete);
    let mut incomplete_receipt = ProvisioningReceipt::ready_to_apply(
        WorkspaceId::from(Uuid::from_u128(1)),
        "fixture-account".into(),
        incomplete_plan.target().connection_id(),
        Uuid::from_u128(26),
        &incomplete_plan,
        started,
    )
    .unwrap();
    incomplete_receipt
        .begin_apply(&incomplete_plan, Uuid::from_u128(26), started)
        .unwrap();
    incomplete_receipt
        .checkpoint(&incomplete_plan, 2, started)
        .unwrap();
    incomplete_receipt
        .begin_verification(&incomplete_plan, started)
        .unwrap();
    assert!(incomplete_receipt
        .complete_verification(
            ProvisioningVerification::complete(None, started).unwrap(),
            started,
        )
        .is_err());
    assert!(!incomplete_receipt.can_issue());
}
