//! Provider-neutral orchestration over durable Operations and provisioning receipts.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use dopedb_protocol::{OperationKind, OperationRiskLevel, OperationState};
use serde::Serialize;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::access::{ActiveResourceScope, PinnedConnection};
use crate::model::Engine;
use crate::operations::{
    actor_for_pin, capture_policy, required_confirmation, ClaimedOperation, NewOperation,
    OperationPlanDisposition, OperationRecord, OperationRuntime,
};
#[cfg(test)]
use crate::store::Store;

use super::super::domain::LocalProvider;
use super::domain::{
    ProvisioningAccessMode, ProvisioningAction, ProvisioningIntent, ProvisioningPhase,
    ProvisioningPlan, ProvisioningPlanStep, ProvisioningReceipt, ProvisioningRepairReason,
    ProvisioningState, ProvisioningTarget, ProvisioningVerification,
};
use super::repository::{ProvisioningReceiptRepository, ProvisioningRepository};
use super::{ProvisioningExecutionPermit, ProvisioningReadAuthority};

#[cfg(test)]
#[path = "application_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) use tests::assert_restart_resume_lifecycle;

#[path = "application_execution.rs"]
mod execution;
#[path = "application_model.rs"]
mod model;

pub(super) use model::{
    DriverFuture, ProvisioningDiscoveredTarget, ProvisioningDriver, ProvisioningInspection,
    ProvisioningStepEvidence,
};
pub(crate) use model::{
    ProvisioningDriverRegistry, ProvisioningDriverStatus, ProvisioningPlanProjection,
    ProvisioningPrerequisiteKind, ProvisioningReadiness, ProvisioningTargetSummary,
};
use model::{DISCOVERY_TTL, MAX_DISCOVERED_TARGETS, MAX_PROJECTION_TEXT_BYTES, OPERATION_TTL};

#[derive(Clone)]
struct StagedProvisioningTarget {
    scope: ActiveResourceScope,
    connection_id: Uuid,
    adapter_manifest_sha256: String,
    target: ProvisioningTarget,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ProvisioningRecoveryReport {
    pub(crate) resumed: Vec<Uuid>,
    pub(crate) quarantined: Vec<Uuid>,
}

#[derive(Clone)]
pub(crate) struct ProvisioningCoordinator {
    repository: ProvisioningRepository,
    receipts: ProvisioningReceiptRepository,
    operations: OperationRuntime,
    drivers: ProvisioningDriverRegistry,
    discoveries: Arc<Mutex<HashMap<Uuid, StagedProvisioningTarget>>>,
    cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
}

impl ProvisioningCoordinator {
    pub(crate) fn new(
        repository: ProvisioningRepository,
        operations: OperationRuntime,
        drivers: ProvisioningDriverRegistry,
    ) -> Self {
        Self {
            receipts: ProvisioningReceiptRepository::new(repository.clone()),
            repository,
            operations,
            drivers,
            discoveries: Arc::new(Mutex::new(HashMap::new())),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) async fn driver_statuses(&self) -> AppResult<Vec<ProvisioningDriverStatus>> {
        let cancellation = CancellationToken::new();
        let mut statuses = Vec::new();
        for driver in self.drivers.all() {
            ensure_sha256(driver.manifest_sha256(), "provider adapter manifest")?;
            let authority = ProvisioningReadAuthority::issue(
                driver.provider(),
                driver.manifest_sha256().to_owned(),
            );
            let status = driver.detect(&authority, &cancellation).await?;
            status.validate(driver.provider())?;
            statuses.push(status);
        }
        statuses.sort_by_key(|status| status.provider.storage_key());
        Ok(statuses)
    }

    pub(crate) async fn discover(
        &self,
        provider: LocalProvider,
        connection_id: Uuid,
    ) -> AppResult<Vec<ProvisioningTargetSummary>> {
        if connection_id.is_nil() {
            return Err(blocked("provider provisioning connection is invalid"));
        }
        let scope = self.repository.active_scope().await?;
        let driver = self
            .drivers
            .find(provider)
            .ok_or_else(|| blocked("provider provisioning driver is unavailable"))?;
        ensure_sha256(driver.manifest_sha256(), "provider adapter manifest")?;
        let cancellation = CancellationToken::new();
        let authority = ProvisioningReadAuthority::issue(
            driver.provider(),
            driver.manifest_sha256().to_owned(),
        );
        let status = driver.detect(&authority, &cancellation).await?;
        status.validate(provider)?;
        if status.readiness != ProvisioningReadiness::Ready {
            return Err(blocked("provider prerequisite is not ready"));
        }
        let discovered = driver
            .discover(connection_id, &authority, &cancellation)
            .await?;
        if discovered.len() > MAX_DISCOVERED_TARGETS {
            return Err(blocked("provider discovery returned too many targets"));
        }
        let now = Utc::now();
        let expires_at = now + DISCOVERY_TTL;
        let mut fingerprints = HashSet::new();
        let mut staged = self.discoveries.lock().await;
        staged.retain(|_, target| target.expires_at > now && target.scope == scope);
        let mut summaries = Vec::with_capacity(discovered.len());
        for discovered in discovered {
            if discovered.target.provider() != provider
                || !fingerprints.insert(discovered.target.resource_fingerprint().to_owned())
            {
                return Err(blocked("provider discovery target is invalid"));
            }
            let discovery_id = Uuid::new_v4();
            let summary = ProvisioningTargetSummary {
                discovery_id,
                provider,
                display_name: discovered.target.display_name().into(),
                detail: discovered.target.detail().into(),
                engine: discovered.target.engine(),
                production: discovered.target.production(),
                expires_at,
            };
            staged.insert(
                discovery_id,
                StagedProvisioningTarget {
                    scope: scope.clone(),
                    connection_id,
                    adapter_manifest_sha256: driver.manifest_sha256().to_owned(),
                    target: discovered.target,
                    expires_at,
                },
            );
            summaries.push(summary);
        }
        Ok(summaries)
    }

    pub(crate) async fn prepare_apply(
        &self,
        discovery_id: Uuid,
        connection_id: Uuid,
        access: ProvisioningAccessMode,
    ) -> AppResult<ProvisioningPlanProjection> {
        let scope = self.repository.active_scope().await?;
        let staged = self
            .discoveries
            .lock()
            .await
            .get(&discovery_id)
            .cloned()
            .ok_or_else(|| blocked("provider discovery receipt is unavailable"))?;
        if staged.scope != scope
            || staged.connection_id != connection_id
            || staged.expires_at <= Utc::now()
        {
            return Err(blocked(
                "provider discovery receipt expired or changed scope",
            ));
        }
        let driver = self
            .drivers
            .find(staged.target.provider())
            .ok_or_else(|| blocked("provider provisioning driver is unavailable"))?;
        if driver.manifest_sha256() != staged.adapter_manifest_sha256 {
            return Err(blocked("provider adapter changed after discovery"));
        }
        let connection = self.repository.pinned_connection(connection_id).await?;
        if connection.scope != scope
            || Uuid::from(staged.target.connection_id()) != connection.connection_id
            || staged.target.connection_revision() != connection.connection_revision
        {
            return Err(blocked("provider connection scope changed"));
        }
        let cancellation = CancellationToken::new();
        let plan = driver
            .plan_apply(&staged.target, &connection, access, &cancellation)
            .await?;
        validate_planned_target(
            &plan,
            ProvisioningIntent::Apply,
            access,
            &staged.target,
            driver.as_ref(),
        )?;
        if let Some(existing) = self
            .retry_or_project_existing_apply(&scope, &connection, &plan)
            .await?
        {
            return Ok(existing);
        }
        let operation = self.plan_operation(&connection, &plan).await?;
        let receipt = ProvisioningReceipt::ready_to_apply(
            crate::kernel::identity::WorkspaceId::from(scope.workspace_id),
            scope.account_scope.storage_key().into(),
            crate::kernel::identity::ConnectionId::from(connection_id),
            operation.id,
            &plan,
            Utc::now(),
        )?;
        let receipt = self.receipts.create(&scope, &receipt).await?;
        projection(&receipt, &operation, &plan)
    }

    pub(crate) async fn prepare_destroy(
        &self,
        receipt_id: Uuid,
    ) -> AppResult<ProvisioningPlanProjection> {
        let scope = self.repository.active_scope().await?;
        let mut receipt = self.receipts.load(&scope, receipt_id).await?;
        if receipt.state() == ProvisioningState::Destroying {
            return self.status_for(&receipt).await;
        }
        if !matches!(
            receipt.state(),
            ProvisioningState::Ready | ProvisioningState::NeedsRepair
        ) {
            return Err(blocked("provider provisioning cannot be destroyed now"));
        }
        let driver = self
            .drivers
            .find(receipt.provider())
            .ok_or_else(|| blocked("provider provisioning driver is unavailable"))?;
        let previous_operation = self.operations.get(receipt.operation_id()).await?;
        let previous_plan = ProvisioningPlan::from_operation_payload(
            previous_operation.payload,
            &previous_operation.payload_hash,
        )?;
        let connection_id = Uuid::from(receipt.connection_id());
        let connection = self.repository.pinned_connection(connection_id).await?;
        if connection.scope != scope {
            return Err(blocked("provider connection scope changed"));
        }
        let cancellation = CancellationToken::new();
        let (plan, observed_ownership_marker) = driver
            .plan_destroy(
                &receipt,
                previous_plan.target(),
                &connection,
                previous_plan.access(),
                &cancellation,
            )
            .await?;
        validate_planned_target(
            &plan,
            ProvisioningIntent::Destroy,
            previous_plan.access(),
            previous_plan.target(),
            driver.as_ref(),
        )?;
        let operation = self.plan_operation(&connection, &plan).await?;
        let expected_revision = receipt.revision();
        receipt.begin_destroy(&plan, operation.id, &observed_ownership_marker, Utc::now())?;
        self.receipts
            .save(&scope, &receipt, expected_revision)
            .await?;
        projection(&receipt, &operation, &plan)
    }

    pub(crate) async fn prepare_repair(
        &self,
        receipt_id: Uuid,
    ) -> AppResult<ProvisioningPlanProjection> {
        let scope = self.repository.active_scope().await?;
        let mut receipt = self.receipts.load(&scope, receipt_id).await?;
        if receipt.state() != ProvisioningState::NeedsRepair {
            return Err(blocked("provider provisioning does not need repair"));
        }
        let previous_operation = self.operations.get(receipt.operation_id()).await?;
        let previous_plan = ProvisioningPlan::from_operation_payload(
            previous_operation.payload,
            &previous_operation.payload_hash,
        )?;
        let driver = self
            .drivers
            .find(receipt.provider())
            .ok_or_else(|| blocked("provider provisioning driver is unavailable"))?;
        let connection_id = Uuid::from(receipt.connection_id());
        let connection = self.repository.pinned_connection(connection_id).await?;
        if connection.scope != scope {
            return Err(blocked("provider connection scope changed"));
        }
        let cancellation = CancellationToken::new();
        let plan = driver
            .plan_repair(
                &receipt,
                previous_plan.target(),
                &connection,
                previous_plan.access(),
                &cancellation,
            )
            .await?;
        validate_planned_target(
            &plan,
            ProvisioningIntent::Apply,
            previous_plan.access(),
            previous_plan.target(),
            driver.as_ref(),
        )?;
        let operation = self.plan_operation(&connection, &plan).await?;
        let expected_revision = receipt.revision();
        receipt.prepare_repair(&plan, operation.id, Utc::now())?;
        self.receipts
            .save(&scope, &receipt, expected_revision)
            .await?;
        projection(&receipt, &operation, &plan)
    }

    pub(crate) async fn reconcile(
        &self,
        receipt_id: Uuid,
    ) -> AppResult<ProvisioningPlanProjection> {
        let scope = self.repository.active_scope().await?;
        let mut receipt = self.receipts.load(&scope, receipt_id).await?;
        if receipt.state() != ProvisioningState::Ready {
            return Err(blocked(
                "provider provisioning is not ready for verification",
            ));
        }
        let operation = self.operations.get(receipt.operation_id()).await?;
        let plan = ProvisioningPlan::from_operation_payload(
            operation.payload.clone(),
            &operation.payload_hash,
        )?;
        let driver = self
            .drivers
            .find(receipt.provider())
            .ok_or_else(|| blocked("provider provisioning driver is unavailable"))?;
        let cancellation = CancellationToken::new();
        let expected_revision = receipt.revision();
        match driver.inspect(&plan, &cancellation).await? {
            ProvisioningInspection::Verified(verification)
                if verification_matches_plan(&plan, &verification) =>
            {
                receipt.reconcile(verification, Utc::now())?;
            }
            ProvisioningInspection::Verified(_) => {
                receipt.needs_repair(ProvisioningRepairReason::VerificationFailed, Utc::now())?;
            }
            ProvisioningInspection::Drift(reason)
                if matches!(
                    reason,
                    ProvisioningRepairReason::ProviderDrift
                        | ProvisioningRepairReason::DatabaseDrift
                        | ProvisioningRepairReason::CredentialSmokeFailed
                        | ProvisioningRepairReason::VerificationFailed
                ) =>
            {
                receipt.needs_repair(reason, Utc::now())?;
            }
            ProvisioningInspection::Drift(_) => {
                return Err(blocked(
                    "provider inspection returned an invalid repair reason",
                ));
            }
        }
        self.receipts
            .save(&scope, &receipt, expected_revision)
            .await?;
        projection(&receipt, &operation, &plan)
    }

    pub(crate) async fn status(&self, receipt_id: Uuid) -> AppResult<ProvisioningPlanProjection> {
        let scope = self.repository.active_scope().await?;
        let receipt = self.receipts.load(&scope, receipt_id).await?;
        self.status_for(&receipt).await
    }

    pub(crate) async fn list_for_connection(
        &self,
        connection_id: Uuid,
    ) -> AppResult<Vec<ProvisioningPlanProjection>> {
        let scope = self.repository.active_scope().await?;
        let connection = self.repository.pinned_connection(connection_id).await?;
        if connection.scope != scope {
            return Err(blocked("provider connection scope changed"));
        }
        let receipts = self
            .receipts
            .list_for_connection(&scope, connection_id)
            .await?;
        let mut projections = Vec::with_capacity(receipts.len());
        for receipt in receipts {
            projections.push(self.status_for(&receipt).await?);
        }
        Ok(projections)
    }

    async fn status_for(
        &self,
        receipt: &ProvisioningReceipt,
    ) -> AppResult<ProvisioningPlanProjection> {
        let operation = self.operations.get(receipt.operation_id()).await?;
        let plan = ProvisioningPlan::from_operation_payload(
            operation.payload.clone(),
            &operation.payload_hash,
        )?;
        projection(receipt, &operation, &plan)
    }

    async fn retry_or_project_existing_apply(
        &self,
        scope: &ActiveResourceScope,
        connection: &PinnedConnection,
        plan: &ProvisioningPlan,
    ) -> AppResult<Option<ProvisioningPlanProjection>> {
        let Some(mut receipt) = self
            .receipts
            .find_for_target(
                scope,
                plan.target().provider().storage_key(),
                plan.target().resource_fingerprint(),
            )
            .await?
        else {
            return Ok(None);
        };
        let previous_operation = self.operations.get(receipt.operation_id()).await?;
        let previous_plan = ProvisioningPlan::from_operation_payload(
            previous_operation.payload.clone(),
            &previous_operation.payload_hash,
        )?;
        projection(&receipt, &previous_operation, &previous_plan)?;
        if Uuid::from(receipt.connection_id()) != connection.connection_id || previous_plan != *plan
        {
            return Err(blocked(
                "a different provider provisioning plan already owns this target",
            ));
        }
        if receipt.state() != ProvisioningState::ReadyToApply {
            return projection(&receipt, &previous_operation, &previous_plan).map(Some);
        }

        let now = Utc::now();
        let current_runtime = previous_operation.runtime_id == self.operations.runtime_id();
        let approval_current = previous_operation
            .expires_at
            .is_none_or(|expires_at| expires_at > now);
        if current_runtime
            && approval_current
            && matches!(
                previous_operation.state,
                OperationState::PendingApproval | OperationState::Approved
            )
        {
            return projection(&receipt, &previous_operation, &previous_plan).map(Some);
        }
        let may_retry = matches!(
            previous_operation.state,
            OperationState::Expired | OperationState::Rejected
        ) || ((!current_runtime || !approval_current)
            && matches!(
                previous_operation.state,
                OperationState::PendingApproval | OperationState::Approved
            ));
        if !may_retry {
            return Err(blocked(
                "provider provisioning approval cannot be retried from its current state",
            ));
        }

        let operation_key = format!(
            "provider-reapproval-{}-{}-{}",
            receipt.id(),
            receipt.revision(),
            self.operations.runtime_id()
        );
        let operation = self
            .plan_operation_with_key(connection, plan, &operation_key)
            .await?;
        let expected_revision = receipt.revision();
        receipt.retry_approval(plan, operation.id, now)?;
        self.receipts
            .save(scope, &receipt, expected_revision)
            .await?;
        projection(&receipt, &operation, plan).map(Some)
    }

    async fn plan_operation(
        &self,
        connection: &PinnedConnection,
        plan: &ProvisioningPlan,
    ) -> AppResult<OperationRecord> {
        self.plan_operation_with_key(connection, plan, plan.idempotency_key())
            .await
    }

    async fn plan_operation_with_key(
        &self,
        connection: &PinnedConnection,
        plan: &ProvisioningPlan,
        operation_idempotency_key: &str,
    ) -> AppResult<OperationRecord> {
        if Uuid::from(plan.target().connection_id()) != connection.connection_id
            || (plan.intent() == ProvisioningIntent::Apply
                && plan.target().connection_revision() != connection.connection_revision)
        {
            return Err(blocked("provider provisioning connection pin changed"));
        }
        let safety = self.repository.safety(connection.connection_id).await?;
        let policy = capture_policy(connection, &safety)?;
        self.operations
            .plan(
                NewOperation {
                    id: Uuid::new_v4(),
                    workspace_id: connection.scope.workspace_id,
                    account_scope: connection.scope.account_scope.storage_key().into(),
                    connection_id: connection.connection_id,
                    connection_revision: connection.connection_revision,
                    terminal_session_id: None,
                    actor: actor_for_pin(connection, "provider-managed-access".into()),
                    kind: OperationKind::ProviderAction,
                    payload_schema_version: 1,
                    payload: plan.operation_payload()?,
                    schema_fingerprint: None,
                    risk_level: if plan.target().production() {
                        OperationRiskLevel::Critical
                    } else {
                        OperationRiskLevel::High
                    },
                    preview: serde_json::json!({
                        "access": plan.access(),
                        "actions": plan.steps().iter().map(ProvisioningPlanStep::action).collect::<Vec<_>>(),
                        "intent": plan.intent(),
                        "production": plan.target().production(),
                        "provider": plan.target().provider(),
                        "targetDisplayName": plan.target().display_name(),
                        "targetDetail": plan.target().detail(),
                        "targetFingerprint": plan.target().resource_fingerprint(),
                    }),
                    policy_snapshot: policy.snapshot,
                    policy_revision: policy.revision,
                    single_use: true,
                    idempotency_key: operation_idempotency_key.into(),
                    expires_at: Some(Utc::now() + OPERATION_TTL),
                },
                OperationPlanDisposition::ApprovalRequired,
            )
            .await
    }
}

fn validate_execution(
    receipt: &ProvisioningReceipt,
    operation: &crate::operations::OperationRecord,
    drivers: &ProvisioningDriverRegistry,
) -> AppResult<(ProvisioningPlan, Arc<dyn ProvisioningDriver>)> {
    if operation.kind != OperationKind::ProviderAction
        || operation.id != receipt.operation_id()
        || operation.workspace_id != Uuid::from(receipt.workspace_id())
        || operation.account_scope != receipt.account_scope()
        || operation.connection_id != Uuid::from(receipt.connection_id())
        || operation.payload_hash != receipt.plan_hash()
        || !matches!(
            operation.state,
            OperationState::Approved | OperationState::Executing
        )
        || (operation.state == OperationState::Executing && !receipt.is_recoverable_execution())
    {
        return Err(blocked("provider provisioning operation authority changed"));
    }
    let plan = ProvisioningPlan::from_operation_payload(
        operation.payload.clone(),
        &operation.payload_hash,
    )?;
    if operation.connection_id != Uuid::from(plan.target().connection_id())
        || (plan.intent() == ProvisioningIntent::Apply
            && operation.connection_revision != plan.target().connection_revision())
        || plan.target().provider() != receipt.provider()
        || plan.target().resource_fingerprint() != receipt.target_fingerprint()
    {
        return Err(blocked("provider provisioning target changed"));
    }
    let driver = drivers
        .find(receipt.provider())
        .ok_or_else(|| blocked("provider provisioning driver is unavailable"))?;
    if driver.manifest_sha256() != plan.adapter_manifest_sha256() {
        return Err(blocked(
            "provider provisioning adapter changed after approval",
        ));
    }
    Ok((plan, driver))
}

fn validate_planned_target(
    plan: &ProvisioningPlan,
    intent: ProvisioningIntent,
    access: ProvisioningAccessMode,
    target: &ProvisioningTarget,
    driver: &dyn ProvisioningDriver,
) -> AppResult<()> {
    plan.validate()?;
    ensure_sha256(driver.manifest_sha256(), "provider adapter manifest")?;
    if plan.intent() != intent
        || plan.access() != access
        || plan.target() != target
        || plan.adapter_manifest_sha256() != driver.manifest_sha256()
        || !plan.capabilities().managed_access_available()
    {
        return Err(blocked(
            "provider provisioning plan changed its trusted target",
        ));
    }
    Ok(())
}

fn verification_matches_plan(
    plan: &ProvisioningPlan,
    verification: &ProvisioningVerification,
) -> bool {
    verification.provider_audit_id() == Some(plan.target().provider_audit_id())
}

fn projection(
    receipt: &ProvisioningReceipt,
    operation: &OperationRecord,
    plan: &ProvisioningPlan,
) -> AppResult<ProvisioningPlanProjection> {
    plan.validate()?;
    if operation.kind != OperationKind::ProviderAction
        || operation.id != receipt.operation_id()
        || operation.workspace_id != Uuid::from(receipt.workspace_id())
        || operation.account_scope != receipt.account_scope()
        || operation.connection_id != Uuid::from(receipt.connection_id())
        || operation.connection_id != Uuid::from(plan.target().connection_id())
        || (plan.intent() == ProvisioningIntent::Apply
            && operation.connection_revision != plan.target().connection_revision())
        || operation.payload_hash != receipt.plan_hash()
        || plan.target().provider() != receipt.provider()
        || plan.target().resource_fingerprint() != receipt.target_fingerprint()
    {
        return Err(blocked("provider provisioning projection is inconsistent"));
    }
    let total_steps = u16::try_from(plan.steps().len())
        .map_err(|_| blocked("provider provisioning plan has too many steps"))?;
    let can_execute = operation.state == OperationState::Approved
        && match plan.intent() {
            ProvisioningIntent::Apply => receipt.state() == ProvisioningState::ReadyToApply,
            ProvisioningIntent::Destroy => receipt.state() == ProvisioningState::Destroying,
        };
    let can_cancel =
        operation.state == OperationState::Executing && receipt.is_recoverable_execution();
    Ok(ProvisioningPlanProjection {
        receipt_id: receipt.id(),
        operation_id: operation.id,
        connection_id: operation.connection_id,
        provider: receipt.provider(),
        target_display_name: plan.target().display_name().into(),
        target_detail: plan.target().detail().into(),
        engine: plan.target().engine(),
        intent: plan.intent(),
        access: plan.access(),
        production: plan.target().production(),
        state: receipt.state(),
        phase: receipt.phase(),
        operation_state: operation.state,
        payload_hash: operation.payload_hash.clone(),
        confirmation_phrase: required_confirmation(operation).map(str::to_owned),
        completed_steps: receipt.completed_steps(),
        total_steps,
        actions: plan
            .steps()
            .iter()
            .map(ProvisioningPlanStep::action)
            .collect(),
        repair_reason: receipt.repair_reason(),
        can_execute,
        can_cancel,
        can_destroy: matches!(
            receipt.state(),
            ProvisioningState::Ready | ProvisioningState::NeedsRepair
        ),
    })
}

fn ensure_sha256(value: &str, label: &'static str) -> AppResult<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(blocked(label))
    }
}

fn safe_projection_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PROJECTION_TEXT_BYTES
        && !value.chars().any(char::is_control)
}

fn blocked(reason: &'static str) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
}
