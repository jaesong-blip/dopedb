//! Pure, secret-free provisioning plan and receipt state machine.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, WorkspaceId};

use super::super::super::domain::LocalProvider;

use super::plan::*;

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

    pub(crate) fn provider_audit_id(&self) -> Option<&str> {
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
            ownership_marker: plan.ownership_marker().to_owned(),
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

    pub(crate) const fn workspace_id(&self) -> WorkspaceId {
        self.workspace_id
    }

    pub(crate) fn account_scope(&self) -> &str {
        &self.account_scope
    }

    pub(crate) const fn connection_id(&self) -> ConnectionId {
        self.connection_id
    }

    pub(crate) const fn operation_id(&self) -> Uuid {
        self.operation_id
    }

    pub(crate) const fn provider(&self) -> LocalProvider {
        self.provider
    }

    pub(crate) fn target_fingerprint(&self) -> &str {
        &self.target_fingerprint
    }

    pub(crate) fn plan_hash(&self) -> &str {
        &self.plan_hash
    }

    pub(crate) fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub(crate) fn ownership_marker(&self) -> &str {
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

    pub(crate) const fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }

    pub(crate) const fn updated_at(&self) -> DateTime<Utc> {
        self.updated_at
    }

    pub(crate) fn encode_snapshot(&self) -> AppResult<String> {
        self.validate()?;
        serde_json::to_string(self).map_err(Into::into)
    }

    pub(crate) fn decode_snapshot(value: &str) -> AppResult<Self> {
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

    pub(crate) fn retry_approval(
        &mut self,
        plan: &ProvisioningPlan,
        operation_id: Uuid,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        plan.validate()?;
        if self.state != ProvisioningState::ReadyToApply
            || self.phase != ProvisioningPhase::Approve
            || self.completed_steps != 0
            || self.verification.is_some()
            || self.repair_reason.is_some()
            || operation_id == self.operation_id
            || plan.intent() != ProvisioningIntent::Apply
            || plan.payload_sha256() != self.plan_hash
            || plan.idempotency_key() != self.idempotency_key
            || plan.target().provider() != self.provider
            || plan.target().resource_fingerprint() != self.target_fingerprint
            || plan.ownership_marker() != self.ownership_marker
            || plan.capabilities() != &self.capabilities
        {
            return Err(blocked(
                "provider provisioning approval retry authority is invalid",
            ));
        }
        self.operation_id = operation_id;
        self.bump(now);
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
            || plan.ownership_marker() != self.ownership_marker
            || plan.ownership_marker() != observed_ownership_marker
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
            || plan.ownership_marker() != self.ownership_marker
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
