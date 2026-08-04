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
mod gcp;
#[allow(
    dead_code,
    reason = "the GCP CLI inventory is registered only after its complete #100 lifecycle lands"
)]
mod gcp_cli;
mod neon;
mod planetscale;
#[allow(
    dead_code,
    reason = "the PlanetScale CLI inventory is registered only after its complete #100 lifecycle lands"
)]
mod planetscale_cli;
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
#[cfg(test)]
mod test_support;

pub(super) use application::{ProvisioningCoordinator, ProvisioningDriverRegistry};
pub(crate) use application::{
    ProvisioningDriverStatus, ProvisioningPlanProjection, ProvisioningTargetSummary,
};
pub(super) use gcp::GcpCloudSqlProvisioningDriver;
pub(super) use neon::NeonProvisioningDriver;
pub(super) use planetscale::PlanetScaleProvisioningDriver;

pub(super) fn managed_provider_registry(
    planet_scale: PlanetScaleProvisioningDriver,
    gcp_cloud_sql: GcpCloudSqlProvisioningDriver,
    neon: NeonProvisioningDriver,
) -> ProvisioningDriverRegistry {
    ProvisioningDriverRegistry::with_drivers([
        std::sync::Arc::new(planet_scale) as std::sync::Arc<dyn application::ProvisioningDriver>,
        std::sync::Arc::new(gcp_cloud_sql) as std::sync::Arc<dyn application::ProvisioningDriver>,
        std::sync::Arc::new(neon) as std::sync::Arc<dyn application::ProvisioningDriver>,
    ])
}

/// Opaque one-step capability issued only while holding an executing Operation
/// grant whose payload hash matches the durable provisioning plan.
struct ProvisioningExecutionPermit {
    operation_id: uuid::Uuid,
    provider: super::domain::LocalProvider,
    plan_sha256: String,
    execution_sha256: String,
}

/// Process-local authority for Provider discovery commands. It is deliberately
/// distinct from [`ProvisioningExecutionPermit`]: discovery can observe only
/// machine-readable Provider inventory and can never authorize an apply/destroy
/// mutation or resume a durable Operation.
struct ProvisioningReadAuthority {
    provider: super::domain::LocalProvider,
    manifest_sha256: String,
}

impl ProvisioningReadAuthority {
    fn issue(provider: super::domain::LocalProvider, manifest_sha256: String) -> Self {
        Self {
            provider,
            manifest_sha256,
        }
    }
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
pub(crate) use gcp::assert_gcp_driver_contract;
#[cfg(test)]
pub(crate) use gcp::assert_gcp_driver_failure_contract;
#[cfg(test)]
pub(crate) use gcp_cli::{assert_gcloud_cli_contract, assert_live_gcloud_inventory};
#[cfg(test)]
pub(crate) use neon::assert_neon_driver_contract;
#[cfg(test)]
pub(crate) use neon::assert_neon_driver_failure_contract;
#[cfg(test)]
pub(crate) use planetscale::assert_planetscale_driver_contract;
#[cfg(test)]
pub(crate) use planetscale::assert_planetscale_driver_failure_contract;
#[cfg(test)]
pub(crate) use planetscale_cli::assert_planetscale_cli_contract;
#[cfg(test)]
pub(crate) use process::assert_process_boundary;
#[cfg(test)]
pub(crate) use repository::assert_repository_fences;
