//! Provisioning driver contracts and transport projections.

use super::*;

pub(in super::super) type DriverFuture<'a, T> =
    Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'a>>;

pub(super) const DISCOVERY_TTL: ChronoDuration = ChronoDuration::minutes(5);
pub(super) const OPERATION_TTL: ChronoDuration = ChronoDuration::minutes(10);
pub(super) const MAX_DISCOVERED_TARGETS: usize = 256;
pub(super) const MAX_PROJECTION_TEXT_BYTES: usize = 255;

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
    pub(super) fn validate(&self, expected_provider: LocalProvider) -> AppResult<()> {
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
pub(in super::super) struct ProvisioningDiscoveredTarget {
    pub(super) target: ProvisioningTarget,
}

impl ProvisioningDiscoveredTarget {
    pub(in super::super) fn new(target: ProvisioningTarget) -> Self {
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

pub(in super::super) enum ProvisioningInspection {
    Verified(ProvisioningVerification),
    Drift(ProvisioningRepairReason),
}

pub(in super::super) trait ProvisioningDriver: Send + Sync + 'static {
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
pub(in super::super) struct ProvisioningStepEvidence {
    pub(super) sequence: u16,
    execution_sha256: String,
}

impl ProvisioningStepEvidence {
    pub(in super::super) fn exact(step: &ProvisioningPlanStep) -> Self {
        Self {
            sequence: step.sequence(),
            execution_sha256: step.execution_sha256().to_owned(),
        }
    }

    pub(super) fn validates(&self, step: &ProvisioningPlanStep) -> bool {
        self.sequence == step.sequence() && self.execution_sha256 == step.execution_sha256()
    }
}

#[derive(Clone, Default)]
pub(crate) struct ProvisioningDriverRegistry {
    drivers: Arc<Vec<Arc<dyn ProvisioningDriver>>>,
}

impl ProvisioningDriverRegistry {
    #[cfg(test)]
    pub(in super::super) fn with_driver(driver: Arc<dyn ProvisioningDriver>) -> Self {
        Self {
            drivers: Arc::new(vec![driver]),
        }
    }

    pub(in super::super) fn with_drivers(
        drivers: impl IntoIterator<Item = Arc<dyn ProvisioningDriver>>,
    ) -> Self {
        Self {
            drivers: Arc::new(drivers.into_iter().collect()),
        }
    }

    pub(super) fn find(&self, provider: LocalProvider) -> Option<Arc<dyn ProvisioningDriver>> {
        self.drivers
            .iter()
            .find(|driver| driver.provider() == provider)
            .cloned()
    }

    pub(super) fn all(&self) -> impl Iterator<Item = Arc<dyn ProvisioningDriver>> + '_ {
        self.drivers.iter().cloned()
    }
}
