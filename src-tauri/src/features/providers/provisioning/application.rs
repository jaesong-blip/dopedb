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
use crate::model::Engine;
use crate::operations::{
    actor_for_pin, capture_policy, required_confirmation, ClaimedOperation, NewOperation,
    OperationPlanDisposition, OperationRecord, OperationRuntime,
};
use crate::store::{ActiveResourceScope, PinnedConnection, Store};

use super::super::domain::LocalProvider;
use super::domain::{
    ProvisioningAccessMode, ProvisioningAction, ProvisioningIntent, ProvisioningPhase,
    ProvisioningPlan, ProvisioningPlanStep, ProvisioningReceipt, ProvisioningRepairReason,
    ProvisioningState, ProvisioningTarget, ProvisioningVerification,
};
use super::repository::ProvisioningReceiptRepository;
use super::{ProvisioningExecutionPermit, ProvisioningReadAuthority};

pub(super) type DriverFuture<'a, T> = Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'a>>;

const DISCOVERY_TTL: ChronoDuration = ChronoDuration::minutes(5);
const OPERATION_TTL: ChronoDuration = ChronoDuration::minutes(10);
const MAX_DISCOVERED_TARGETS: usize = 256;
const MAX_PROJECTION_TEXT_BYTES: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningPrerequisiteKind {
    OfficialCli,
    WorkspaceIntegration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningReadiness {
    Missing,
    Outdated,
    LoggedOut,
    WrongAccount,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisioningDriverStatus {
    pub(crate) provider: LocalProvider,
    pub(crate) prerequisite_kind: ProvisioningPrerequisiteKind,
    pub(crate) prerequisite_name: String,
    pub(crate) minimum_version: Option<String>,
    pub(crate) installed_version: Option<String>,
    pub(crate) active_identity: Option<String>,
    pub(crate) readiness: ProvisioningReadiness,
}

impl ProvisioningDriverStatus {
    fn validate(&self, expected_provider: LocalProvider) -> AppResult<()> {
        let readiness_shape = match (self.prerequisite_kind, self.readiness) {
            (ProvisioningPrerequisiteKind::OfficialCli, ProvisioningReadiness::Missing) => {
                self.installed_version.is_none() && self.active_identity.is_none()
            }
            (ProvisioningPrerequisiteKind::OfficialCli, ProvisioningReadiness::Outdated) => {
                self.installed_version.is_some()
            }
            (ProvisioningPrerequisiteKind::OfficialCli, ProvisioningReadiness::LoggedOut) => {
                self.installed_version.is_some() && self.active_identity.is_none()
            }
            (
                ProvisioningPrerequisiteKind::OfficialCli,
                ProvisioningReadiness::WrongAccount | ProvisioningReadiness::Ready,
            ) => self.installed_version.is_some() && self.active_identity.is_some(),
            (ProvisioningPrerequisiteKind::WorkspaceIntegration, ProvisioningReadiness::Ready) => {
                self.minimum_version.is_none()
                    && self.installed_version.is_none()
                    && self.active_identity.is_none()
            }
            (ProvisioningPrerequisiteKind::WorkspaceIntegration, _) => false,
        };
        if self.provider != expected_provider
            || !readiness_shape
            || (self.prerequisite_kind == ProvisioningPrerequisiteKind::OfficialCli
                && self.minimum_version.is_none())
            || !safe_projection_text(&self.prerequisite_name)
            || self
                .minimum_version
                .as_deref()
                .is_some_and(|value| !safe_projection_text(value))
            || self
                .installed_version
                .as_deref()
                .is_some_and(|value| !safe_projection_text(value))
            || self
                .active_identity
                .as_deref()
                .is_some_and(|value| !safe_projection_text(value))
        {
            return Err(blocked("provider prerequisite status is invalid"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(super) struct ProvisioningDiscoveredTarget {
    target: ProvisioningTarget,
}

impl ProvisioningDiscoveredTarget {
    pub(super) fn new(target: ProvisioningTarget) -> Self {
        Self { target }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisioningTargetSummary {
    pub(crate) discovery_id: Uuid,
    pub(crate) provider: LocalProvider,
    pub(crate) display_name: String,
    pub(crate) detail: String,
    pub(crate) engine: Engine,
    pub(crate) production: bool,
    pub(crate) expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisioningPlanProjection {
    pub(crate) receipt_id: Uuid,
    pub(crate) operation_id: Uuid,
    pub(crate) connection_id: Uuid,
    pub(crate) provider: LocalProvider,
    pub(crate) target_display_name: String,
    pub(crate) target_detail: String,
    pub(crate) engine: Engine,
    pub(crate) intent: ProvisioningIntent,
    pub(crate) access: ProvisioningAccessMode,
    pub(crate) production: bool,
    pub(crate) state: ProvisioningState,
    pub(crate) phase: ProvisioningPhase,
    pub(crate) operation_state: OperationState,
    pub(crate) payload_hash: String,
    pub(crate) confirmation_phrase: Option<String>,
    pub(crate) completed_steps: u16,
    pub(crate) total_steps: u16,
    pub(crate) actions: Vec<ProvisioningAction>,
    pub(crate) repair_reason: Option<ProvisioningRepairReason>,
    pub(crate) can_execute: bool,
    pub(crate) can_cancel: bool,
    pub(crate) can_destroy: bool,
}

pub(super) enum ProvisioningInspection {
    Verified(ProvisioningVerification),
    Drift(ProvisioningRepairReason),
}

pub(super) trait ProvisioningDriver: Send + Sync + 'static {
    fn provider(&self) -> LocalProvider;
    fn manifest_sha256(&self) -> &str;
    fn detect<'a>(
        &'a self,
        authority: &'a ProvisioningReadAuthority,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningDriverStatus>;
    fn discover<'a>(
        &'a self,
        connection_id: Uuid,
        authority: &'a ProvisioningReadAuthority,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, Vec<ProvisioningDiscoveredTarget>>;
    fn plan_apply<'a>(
        &'a self,
        target: &'a ProvisioningTarget,
        connection: &'a PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningPlan>;
    fn plan_destroy<'a>(
        &'a self,
        receipt: &'a ProvisioningReceipt,
        target: &'a ProvisioningTarget,
        connection: &'a PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, (ProvisioningPlan, String)>;
    fn plan_repair<'a>(
        &'a self,
        receipt: &'a ProvisioningReceipt,
        target: &'a ProvisioningTarget,
        connection: &'a PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningPlan>;
    fn inspect<'a>(
        &'a self,
        plan: &'a ProvisioningPlan,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningInspection>;
    fn execute_step<'a>(
        &'a self,
        plan: &'a ProvisioningPlan,
        step: &'a ProvisioningPlanStep,
        permit: &'a ProvisioningExecutionPermit,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningStepEvidence>;
    fn verify<'a>(
        &'a self,
        plan: &'a ProvisioningPlan,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningVerification>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ProvisioningStepEvidence {
    sequence: u16,
    execution_sha256: String,
}

impl ProvisioningStepEvidence {
    pub(super) fn exact(step: &ProvisioningPlanStep) -> Self {
        Self {
            sequence: step.sequence(),
            execution_sha256: step.execution_sha256().to_owned(),
        }
    }

    fn validates(&self, step: &ProvisioningPlanStep) -> bool {
        self.sequence == step.sequence() && self.execution_sha256 == step.execution_sha256()
    }
}

#[derive(Clone, Default)]
pub(crate) struct ProvisioningDriverRegistry {
    drivers: Arc<Vec<Arc<dyn ProvisioningDriver>>>,
}

impl ProvisioningDriverRegistry {
    pub(super) fn with_driver(driver: Arc<dyn ProvisioningDriver>) -> Self {
        Self {
            drivers: Arc::new(vec![driver]),
        }
    }

    pub(super) fn with_drivers(
        drivers: impl IntoIterator<Item = Arc<dyn ProvisioningDriver>>,
    ) -> Self {
        Self {
            drivers: Arc::new(drivers.into_iter().collect()),
        }
    }

    fn find(&self, provider: LocalProvider) -> Option<Arc<dyn ProvisioningDriver>> {
        self.drivers
            .iter()
            .find(|driver| driver.provider() == provider)
            .cloned()
    }

    fn all(&self) -> impl Iterator<Item = Arc<dyn ProvisioningDriver>> + '_ {
        self.drivers.iter().cloned()
    }
}

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
    store: Store,
    receipts: ProvisioningReceiptRepository,
    operations: OperationRuntime,
    drivers: ProvisioningDriverRegistry,
    discoveries: Arc<Mutex<HashMap<Uuid, StagedProvisioningTarget>>>,
    cancellations: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
}

impl ProvisioningCoordinator {
    pub(crate) fn new(
        store: Store,
        operations: OperationRuntime,
        drivers: ProvisioningDriverRegistry,
    ) -> Self {
        Self {
            receipts: ProvisioningReceiptRepository::new(store.clone()),
            store,
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
        let scope = self.store.active_resource_scope().await?;
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
        let scope = self.store.active_resource_scope().await?;
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
        let connection = self.store.pin_connection_for_view(connection_id).await?;
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
        let scope = self.store.active_resource_scope().await?;
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
        let connection = self.store.pin_connection_for_view(connection_id).await?;
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
        let scope = self.store.active_resource_scope().await?;
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
        let connection = self.store.pin_connection_for_view(connection_id).await?;
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
        let scope = self.store.active_resource_scope().await?;
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
        let scope = self.store.active_resource_scope().await?;
        let receipt = self.receipts.load(&scope, receipt_id).await?;
        self.status_for(&receipt).await
    }

    pub(crate) async fn list_for_connection(
        &self,
        connection_id: Uuid,
    ) -> AppResult<Vec<ProvisioningPlanProjection>> {
        let scope = self.store.active_resource_scope().await?;
        let connection = self.store.pin_connection_for_view(connection_id).await?;
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
        let safety = self.store.get_safety(connection.connection_id).await?;
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

    pub(crate) async fn execute(&self, receipt_id: Uuid) -> AppResult<ProvisioningReceipt> {
        let scope = self.store.active_resource_scope().await?;
        let receipt = self.receipts.load(&scope, receipt_id).await?;
        let operation = self.operations.get(receipt.operation_id()).await?;
        let (plan, driver) = validate_execution(&receipt, &operation, &self.drivers)?;
        let claimed = self.operations.claim(operation.id).await?;
        self.run_registered(scope, receipt, plan, claimed, driver)
            .await
    }

    pub(crate) async fn cancel(&self, receipt_id: Uuid) -> AppResult<()> {
        let cancellation = self
            .cancellations
            .lock()
            .await
            .get(&receipt_id)
            .cloned()
            .ok_or_else(|| blocked("provider provisioning is not running"))?;
        cancellation.cancel();
        Ok(())
    }

    pub(crate) async fn recover_previous_runtimes(
        &self,
        operation_ids: &[Uuid],
    ) -> AppResult<ProvisioningRecoveryReport> {
        let scope = self.store.active_resource_scope().await?;
        let mut report = ProvisioningRecoveryReport::default();
        for operation_id in operation_ids {
            let operation = self.operations.get(*operation_id).await?;
            let receipt = self
                .receipts
                .load_for_operation(&scope, *operation_id)
                .await;
            let validated = receipt
                .as_ref()
                .ok()
                .and_then(|receipt| validate_execution(receipt, &operation, &self.drivers).ok());
            let Some((plan, driver)) = validated else {
                if let Ok(mut receipt) = receipt {
                    self.mark_repair(
                        &scope,
                        &mut receipt,
                        ProvisioningRepairReason::ApplyOutcomeUnknown,
                    )
                    .await?;
                }
                self.operations
                    .quarantine_provider_execution(
                        *operation_id,
                        &operation.payload_hash,
                        "provisioning_checkpoint_rejected",
                    )
                    .await?;
                report.quarantined.push(*operation_id);
                continue;
            };
            let receipt = receipt.expect("validated receipt is present");
            let claimed = self
                .operations
                .resume_provider_claim(*operation_id, &operation.payload_hash)
                .await?;
            match self
                .run_registered(scope.clone(), receipt, plan, claimed, driver)
                .await
            {
                Ok(_) => report.resumed.push(*operation_id),
                Err(_) => report.quarantined.push(*operation_id),
            }
        }
        Ok(report)
    }

    async fn run_registered(
        &self,
        scope: ActiveResourceScope,
        receipt: ProvisioningReceipt,
        plan: ProvisioningPlan,
        claimed: ClaimedOperation,
        driver: Arc<dyn ProvisioningDriver>,
    ) -> AppResult<ProvisioningReceipt> {
        let receipt_id = receipt.id();
        let operation_id = claimed.record().id;
        let cancellation = CancellationToken::new();
        {
            use std::collections::hash_map::Entry;

            let mut running = self.cancellations.lock().await;
            match running.entry(receipt_id) {
                Entry::Vacant(entry) => {
                    entry.insert(cancellation.clone());
                }
                Entry::Occupied(_) => {
                    return Err(blocked("provider provisioning is already running"));
                }
            }
        }
        let result = self
            .run_claimed(
                &scope,
                receipt,
                &plan,
                &claimed,
                driver.as_ref(),
                &cancellation,
            )
            .await;
        self.cancellations.lock().await.remove(&receipt_id);
        if result.is_err()
            && self
                .operations
                .get(operation_id)
                .await
                .is_ok_and(|operation| operation.state == OperationState::Executing)
        {
            let _ = self
                .operations
                .mark_outcome_unknown(
                    operation_id,
                    &serde_json::json!({
                        "providerAuditId": plan.target().provider_audit_id(),
                        "reason": "provisioning_coordinator_aborted",
                        "receiptId": receipt_id,
                        "totalSteps": plan.steps().len(),
                    }),
                )
                .await;
        }
        result
    }

    async fn run_claimed(
        &self,
        scope: &ActiveResourceScope,
        mut receipt: ProvisioningReceipt,
        plan: &ProvisioningPlan,
        claimed: &ClaimedOperation,
        driver: &dyn ProvisioningDriver,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningReceipt> {
        let record = claimed.record();
        if claimed.grant().operation_id() != receipt.operation_id()
            || claimed.grant().payload_sha256() != receipt.plan_hash()
            || claimed.grant().connection_id() != Uuid::from(receipt.connection_id())
            || record.payload_hash != receipt.plan_hash()
        {
            return Err(blocked("provider provisioning execution grant is invalid"));
        }

        match plan.intent() {
            ProvisioningIntent::Apply => {
                if receipt.state() == ProvisioningState::ReadyToApply {
                    let expected = receipt.revision();
                    receipt.begin_apply(plan, record.id, Utc::now())?;
                    self.receipts.save(scope, &receipt, expected).await?;
                }
                if !matches!(
                    receipt.state(),
                    ProvisioningState::Applying | ProvisioningState::Verifying
                ) {
                    return Err(blocked("provider provisioning apply cannot resume"));
                }
                if receipt.state() == ProvisioningState::Applying {
                    for step in plan
                        .steps()
                        .iter()
                        .skip(usize::from(receipt.completed_steps()))
                    {
                        if cancellation.is_cancelled() {
                            return self.cancel_execution(scope, receipt, plan, record.id).await;
                        }
                        let permit = ProvisioningExecutionPermit::issue(
                            record.id,
                            receipt.provider(),
                            receipt.plan_hash().to_owned(),
                            step.execution_sha256().to_owned(),
                        );
                        let evidence =
                            match driver.execute_step(plan, step, &permit, cancellation).await {
                                Ok(evidence) if evidence.validates(step) => evidence,
                                Ok(_) | Err(_) => {
                                    return self
                                        .fail_execution(
                                            scope,
                                            receipt,
                                            plan,
                                            record.id,
                                            ProvisioningRepairReason::ApplyOutcomeUnknown,
                                            "provider_apply_outcome_unknown",
                                        )
                                        .await;
                                }
                            };
                        let expected = receipt.revision();
                        receipt.checkpoint(plan, evidence.sequence, Utc::now())?;
                        self.receipts.save(scope, &receipt, expected).await?;
                        self.operations
                            .progress(
                                record.id,
                                &serde_json::json!({
                                    "phase": "apply",
                                    "sequence": step.sequence(),
                                    "action": step.action(),
                                }),
                            )
                            .await?;
                    }
                    let expected = receipt.revision();
                    receipt.begin_verification(plan, Utc::now())?;
                    self.receipts.save(scope, &receipt, expected).await?;
                }
                if cancellation.is_cancelled() {
                    return self.cancel_execution(scope, receipt, plan, record.id).await;
                }
                let verification = match driver.verify(plan, cancellation).await {
                    Ok(verification) if verification_matches_plan(plan, &verification) => {
                        verification
                    }
                    Ok(_) | Err(_) => {
                        return self
                            .fail_execution(
                                scope,
                                receipt,
                                plan,
                                record.id,
                                ProvisioningRepairReason::VerificationFailed,
                                "provider_verification_failed",
                            )
                            .await;
                    }
                };
                let expected = receipt.revision();
                receipt.complete_verification(verification, Utc::now())?;
                self.receipts.save(scope, &receipt, expected).await?;
            }
            ProvisioningIntent::Destroy => {
                if receipt.state() != ProvisioningState::Destroying {
                    return Err(blocked("provider provisioning destroy cannot resume"));
                }
                for step in plan
                    .steps()
                    .iter()
                    .skip(usize::from(receipt.completed_steps()))
                {
                    if cancellation.is_cancelled() {
                        return self.cancel_execution(scope, receipt, plan, record.id).await;
                    }
                    let permit = ProvisioningExecutionPermit::issue(
                        record.id,
                        receipt.provider(),
                        receipt.plan_hash().to_owned(),
                        step.execution_sha256().to_owned(),
                    );
                    let evidence =
                        match driver.execute_step(plan, step, &permit, cancellation).await {
                            Ok(evidence) if evidence.validates(step) => evidence,
                            Ok(_) | Err(_) => {
                                return self
                                    .fail_execution(
                                        scope,
                                        receipt,
                                        plan,
                                        record.id,
                                        ProvisioningRepairReason::CleanupFailed,
                                        "provider_destroy_outcome_unknown",
                                    )
                                    .await;
                            }
                        };
                    let expected = receipt.revision();
                    receipt.checkpoint_destroy(plan, evidence.sequence, Utc::now())?;
                    self.receipts.save(scope, &receipt, expected).await?;
                }
                let expected = receipt.revision();
                receipt.finish_destroy(plan, Utc::now())?;
                self.receipts.save(scope, &receipt, expected).await?;
            }
        }
        self.operations
            .succeed(
                record.id,
                &serde_json::json!({
                    "completedSteps": plan.steps().len(),
                    "phase": receipt.phase(),
                    "providerAuditId": plan.target().provider_audit_id(),
                    "receiptId": receipt.id(),
                    "state": receipt.state(),
                    "totalSteps": plan.steps().len(),
                }),
            )
            .await?;
        Ok(receipt)
    }

    async fn cancel_execution(
        &self,
        scope: &ActiveResourceScope,
        mut receipt: ProvisioningReceipt,
        plan: &ProvisioningPlan,
        operation_id: Uuid,
    ) -> AppResult<ProvisioningReceipt> {
        self.mark_repair(scope, &mut receipt, ProvisioningRepairReason::UserCancelled)
            .await?;
        self.operations
            .confirm_cancelled(
                operation_id,
                &serde_json::json!({
                    "completedSteps": receipt.completed_steps(),
                    "providerAuditId": plan.target().provider_audit_id(),
                    "reason": "user_cancelled",
                    "receiptId": receipt.id(),
                    "totalSteps": plan.steps().len(),
                }),
            )
            .await?;
        Err(blocked("provider provisioning was cancelled"))
    }

    async fn fail_execution(
        &self,
        scope: &ActiveResourceScope,
        mut receipt: ProvisioningReceipt,
        plan: &ProvisioningPlan,
        operation_id: Uuid,
        repair_reason: ProvisioningRepairReason,
        operation_reason: &'static str,
    ) -> AppResult<ProvisioningReceipt> {
        self.mark_repair(scope, &mut receipt, repair_reason).await?;
        self.operations
            .mark_outcome_unknown(
                operation_id,
                &serde_json::json!({
                    "completedSteps": receipt.completed_steps(),
                    "providerAuditId": plan.target().provider_audit_id(),
                    "reason": operation_reason,
                    "receiptId": receipt.id(),
                    "totalSteps": plan.steps().len(),
                }),
            )
            .await?;
        Err(blocked("provider provisioning needs repair"))
    }

    async fn mark_repair(
        &self,
        scope: &ActiveResourceScope,
        receipt: &mut ProvisioningReceipt,
        reason: ProvisioningRepairReason,
    ) -> AppResult<()> {
        let expected = receipt.revision();
        receipt.needs_repair(reason, Utc::now())?;
        self.receipts.save(scope, receipt, expected).await
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

#[cfg(test)]
pub(crate) async fn assert_restart_resume_lifecycle() {
    use chrono::Duration as ChronoDuration;
    use dopedb_protocol::{OperationActorKind, OperationRiskLevel};

    use crate::operations::{
        ExactApprovalRequest, LocalApprovalAuthority, NewOperation, OperationActor,
        OperationActorProvenance, OperationApprover, OperationPlanDisposition,
    };

    use super::domain::{
        fixture_plan, fixture_repair_plan, ManagedAccessCapability, ProvisioningCapabilityManifest,
        ProvisioningIntent,
    };
    use crate::kernel::identity::{ConnectionId, WorkspaceId};

    use ManagedAccessCapability::{
        Apply, Destroy, Detect, Discover, Issue, Plan, Reconcile, Verify,
    };

    #[derive(Debug, Default)]
    struct MockProviderEffects {
        attempted_sequences: Vec<u16>,
        applied_actions: Vec<ProvisioningAction>,
    }

    #[derive(Default)]
    struct MockDriver {
        fail_sequence: Option<u16>,
        fail_verification: bool,
        effects: Arc<Mutex<MockProviderEffects>>,
    }

    impl ProvisioningDriver for MockDriver {
        fn provider(&self) -> LocalProvider {
            LocalProvider::GcpCloudSql
        }

        fn manifest_sha256(&self) -> &str {
            "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
        }

        fn detect<'a>(
            &'a self,
            _authority: &'a ProvisioningReadAuthority,
            _cancellation: &'a CancellationToken,
        ) -> DriverFuture<'a, ProvisioningDriverStatus> {
            Box::pin(async move {
                Ok(ProvisioningDriverStatus {
                    provider: LocalProvider::GcpCloudSql,
                    prerequisite_kind: ProvisioningPrerequisiteKind::OfficialCli,
                    prerequisite_name: "mock-gcloud".into(),
                    minimum_version: Some("1.0.0".into()),
                    installed_version: Some("1.0.0".into()),
                    active_identity: Some("owner@example.com".into()),
                    readiness: ProvisioningReadiness::Ready,
                })
            })
        }

        fn discover<'a>(
            &'a self,
            _connection_id: Uuid,
            _authority: &'a ProvisioningReadAuthority,
            _cancellation: &'a CancellationToken,
        ) -> DriverFuture<'a, Vec<ProvisioningDiscoveredTarget>> {
            Box::pin(async move {
                let plan = fixture_plan(
                    ProvisioningIntent::Apply,
                    ProvisioningCapabilityManifest::new([
                        Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
                    ]),
                );
                Ok(vec![ProvisioningDiscoveredTarget::new(
                    plan.target().clone(),
                )])
            })
        }

        fn plan_apply<'a>(
            &'a self,
            _target: &'a ProvisioningTarget,
            _connection: &'a PinnedConnection,
            _access: ProvisioningAccessMode,
            _cancellation: &'a CancellationToken,
        ) -> DriverFuture<'a, ProvisioningPlan> {
            Box::pin(async move {
                Ok(fixture_plan(
                    ProvisioningIntent::Apply,
                    ProvisioningCapabilityManifest::new([
                        Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
                    ]),
                ))
            })
        }

        fn plan_destroy<'a>(
            &'a self,
            _receipt: &'a ProvisioningReceipt,
            _target: &'a ProvisioningTarget,
            _connection: &'a PinnedConnection,
            _access: ProvisioningAccessMode,
            _cancellation: &'a CancellationToken,
        ) -> DriverFuture<'a, (ProvisioningPlan, String)> {
            Box::pin(async move {
                let plan = fixture_plan(
                    ProvisioningIntent::Destroy,
                    ProvisioningCapabilityManifest::new([
                        Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
                    ]),
                );
                let marker = plan.ownership_marker().to_owned();
                Ok((plan, marker))
            })
        }

        fn plan_repair<'a>(
            &'a self,
            _receipt: &'a ProvisioningReceipt,
            _target: &'a ProvisioningTarget,
            _connection: &'a PinnedConnection,
            _access: ProvisioningAccessMode,
            _cancellation: &'a CancellationToken,
        ) -> DriverFuture<'a, ProvisioningPlan> {
            Box::pin(async move {
                Ok(fixture_repair_plan(ProvisioningCapabilityManifest::new([
                    Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
                ])))
            })
        }

        fn inspect<'a>(
            &'a self,
            plan: &'a ProvisioningPlan,
            _cancellation: &'a CancellationToken,
        ) -> DriverFuture<'a, ProvisioningInspection> {
            Box::pin(async move {
                Ok(ProvisioningInspection::Verified(
                    ProvisioningVerification::complete(
                        Some(plan.target().provider_audit_id().into()),
                        Utc::now(),
                    )?,
                ))
            })
        }

        fn execute_step<'a>(
            &'a self,
            _plan: &'a ProvisioningPlan,
            step: &'a ProvisioningPlanStep,
            _permit: &'a ProvisioningExecutionPermit,
            cancellation: &'a CancellationToken,
        ) -> DriverFuture<'a, ProvisioningStepEvidence> {
            Box::pin(async move {
                if cancellation.is_cancelled() {
                    return Err(blocked("mock provider operation was cancelled"));
                }
                let mut effects = self.effects.lock().await;
                effects.attempted_sequences.push(step.sequence());
                if self.fail_sequence == Some(step.sequence()) {
                    return Err(blocked("mock provider step outcome is unknown"));
                }
                if !effects.applied_actions.contains(&step.action()) {
                    effects.applied_actions.push(step.action());
                }
                Ok(ProvisioningStepEvidence::exact(step))
            })
        }

        fn verify<'a>(
            &'a self,
            plan: &'a ProvisioningPlan,
            cancellation: &'a CancellationToken,
        ) -> DriverFuture<'a, ProvisioningVerification> {
            Box::pin(async move {
                if cancellation.is_cancelled() {
                    return Err(blocked("mock provider verification was cancelled"));
                }
                if self.fail_verification {
                    return Err(blocked("mock provider verification failed"));
                }
                ProvisioningVerification::complete(
                    Some(plan.target().provider_audit_id().into()),
                    Utc::now(),
                )
            })
        }
    }

    async fn seed_fixture_connection(store: &Store, plan: &ProvisioningPlan) {
        let connection = crate::model::ConnectionProfile {
            id: Uuid::from(plan.target().connection_id()),
            name: "fixture-instance / app".into(),
            engine: Engine::Postgres,
            provider: crate::model::Provider::GcpCloudSql,
            driver_id: None,
            host: "127.0.0.1".into(),
            port: 5432,
            database: "app".into(),
            username: "fixture".into(),
            sslmode: "disable".into(),
            extra_params: HashMap::new(),
            readonly_default: true,
            allow_writes: false,
            secret_ref: None,
            env: Some("dev".into()),
            schema_group: None,
            workspace_access: crate::model::WorkspaceConnectionAccess::Local,
            credential_mode: crate::model::WorkspaceCredentialMode::Local,
            provider_target: None,
        };
        for expected_revision in 1..=plan.target().connection_revision() {
            store
                .upsert_connection(&connection)
                .await
                .unwrap_or_else(|error| {
                    panic!("seed fixture connection revision {expected_revision}: {error}")
                });
        }
    }

    async fn approved_operation(
        runtime: &OperationRuntime,
        authority: &LocalApprovalAuthority,
        scope: &ActiveResourceScope,
        plan: &ProvisioningPlan,
        operation_id: Uuid,
    ) -> OperationRecord {
        let operation = runtime
            .plan(
                NewOperation {
                    id: operation_id,
                    workspace_id: scope.workspace_id,
                    account_scope: scope.account_scope.storage_key().into(),
                    connection_id: Uuid::from(plan.target().connection_id()),
                    connection_revision: plan.target().connection_revision(),
                    terminal_session_id: None,
                    actor: OperationActor {
                        kind: OperationActorKind::LocalUser,
                        id: "local-user".into(),
                        provenance: OperationActorProvenance {
                            origin_surface: "provider-provisioning-test".into(),
                            ..OperationActorProvenance::default()
                        },
                    },
                    kind: OperationKind::ProviderAction,
                    payload_schema_version: 1,
                    payload: plan.operation_payload().unwrap(),
                    schema_fingerprint: None,
                    risk_level: OperationRiskLevel::High,
                    preview: serde_json::json!({"provider": "gcpCloudSql"}),
                    policy_snapshot: serde_json::json!({"environment": "prod"}),
                    policy_revision: "provider-policy-v1".into(),
                    single_use: true,
                    idempotency_key: plan.idempotency_key().into(),
                    expires_at: Some(Utc::now() + ChronoDuration::minutes(5)),
                },
                OperationPlanDisposition::ApprovalRequired,
            )
            .await
            .expect("plan provider operation");
        runtime
            .approve_exact(
                authority,
                ExactApprovalRequest {
                    operation_id,
                    expected_payload_hash: operation.payload_hash.clone(),
                    approver: OperationApprover {
                        kind: OperationActorKind::LocalUser,
                        id: "local-user".into(),
                    },
                    current_policy_revision: operation.policy_revision.clone(),
                    reason: Some("test exact target".into()),
                },
            )
            .await
            .expect("approve exact provider operation")
    }

    async fn approve_planned_operation(
        runtime: &OperationRuntime,
        authority: &LocalApprovalAuthority,
        operation_id: Uuid,
    ) -> OperationRecord {
        let operation = runtime
            .get(operation_id)
            .await
            .expect("load planned provider operation");
        runtime
            .approve_exact(
                authority,
                ExactApprovalRequest {
                    operation_id,
                    expected_payload_hash: operation.payload_hash.clone(),
                    approver: OperationApprover {
                        kind: OperationActorKind::LocalUser,
                        id: "local-user".into(),
                    },
                    current_policy_revision: operation.policy_revision.clone(),
                    reason: Some("repair exact provider target".into()),
                },
            )
            .await
            .expect("approve planned provider operation")
    }

    async fn assert_apply_failure_repair(
        fail_sequence: Option<u16>,
        fail_verification: bool,
        expected_completed_steps: u16,
        expected_repair_reason: ProvisioningRepairReason,
        expected_operation_reason: &'static str,
    ) {
        let store = Store::in_memory_for_test()
            .await
            .expect("open partial apply recovery store");
        let scope = store
            .active_resource_scope()
            .await
            .expect("resolve partial apply test scope");
        let plan = fixture_plan(
            ProvisioningIntent::Apply,
            ProvisioningCapabilityManifest::new([
                Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
            ]),
        );
        let connection = crate::model::ConnectionProfile {
            id: Uuid::from(plan.target().connection_id()),
            name: "fixture-instance / app".into(),
            engine: Engine::Postgres,
            provider: crate::model::Provider::GcpCloudSql,
            driver_id: None,
            host: "127.0.0.1".into(),
            port: 5432,
            database: "app".into(),
            username: "fixture".into(),
            sslmode: "disable".into(),
            extra_params: HashMap::new(),
            readonly_default: true,
            allow_writes: false,
            secret_ref: None,
            env: Some("dev".into()),
            schema_group: None,
            workspace_access: crate::model::WorkspaceConnectionAccess::Local,
            credential_mode: crate::model::WorkspaceCredentialMode::Local,
            provider_target: None,
        };
        for expected_revision in 1..=plan.target().connection_revision() {
            store
                .upsert_connection(&connection)
                .await
                .unwrap_or_else(|error| {
                    panic!("seed fixture connection revision {expected_revision}: {error}")
                });
        }
        let operation_id = Uuid::from_u128(50);
        let (runtime, authority) = OperationRuntime::new(&store);
        approved_operation(&runtime, &authority, &scope, &plan, operation_id).await;

        let receipt_repository = ProvisioningReceiptRepository::new(store.clone());
        let receipt = ProvisioningReceipt::ready_to_apply(
            WorkspaceId::from(scope.workspace_id),
            scope.account_scope.storage_key().into(),
            plan.target().connection_id(),
            operation_id,
            &plan,
            Utc::now(),
        )
        .expect("create partial apply receipt");
        receipt_repository
            .create(&scope, &receipt)
            .await
            .expect("store partial apply receipt");

        let effects = Arc::new(Mutex::new(MockProviderEffects::default()));
        let failing_coordinator = ProvisioningCoordinator::new(
            store.clone(),
            runtime.clone(),
            ProvisioningDriverRegistry::with_driver(Arc::new(MockDriver {
                fail_sequence,
                fail_verification,
                effects: effects.clone(),
            })),
        );
        assert!(failing_coordinator.execute(receipt.id()).await.is_err());

        let failed = receipt_repository
            .load(&scope, receipt.id())
            .await
            .expect("load deterministic partial apply state");
        assert_eq!(failed.state(), ProvisioningState::NeedsRepair);
        assert_eq!(failed.completed_steps(), expected_completed_steps);
        assert_eq!(failed.repair_reason(), Some(expected_repair_reason));
        assert!(!failed.can_issue());
        assert_eq!(
            runtime.get(operation_id).await.unwrap().state,
            OperationState::OutcomeUnknown
        );
        let failure_events = runtime
            .events(operation_id)
            .await
            .expect("load partial apply audit events");
        let failure = &failure_events.last().unwrap().details;
        assert_eq!(
            failure["providerAuditId"],
            plan.target().provider_audit_id()
        );
        assert_eq!(failure["completedSteps"], expected_completed_steps);
        assert_eq!(failure["reason"], expected_operation_reason);
        assert_eq!(failure["totalSteps"], plan.steps().len());
        assert!(runtime
            .verify_event_chain(operation_id)
            .await
            .expect("verify partial apply audit chain"));

        let expected_partial_actions = plan
            .steps()
            .iter()
            .take(usize::from(expected_completed_steps))
            .map(ProvisioningPlanStep::action)
            .collect::<Vec<_>>();
        assert_eq!(
            effects.lock().await.applied_actions,
            expected_partial_actions
        );

        let repair_coordinator = ProvisioningCoordinator::new(
            store,
            runtime.clone(),
            ProvisioningDriverRegistry::with_driver(Arc::new(MockDriver {
                effects: effects.clone(),
                ..MockDriver::default()
            })),
        );
        let repair = repair_coordinator
            .prepare_repair(receipt.id())
            .await
            .expect("prepare exact partial apply repair");
        assert_eq!(repair.state, ProvisioningState::ReadyToApply);
        assert_eq!(repair.completed_steps, 0);
        assert_eq!(repair.actions.len(), plan.steps().len());
        approve_planned_operation(&runtime, &authority, repair.operation_id).await;

        let repaired = repair_coordinator
            .execute(receipt.id())
            .await
            .expect("execute convergent partial apply repair");
        assert_eq!(repaired.state(), ProvisioningState::Ready);
        assert_eq!(usize::from(repaired.completed_steps()), plan.steps().len());
        assert!(repaired.can_issue());
        assert_eq!(
            runtime.get(repair.operation_id).await.unwrap().state,
            OperationState::Succeeded
        );

        let expected_actions = plan
            .steps()
            .iter()
            .map(ProvisioningPlanStep::action)
            .collect::<Vec<_>>();
        let attempts_before_replay = {
            let effects = effects.lock().await;
            assert_eq!(effects.applied_actions, expected_actions);
            effects.attempted_sequences.len()
        };
        assert!(repair_coordinator.execute(receipt.id()).await.is_err());
        assert_eq!(
            effects.lock().await.attempted_sequences.len(),
            attempts_before_replay
        );
        assert!(runtime
            .verify_event_chain(repair.operation_id)
            .await
            .expect("verify repaired apply audit chain"));
    }

    assert_apply_failure_repair(
        Some(1),
        false,
        0,
        ProvisioningRepairReason::ApplyOutcomeUnknown,
        "provider_apply_outcome_unknown",
    )
    .await;
    assert_apply_failure_repair(
        Some(2),
        false,
        1,
        ProvisioningRepairReason::ApplyOutcomeUnknown,
        "provider_apply_outcome_unknown",
    )
    .await;
    assert_apply_failure_repair(
        Some(3),
        false,
        2,
        ProvisioningRepairReason::ApplyOutcomeUnknown,
        "provider_apply_outcome_unknown",
    )
    .await;
    assert_apply_failure_repair(
        Some(4),
        false,
        3,
        ProvisioningRepairReason::ApplyOutcomeUnknown,
        "provider_apply_outcome_unknown",
    )
    .await;
    assert_apply_failure_repair(
        None,
        true,
        4,
        ProvisioningRepairReason::VerificationFailed,
        "provider_verification_failed",
    )
    .await;

    let retry_store = Store::in_memory_for_test()
        .await
        .expect("open approval retry store");
    let retry_plan = fixture_plan(
        ProvisioningIntent::Apply,
        ProvisioningCapabilityManifest::new([
            Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
        ]),
    );
    seed_fixture_connection(&retry_store, &retry_plan).await;
    let retry_connection_id = Uuid::from(retry_plan.target().connection_id());
    let (first_approval_runtime, _) = OperationRuntime::new(&retry_store);
    let first_approval_coordinator = ProvisioningCoordinator::new(
        retry_store.clone(),
        first_approval_runtime.clone(),
        ProvisioningDriverRegistry::with_driver(Arc::new(MockDriver::default())),
    );
    let staged = first_approval_coordinator
        .discover(LocalProvider::GcpCloudSql, retry_connection_id)
        .await
        .expect("stage initial provider approval target");
    let first_approval = first_approval_coordinator
        .prepare_apply(
            staged[0].discovery_id,
            retry_connection_id,
            ProvisioningAccessMode::Read,
        )
        .await
        .expect("prepare initial provider approval");
    assert_eq!(
        first_approval.operation_state,
        OperationState::PendingApproval
    );
    assert_eq!(
        serde_json::to_value(&first_approval).unwrap()["operationState"],
        "pending_approval"
    );

    let (second_approval_runtime, _) = OperationRuntime::new(&retry_store);
    let approval_recovery = second_approval_runtime
        .recover_previous_runtimes()
        .await
        .expect("expire the previous runtime approval");
    assert_eq!(approval_recovery.expired, vec![first_approval.operation_id]);
    let second_approval_coordinator = ProvisioningCoordinator::new(
        retry_store,
        second_approval_runtime.clone(),
        ProvisioningDriverRegistry::with_driver(Arc::new(MockDriver::default())),
    );
    let restaged = second_approval_coordinator
        .discover(LocalProvider::GcpCloudSql, retry_connection_id)
        .await
        .expect("restage the exact provider approval target");
    let retried_approval = second_approval_coordinator
        .prepare_apply(
            restaged[0].discovery_id,
            retry_connection_id,
            ProvisioningAccessMode::Read,
        )
        .await
        .expect("retry the exact provider approval after restart");
    assert_eq!(retried_approval.receipt_id, first_approval.receipt_id);
    assert_ne!(retried_approval.operation_id, first_approval.operation_id);
    assert_eq!(
        retried_approval.operation_state,
        OperationState::PendingApproval
    );
    assert_eq!(
        first_approval_runtime
            .get(first_approval.operation_id)
            .await
            .unwrap()
            .state,
        OperationState::Expired
    );
    assert_eq!(
        second_approval_runtime
            .get(retried_approval.operation_id)
            .await
            .unwrap()
            .state,
        OperationState::PendingApproval
    );

    let store = Store::in_memory_for_test()
        .await
        .expect("open provisioning recovery store");
    let scope = store
        .active_resource_scope()
        .await
        .expect("resolve active test scope");
    let plan = fixture_plan(
        ProvisioningIntent::Apply,
        ProvisioningCapabilityManifest::new([
            Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
        ]),
    );
    let operation_id = Uuid::from_u128(40);
    let connection_id = Uuid::from(plan.target().connection_id());
    assert!(!verification_matches_plan(
        &plan,
        &ProvisioningVerification::complete(Some("wrong-provider-audit".into()), Utc::now())
            .expect("construct mismatched provider audit fixture"),
    ));
    let (first_runtime, authority) = OperationRuntime::new(&store);
    approved_operation(&first_runtime, &authority, &scope, &plan, operation_id).await;
    let receipt_repository = ProvisioningReceiptRepository::new(store.clone());
    let mut receipt = ProvisioningReceipt::ready_to_apply(
        WorkspaceId::from(scope.workspace_id),
        scope.account_scope.storage_key().into(),
        ConnectionId::from(connection_id),
        operation_id,
        &plan,
        Utc::now(),
    )
    .expect("create recovery receipt");
    receipt_repository
        .create(&scope, &receipt)
        .await
        .expect("store recovery receipt");
    first_runtime
        .claim(operation_id)
        .await
        .expect("claim first runtime operation");
    let expected = receipt.revision();
    receipt
        .begin_apply(&plan, operation_id, Utc::now())
        .expect("begin first runtime apply");
    receipt_repository
        .save(&scope, &receipt, expected)
        .await
        .expect("store apply state");
    let expected = receipt.revision();
    receipt
        .checkpoint(&plan, 1, Utc::now())
        .expect("checkpoint first provider step");
    receipt_repository
        .save(&scope, &receipt, expected)
        .await
        .expect("store first checkpoint");

    let (second_runtime, second_authority) = OperationRuntime::new(&store);
    let recovery = second_runtime
        .recover_previous_runtimes()
        .await
        .expect("classify interrupted operations");
    assert_eq!(
        recovery.provisioning_checkpoint_validation_required,
        vec![operation_id]
    );
    assert!(recovery.outcome_unknown.is_empty());
    let coordinator = ProvisioningCoordinator::new(
        store.clone(),
        second_runtime.clone(),
        ProvisioningDriverRegistry::with_driver(Arc::new(MockDriver::default())),
    );
    let resumed = coordinator
        .recover_previous_runtimes(&recovery.provisioning_checkpoint_validation_required)
        .await
        .expect("resume exact provider checkpoint");
    assert_eq!(resumed.resumed, vec![operation_id]);
    let stored = receipt_repository
        .load(&scope, receipt.id())
        .await
        .expect("load resumed receipt");
    assert_eq!(stored.state(), ProvisioningState::Ready);
    assert!(stored.can_issue());
    assert_eq!(
        second_runtime.get(operation_id).await.unwrap().state,
        OperationState::Succeeded
    );
    let statuses = coordinator
        .driver_statuses()
        .await
        .expect("inspect the closed mock driver");
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].readiness, ProvisioningReadiness::Ready);
    let targets = coordinator
        .discover(LocalProvider::GcpCloudSql, connection_id)
        .await
        .expect("stage a scope-bound provider target");
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].display_name, "fixture-instance / app");
    let status = coordinator
        .status(receipt.id())
        .await
        .expect("project a secret-free completed plan");
    assert_eq!(status.state, ProvisioningState::Ready);
    assert_eq!(status.completed_steps, status.total_steps);
    assert!(status.can_destroy);

    let success_events = second_runtime
        .events(operation_id)
        .await
        .expect("load successful provider audit events");
    assert_eq!(
        success_events.last().unwrap().details["providerAuditId"],
        plan.target().provider_audit_id()
    );
    assert_eq!(
        success_events.last().unwrap().details["completedSteps"],
        plan.steps().len()
    );
    assert!(second_runtime
        .verify_event_chain(operation_id)
        .await
        .expect("verify successful provider audit chain"));

    let destroy_plan = fixture_plan(
        ProvisioningIntent::Destroy,
        ProvisioningCapabilityManifest::new([
            Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
        ]),
    );
    let destroy_operation_id = Uuid::from_u128(41);
    approved_operation(
        &second_runtime,
        &second_authority,
        &scope,
        &destroy_plan,
        destroy_operation_id,
    )
    .await;
    let mut destroying = stored;
    let expected = destroying.revision();
    destroying
        .begin_destroy(
            &destroy_plan,
            destroy_operation_id,
            destroy_plan.ownership_marker(),
            Utc::now(),
        )
        .expect("begin partial destroy fixture");
    receipt_repository
        .save(&scope, &destroying, expected)
        .await
        .expect("persist partial destroy fixture");
    let failing_coordinator = ProvisioningCoordinator::new(
        store,
        second_runtime.clone(),
        ProvisioningDriverRegistry::with_driver(Arc::new(MockDriver {
            fail_sequence: Some(2),
            ..MockDriver::default()
        })),
    );
    assert!(failing_coordinator.execute(destroying.id()).await.is_err());
    let failed = receipt_repository
        .load(&scope, destroying.id())
        .await
        .expect("load deterministic partial destroy state");
    assert_eq!(failed.state(), ProvisioningState::NeedsRepair);
    assert_eq!(failed.completed_steps(), 1);
    assert_eq!(
        failed.repair_reason(),
        Some(ProvisioningRepairReason::CleanupFailed)
    );
    assert!(!failed.can_issue());
    assert_eq!(
        second_runtime
            .get(destroy_operation_id)
            .await
            .unwrap()
            .state,
        OperationState::OutcomeUnknown
    );
    let failure_events = second_runtime
        .events(destroy_operation_id)
        .await
        .expect("load partial destroy audit events");
    let failure = &failure_events.last().unwrap().details;
    assert_eq!(
        failure["providerAuditId"],
        destroy_plan.target().provider_audit_id()
    );
    assert_eq!(failure["completedSteps"], 1);
    assert_eq!(failure["reason"], "provider_destroy_outcome_unknown");
    assert_eq!(failure["totalSteps"], destroy_plan.steps().len());
    assert!(second_runtime
        .verify_event_chain(destroy_operation_id)
        .await
        .expect("verify partial destroy audit chain"));
}
