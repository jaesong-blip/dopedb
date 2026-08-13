//! Shared, provider-neutral managed-access lifecycle mechanics.
//!
//! Provider drivers own discovery and authority matching. Hashing, plan shape,
//! connection pin validation, ownership, and smoke-step completeness are one
//! contract so the three adapters cannot drift through copied scaffolding.

use std::sync::Arc;

use chrono::Utc;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::providers::adapters::{
    AuthorizedProvisioningTarget, ProvisioningTargetAuthorityPort,
};
use crate::features::providers::ports::ProvisioningRuntimePort;
use crate::model::{Provider, WorkspaceCredentialMode};
use crate::operations::canonical_hash;
use crate::store::PinnedConnection;

use super::super::domain::LocalProvider;
use super::application::{ProvisioningInspection, ProvisioningStepEvidence};
use super::domain::{
    ManagedAccessCapability, ProvisioningAccessMode, ProvisioningAction,
    ProvisioningCapabilityManifest, ProvisioningIntent, ProvisioningPhase, ProvisioningPlan,
    ProvisioningPlanStep, ProvisioningReceipt, ProvisioningRepairReason, ProvisioningTarget,
    ProvisioningTargetSelector, ProvisioningVerification,
};
use super::repository::ProvisioningRepository;
use super::ProvisioningExecutionPermit;

#[derive(Clone, Copy)]
pub(super) struct ManagedProvisioningContract {
    pub(super) local_provider: LocalProvider,
    pub(super) profile_provider: Provider,
    pub(super) manifest_sha256: &'static str,
    pub(super) execution_contract: &'static str,
    pub(super) idempotency_contract: &'static str,
    pub(super) idempotency_prefix: &'static str,
    pub(super) display_name: &'static str,
    pub(super) include_safe_migrations: bool,
}

type TargetMatcher = fn(&ProvisioningTarget, &AuthorizedProvisioningTarget) -> bool;

/// Sealed lifecycle owner shared by every managed provider driver.
///
/// Discovery remains provider-specific, but no adapter can redefine the exact
/// pin, receipt, operation-permit, smoke, or destroy invariants.
#[derive(Clone)]
pub(super) struct ManagedProvisioningScaffold {
    contract: ManagedProvisioningContract,
    repository: ProvisioningRepository,
    target_authority: Arc<dyn ProvisioningTargetAuthorityPort>,
    runtime: Arc<dyn ProvisioningRuntimePort>,
    target_matches: TargetMatcher,
}

impl ManagedProvisioningScaffold {
    pub(super) fn new(
        contract: ManagedProvisioningContract,
        repository: ProvisioningRepository,
        target_authority: Arc<dyn ProvisioningTargetAuthorityPort>,
        runtime: Arc<dyn ProvisioningRuntimePort>,
        target_matches: TargetMatcher,
    ) -> Self {
        Self {
            contract,
            repository,
            target_authority,
            runtime,
            target_matches,
        }
    }

    pub(super) async fn connection_for_discovery(
        &self,
        connection_id: Uuid,
    ) -> AppResult<PinnedConnection> {
        self.repository.pinned_connection(connection_id).await
    }

    pub(super) async fn authorize(
        &self,
        connection: &PinnedConnection,
    ) -> AppResult<AuthorizedProvisioningTarget> {
        self.target_authority.target(connection).await
    }

    async fn pinned_connection(&self, target: &ProvisioningTarget) -> AppResult<PinnedConnection> {
        let connection = self
            .repository
            .pinned_connection(Uuid::from(target.connection_id()))
            .await?;
        validate_connection(self.contract, target, &connection)?;
        Ok(connection)
    }

    async fn cleanup_connection(&self, target: &ProvisioningTarget) -> AppResult<PinnedConnection> {
        let connection = self
            .repository
            .pinned_connection(Uuid::from(target.connection_id()))
            .await?;
        validate_cleanup_connection(self.contract, target, &connection)?;
        Ok(connection)
    }

    async fn target_status(
        &self,
        target: &ProvisioningTarget,
    ) -> AppResult<(PinnedConnection, bool)> {
        let connection = self.pinned_connection(target).await?;
        let authorized = self.authorize(&connection).await?;
        Ok((connection, (self.target_matches)(target, &authorized)))
    }

    async fn revalidate_target(&self, target: &ProvisioningTarget) -> AppResult<PinnedConnection> {
        let (connection, current) = self.target_status(target).await?;
        if !current {
            return Err(self.error("managed target changed"));
        }
        Ok(connection)
    }

    async fn smoke(
        &self,
        target: &ProvisioningTarget,
        access: ProvisioningAccessMode,
    ) -> AppResult<()> {
        self.runtime
            .smoke(
                Uuid::from(target.connection_id()),
                target.connection_revision(),
                self.contract.local_provider,
                target.engine(),
                access,
            )
            .await
    }

    fn build_apply_plan(
        &self,
        target: &ProvisioningTarget,
        access: ProvisioningAccessMode,
        discriminator: &str,
    ) -> AppResult<ProvisioningPlan> {
        if access == ProvisioningAccessMode::Write && !target.write_available() {
            return Err(self.error("managed write access is unavailable"));
        }
        let actions = match access {
            ProvisioningAccessMode::Read => vec![
                (ProvisioningAction::VerifyProviderTarget, None),
                (
                    ProvisioningAction::SmokeTestReadCredential,
                    Some(ProvisioningAccessMode::Read),
                ),
            ],
            ProvisioningAccessMode::Write => vec![
                (ProvisioningAction::VerifyProviderTarget, None),
                (
                    ProvisioningAction::SmokeTestReadCredential,
                    Some(ProvisioningAccessMode::Read),
                ),
                (
                    ProvisioningAction::SmokeTestWriteCredential,
                    Some(ProvisioningAccessMode::Write),
                ),
            ],
        };
        let marker = ownership_marker(self.contract, target);
        ProvisioningPlan::new(
            ProvisioningIntent::Apply,
            self.contract.manifest_sha256.into(),
            target.clone(),
            access,
            full_capabilities(),
            plan_steps(
                self.contract,
                ProvisioningIntent::Apply,
                target,
                access,
                &marker,
                actions,
            )?,
            marker,
            idempotency_key(self.contract, "apply", target, access, discriminator)?,
        )
    }

    fn build_destroy_plan(
        &self,
        target: &ProvisioningTarget,
        access: ProvisioningAccessMode,
        marker: String,
        discriminator: &str,
    ) -> AppResult<ProvisioningPlan> {
        ProvisioningPlan::new(
            ProvisioningIntent::Destroy,
            self.contract.manifest_sha256.into(),
            target.clone(),
            access,
            full_capabilities(),
            plan_steps(
                self.contract,
                ProvisioningIntent::Destroy,
                target,
                access,
                &marker,
                vec![(ProvisioningAction::RevokeIssuedCredentials, None)],
            )?,
            marker,
            idempotency_key(self.contract, "destroy", target, access, discriminator)?,
        )
    }

    pub(super) async fn plan_apply(
        &self,
        target: &ProvisioningTarget,
        connection: &PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningPlan> {
        if cancellation.is_cancelled() {
            return Err(self.error("planning was cancelled"));
        }
        validate_connection(self.contract, target, connection)?;
        let authorized = self.authorize(connection).await?;
        if !(self.target_matches)(target, &authorized) {
            return Err(self.error("target changed before planning"));
        }
        if access == ProvisioningAccessMode::Write && !connection.profile.allow_writes {
            return Err(self.error("connection does not allow writes"));
        }
        self.build_apply_plan(target, access, "initial")
    }

    pub(super) async fn plan_destroy(
        &self,
        receipt: &ProvisioningReceipt,
        target: &ProvisioningTarget,
        connection: &PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &CancellationToken,
    ) -> AppResult<(ProvisioningPlan, String)> {
        if cancellation.is_cancelled() {
            return Err(self.error("destroy planning was cancelled"));
        }
        validate_cleanup_connection(self.contract, target, connection)?;
        if receipt.provider() != self.contract.local_provider
            || receipt.connection_id() != target.connection_id()
            || receipt.target_fingerprint() != target.resource_fingerprint()
            || receipt.ownership_marker() != ownership_marker(self.contract, target)
        {
            return Err(self.error("destroy receipt is invalid"));
        }
        let marker = receipt.ownership_marker().to_owned();
        let plan =
            self.build_destroy_plan(target, access, marker.clone(), &receipt.id().to_string())?;
        Ok((plan, marker))
    }

    pub(super) async fn plan_repair(
        &self,
        receipt: &ProvisioningReceipt,
        target: &ProvisioningTarget,
        connection: &PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningPlan> {
        if cancellation.is_cancelled() {
            return Err(self.error("repair planning was cancelled"));
        }
        validate_connection(self.contract, target, connection)?;
        if receipt.provider() != self.contract.local_provider
            || receipt.ownership_marker() != ownership_marker(self.contract, target)
        {
            return Err(self.error("repair receipt is invalid"));
        }
        let authorized = self.authorize(connection).await?;
        if !(self.target_matches)(target, &authorized) {
            return Err(self.error("target must be rediscovered"));
        }
        self.build_apply_plan(target, access, &receipt.id().to_string())
    }

    pub(super) async fn inspect(
        &self,
        plan: &ProvisioningPlan,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningInspection> {
        if cancellation.is_cancelled() {
            return Err(self.error("inspection was cancelled"));
        }
        let (_, current) = self.target_status(plan.target()).await?;
        if !current {
            return Ok(ProvisioningInspection::Drift(
                ProvisioningRepairReason::ProviderDrift,
            ));
        }
        if self
            .smoke(plan.target(), ProvisioningAccessMode::Read)
            .await
            .is_err()
            || (plan.access() == ProvisioningAccessMode::Write
                && self
                    .smoke(plan.target(), ProvisioningAccessMode::Write)
                    .await
                    .is_err())
        {
            return Ok(ProvisioningInspection::Drift(
                ProvisioningRepairReason::CredentialSmokeFailed,
            ));
        }
        Ok(ProvisioningInspection::Verified(
            ProvisioningVerification::complete(
                Some(plan.target().provider_audit_id().into()),
                Utc::now(),
            )?,
        ))
    }

    pub(super) async fn execute_step(
        &self,
        plan: &ProvisioningPlan,
        step: &ProvisioningPlanStep,
        permit: &ProvisioningExecutionPermit,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningStepEvidence> {
        plan.validate()?;
        let expected = execution_hash(
            self.contract,
            plan.intent(),
            plan.target(),
            plan.access(),
            plan.ownership_marker(),
            step.action(),
            step.access(),
        )?;
        if cancellation.is_cancelled()
            || permit.operation_id.is_nil()
            || permit.provider != self.contract.local_provider
            || permit.plan_sha256 != plan.payload_sha256()
            || permit.execution_sha256 != step.execution_sha256()
            || expected != step.execution_sha256()
        {
            return Err(self.error("execution permit is invalid"));
        }
        match (plan.intent(), step.action(), step.access()) {
            (ProvisioningIntent::Apply, ProvisioningAction::VerifyProviderTarget, None) => {
                self.revalidate_target(plan.target()).await?;
            }
            (
                ProvisioningIntent::Apply,
                ProvisioningAction::SmokeTestReadCredential,
                Some(ProvisioningAccessMode::Read),
            ) => {
                self.smoke(plan.target(), ProvisioningAccessMode::Read)
                    .await?
            }
            (
                ProvisioningIntent::Apply,
                ProvisioningAction::SmokeTestWriteCredential,
                Some(ProvisioningAccessMode::Write),
            ) if plan.access() == ProvisioningAccessMode::Write => {
                self.smoke(plan.target(), ProvisioningAccessMode::Write)
                    .await?;
            }
            (ProvisioningIntent::Destroy, ProvisioningAction::RevokeIssuedCredentials, None) => {
                self.runtime
                    .force_fence(Uuid::from(plan.target().connection_id()))
                    .await?;
                let connection = self.cleanup_connection(plan.target()).await?;
                self.target_authority
                    .destroy(&connection, plan.target(), plan.ownership_marker())
                    .await?;
            }
            _ => return Err(self.error("provisioning action is invalid")),
        }
        if cancellation.is_cancelled() {
            return Err(self.error("provisioning was cancelled"));
        }
        Ok(ProvisioningStepEvidence::exact(step))
    }

    pub(super) async fn verify(
        &self,
        plan: &ProvisioningPlan,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningVerification> {
        if cancellation.is_cancelled()
            || plan.intent() != ProvisioningIntent::Apply
            || !has_complete_smoke_plan(plan)
        {
            return Err(self.error("verification plan is incomplete"));
        }
        self.revalidate_target(plan.target()).await?;
        ProvisioningVerification::complete(
            Some(plan.target().provider_audit_id().into()),
            Utc::now(),
        )
    }

    fn error(&self, reason: &str) -> AppError {
        blocked(format!("{} {reason}", self.contract.display_name))
    }
}

pub(super) fn full_capabilities() -> ProvisioningCapabilityManifest {
    use ManagedAccessCapability::{
        Apply, Destroy, Detect, Discover, Issue, Plan, Reconcile, Verify,
    };
    ProvisioningCapabilityManifest::new([
        Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
    ])
}

pub(super) fn plan_steps(
    contract: ManagedProvisioningContract,
    intent: ProvisioningIntent,
    target: &ProvisioningTarget,
    access: ProvisioningAccessMode,
    ownership_marker: &str,
    actions: Vec<(ProvisioningAction, Option<ProvisioningAccessMode>)>,
) -> AppResult<Vec<ProvisioningPlanStep>> {
    let phase = match intent {
        ProvisioningIntent::Apply => ProvisioningPhase::Apply,
        ProvisioningIntent::Destroy => ProvisioningPhase::Destroy,
    };
    actions
        .into_iter()
        .enumerate()
        .map(|(index, (action, step_access))| {
            ProvisioningPlanStep::new(
                u16::try_from(index + 1).map_err(|_| {
                    blocked(format!(
                        "{} provisioning plan has too many steps",
                        contract.display_name
                    ))
                })?,
                phase,
                action,
                step_access,
                execution_hash(
                    contract,
                    intent,
                    target,
                    access,
                    ownership_marker,
                    action,
                    step_access,
                )?,
            )
        })
        .collect()
}

pub(super) fn execution_hash(
    contract: ManagedProvisioningContract,
    intent: ProvisioningIntent,
    target: &ProvisioningTarget,
    access: ProvisioningAccessMode,
    ownership_marker: &str,
    action: ProvisioningAction,
    step_access: Option<ProvisioningAccessMode>,
) -> AppResult<String> {
    let mut payload = json!({
        "contract": contract.execution_contract,
        "manifestSha256": contract.manifest_sha256,
        "intent": intent,
        "connectionId": Uuid::from(target.connection_id()),
        "connectionRevision": target.connection_revision().to_string(),
        "integrationId": Uuid::from(target.integration_id()),
        "integrationGeneration": target.integration_generation().to_string(),
        "resourceFingerprint": target.resource_fingerprint(),
        "providerAuditId": target.provider_audit_id(),
        "engine": target.engine(),
        "production": target.production(),
        "access": access,
        "action": action,
        "stepAccess": step_access,
        "ownershipMarker": ownership_marker,
    });
    if contract.include_safe_migrations {
        payload["safeMigrations"] = json!(target.safe_migrations());
    }
    canonical_hash(&payload)
}

pub(super) fn idempotency_key(
    contract: ManagedProvisioningContract,
    intent: &str,
    target: &ProvisioningTarget,
    access: ProvisioningAccessMode,
    discriminator: &str,
) -> AppResult<String> {
    let hash = canonical_hash(&json!({
        "contract": contract.idempotency_contract,
        "intent": intent,
        "connectionId": Uuid::from(target.connection_id()),
        "connectionRevision": target.connection_revision().to_string(),
        "integrationGeneration": target.integration_generation().to_string(),
        "resourceFingerprint": target.resource_fingerprint(),
        "access": access,
        "discriminator": discriminator,
    }))?;
    Ok(format!(
        "{}-{intent}-{}",
        contract.idempotency_prefix,
        &hash[..32]
    ))
}

pub(super) fn ownership_marker(
    contract: ManagedProvisioningContract,
    target: &ProvisioningTarget,
) -> String {
    format!(
        "dopedb:{}:{}",
        contract.local_provider.storage_key(),
        Uuid::from(target.connection_id())
    )
}

pub(super) fn validate_connection(
    contract: ManagedProvisioningContract,
    target: &ProvisioningTarget,
    connection: &PinnedConnection,
) -> AppResult<()> {
    validate_connection_revision(contract, target, connection, false)
}

pub(super) fn validate_cleanup_connection(
    contract: ManagedProvisioningContract,
    target: &ProvisioningTarget,
    connection: &PinnedConnection,
) -> AppResult<()> {
    validate_connection_revision(contract, target, connection, true)
}

fn validate_connection_revision(
    contract: ManagedProvisioningContract,
    target: &ProvisioningTarget,
    connection: &PinnedConnection,
    cleanup: bool,
) -> AppResult<()> {
    let valid_revision = if cleanup {
        target.connection_revision() <= connection.connection_revision
    } else {
        target.connection_revision() == connection.connection_revision
    };
    if target.provider() != contract.local_provider
        || Uuid::from(target.connection_id()) != connection.connection_id
        || !valid_revision
        || target.engine() != connection.profile.engine
        || connection.profile.provider != contract.profile_provider
        || connection.profile.credential_mode != WorkspaceCredentialMode::Managed
        || connection.profile.database
            != target
                .selector(ProvisioningTargetSelector::Database)
                .unwrap_or_default()
    {
        let action = if cleanup {
            "cleanup target"
        } else {
            "connection pin"
        };
        return Err(blocked(format!(
            "{} {action} changed",
            contract.display_name
        )));
    }
    Ok(())
}

pub(super) fn has_complete_smoke_plan(plan: &ProvisioningPlan) -> bool {
    let expected = match plan.access() {
        ProvisioningAccessMode::Read => vec![
            (ProvisioningAction::VerifyProviderTarget, None),
            (
                ProvisioningAction::SmokeTestReadCredential,
                Some(ProvisioningAccessMode::Read),
            ),
        ],
        ProvisioningAccessMode::Write => vec![
            (ProvisioningAction::VerifyProviderTarget, None),
            (
                ProvisioningAction::SmokeTestReadCredential,
                Some(ProvisioningAccessMode::Read),
            ),
            (
                ProvisioningAction::SmokeTestWriteCredential,
                Some(ProvisioningAccessMode::Write),
            ),
        ],
    };
    plan.steps()
        .iter()
        .map(|step| (step.action(), step.access()))
        .eq(expected)
}

pub(super) fn blocked(reason: impl Into<String>) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
}
