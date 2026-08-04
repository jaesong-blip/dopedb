//! Provider-neutral managed-access provisioning contracts.
//!
//! Concrete Provider adapters may discover targets and translate these closed
//! actions into fixed CLI/API calls, but they cannot invent lifecycle states,
//! declare Managed Access ready early, or persist credential material here.

#[allow(
    dead_code,
    reason = "the provider-neutral lifecycle is consumed by the concrete adapters landing in #100"
)]
mod application;
#[allow(
    dead_code,
    reason = "the closed provisioning contracts are consumed by the concrete adapters landing in #100"
)]
mod domain;
#[allow(
    dead_code,
    reason = "the fixed CLI runner is consumed by the concrete adapters landing in #100"
)]
mod process;
#[allow(
    dead_code,
    reason = "plan creation and target lookup are consumed by the concrete adapters landing in #100"
)]
mod repository;

pub(super) use application::{ProvisioningCoordinator, ProvisioningDriverRegistry};
pub(crate) use application::{
    ProvisioningDriverStatus, ProvisioningPlanProjection, ProvisioningTargetSummary,
};

/// Opaque one-step capability issued only while holding an executing Operation
/// grant whose payload hash matches the durable provisioning plan.
struct ProvisioningExecutionPermit {
    operation_id: uuid::Uuid,
    provider: super::domain::LocalProvider,
    plan_sha256: String,
    execution_sha256: String,
}

impl ProvisioningExecutionPermit {
    fn issue(
        operation_id: uuid::Uuid,
        provider: super::domain::LocalProvider,
        plan_sha256: String,
        execution_sha256: String,
    ) -> Self {
        Self {
            operation_id,
            provider,
            plan_sha256,
            execution_sha256,
        }
    }
}
#[allow(
    unused_imports,
    reason = "the provider-neutral API surface is consumed by the concrete adapters landing in #100"
)]
pub(crate) use domain::{
    ManagedAccessCapability, ProvisioningAccessMode, ProvisioningAction,
    ProvisioningCapabilityManifest, ProvisioningIntent, ProvisioningPhase, ProvisioningPlan,
    ProvisioningPlanStep, ProvisioningReceipt, ProvisioningRepairReason, ProvisioningState,
    ProvisioningTarget, ProvisioningTargetSelector, ProvisioningVerification,
};
#[allow(
    unused_imports,
    reason = "the fixed CLI API surface is consumed by the concrete adapters landing in #100"
)]
pub(crate) use process::{
    ProvisioningCliCommand, ProvisioningCliEnvironment, ProvisioningCliOutput,
    ProvisioningCliOutputSchema, ProvisioningExecutableIdentity, ProvisioningProcessFailure,
};

#[cfg(test)]
pub(crate) use application::assert_restart_resume_lifecycle;
#[cfg(test)]
pub(crate) use domain::assert_mock_provider_lifecycle;
#[cfg(test)]
pub(crate) use process::assert_process_boundary;
#[cfg(test)]
pub(crate) use repository::assert_repository_fences;
