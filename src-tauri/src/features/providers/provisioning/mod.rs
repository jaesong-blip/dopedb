//! Provider-neutral managed-access provisioning contracts.
//!
//! Concrete Provider adapters may discover targets and translate these closed
//! actions into fixed CLI/API calls, but they cannot invent lifecycle states,
//! declare Managed Access ready early, or persist credential material here.

mod application;
mod domain;
mod gcp;
mod gcp_cli;
mod neon;
mod planetscale;
mod planetscale_cli;
mod process;
mod repository;
mod shared;
#[cfg(test)]
mod test_support;

pub(super) use application::{ProvisioningCoordinator, ProvisioningDriverRegistry};
pub(crate) use application::{
    ProvisioningDriverStatus, ProvisioningPlanProjection, ProvisioningTargetSummary,
};
pub(super) use gcp::GcpCloudSqlProvisioningDriver;
pub(super) use neon::NeonProvisioningDriver;
pub(super) use planetscale::PlanetScaleProvisioningDriver;
pub(super) use repository::ProvisioningRepository;

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
pub(crate) use domain::{ProvisioningAccessMode, ProvisioningReceipt, ProvisioningTarget};

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
