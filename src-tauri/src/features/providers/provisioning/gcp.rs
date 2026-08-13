//! Complete GCP Cloud SQL managed-access verification lifecycle.
//!
//! The workspace setup flow owns keyless WIF and least-privilege database
//! bootstrap. The official `gcloud` CLI independently proves the member-visible
//! project/instance/database identity, while the connection runtime validates
//! one uncached short-lived Read or Write lease. No Google token or database
//! credential crosses this module.

use std::collections::BTreeMap;
use std::sync::Arc;

#[cfg(test)]
use chrono::Utc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::features::providers::adapters::{
    AuthorizedProvisioningResource, AuthorizedProvisioningTarget, ProvisioningTargetAuthorityPort,
};
use crate::features::providers::ports::ProvisioningRuntimePort;
use crate::kernel::identity::ConnectionId;
#[cfg(test)]
use crate::kernel::identity::ProviderIntegrationId;
#[cfg(test)]
use crate::model::Engine;
use crate::model::{Provider, WorkspaceCredentialMode};
use crate::store::PinnedConnection;
#[cfg(test)]
use crate::store::Store;

use super::super::domain::LocalProvider;
use super::application::{
    DriverFuture, ProvisioningDiscoveredTarget, ProvisioningDriver, ProvisioningDriverStatus,
    ProvisioningInspection, ProvisioningStepEvidence,
};
use super::domain::{
    ProvisioningAccessMode, ProvisioningPlan, ProvisioningPlanStep, ProvisioningReceipt,
    ProvisioningTarget, ProvisioningTargetSelector, ProvisioningVerification,
};
#[cfg(test)]
use super::domain::{ProvisioningAction, ProvisioningIntent};
use super::gcp_cli::{GcloudExactTarget, GcloudInventory, GCP_MANIFEST_SHA256};
use super::repository::ProvisioningRepository;
use super::shared::{blocked, ManagedProvisioningContract, ManagedProvisioningScaffold};
#[cfg(test)]
use super::shared::{
    full_capabilities, has_complete_smoke_plan, idempotency_key, ownership_marker, plan_steps,
};
use super::{ProvisioningExecutionPermit, ProvisioningReadAuthority};

const CONTRACT: ManagedProvisioningContract = ManagedProvisioningContract {
    local_provider: LocalProvider::GcpCloudSql,
    profile_provider: Provider::GcpCloudSql,
    manifest_sha256: GCP_MANIFEST_SHA256,
    execution_contract: "dopedb-gcp-cloud-sql-provisioning-execution-v1",
    idempotency_contract: "dopedb-gcp-cloud-sql-provisioning-idempotency-v1",
    idempotency_prefix: "gcp",
    display_name: "GCP Cloud SQL",
    include_safe_migrations: false,
};

#[derive(Clone)]
pub(crate) struct GcpCloudSqlProvisioningDriver {
    scaffold: ManagedProvisioningScaffold,
}

impl GcpCloudSqlProvisioningDriver {
    pub(crate) fn new(
        repository: ProvisioningRepository,
        target_authority: Arc<dyn ProvisioningTargetAuthorityPort>,
        runtime: Arc<dyn ProvisioningRuntimePort>,
    ) -> Self {
        Self {
            scaffold: ManagedProvisioningScaffold::new(
                CONTRACT,
                repository,
                target_authority,
                runtime,
                target_matches_authority,
            ),
        }
    }
}

impl ProvisioningDriver for GcpCloudSqlProvisioningDriver {
    fn provider(&self) -> LocalProvider {
        LocalProvider::GcpCloudSql
    }

    fn manifest_sha256(&self) -> &str {
        GCP_MANIFEST_SHA256
    }

    fn detect<'a>(
        &'a self,
        authority: &'a ProvisioningReadAuthority,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningDriverStatus> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(blocked("GCP Cloud SQL detection was cancelled"));
            }
            GcloudInventory::detect(authority, None, cancellation).await
        })
    }

    fn discover<'a>(
        &'a self,
        connection_id: Uuid,
        authority: &'a ProvisioningReadAuthority,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, Vec<ProvisioningDiscoveredTarget>> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(blocked("GCP Cloud SQL discovery was cancelled"));
            }
            let connection = self
                .scaffold
                .connection_for_discovery(connection_id)
                .await?;
            if connection.profile.provider != Provider::GcpCloudSql
                || connection.profile.credential_mode != WorkspaceCredentialMode::Managed
            {
                return Err(blocked("connection is not a managed GCP Cloud SQL target"));
            }
            let authorized = self.scaffold.authorize(&connection).await?;
            let AuthorizedProvisioningResource::GcpCloudSql {
                project,
                instance,
                database,
                engine,
                network_mode: _,
            } = &authorized.resource
            else {
                return Err(blocked("GCP Cloud SQL target authority is invalid"));
            };
            let inventory = GcloudInventory::locate()
                .await
                .map_err(|_| blocked("gcloud failed its executable boundary"))?
                .ok_or_else(|| blocked("Google Cloud CLI is unavailable"))?;
            let cli_target = inventory
                .discover_exact(
                    authority,
                    GcloudExactTarget {
                        project,
                        instance,
                        database,
                        engine: *engine,
                        production: authorized.production,
                    },
                    cancellation,
                )
                .await?;
            if cli_target.connection_name != authorized.provider_audit_id {
                return Err(blocked(
                    "gcloud instance identity differs from workspace authority",
                ));
            }
            let target = ProvisioningTarget::new(
                LocalProvider::GcpCloudSql,
                ConnectionId::from(authorized.connection_id),
                authorized.connection_revision,
                authorized.integration_id,
                authorized.integration_generation,
                authorized.resource_fingerprint,
                format!("{instance} / {database}"),
                format!("{project} · {}", cli_target.region),
                BTreeMap::from([
                    (
                        ProvisioningTargetSelector::Account,
                        authorized.account_fingerprint,
                    ),
                    (ProvisioningTargetSelector::Project, project.clone()),
                    (ProvisioningTargetSelector::Region, cli_target.region),
                    (ProvisioningTargetSelector::Instance, instance.clone()),
                    (ProvisioningTargetSelector::Database, database.clone()),
                ]),
                *engine,
                authorized.production,
                None,
                authorized.write_available,
                authorized.provider_audit_id,
            )?;
            Ok(vec![ProvisioningDiscoveredTarget::new(target)])
        })
    }

    fn plan_apply<'a>(
        &'a self,
        target: &'a ProvisioningTarget,
        connection: &'a PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningPlan> {
        Box::pin(
            self.scaffold
                .plan_apply(target, connection, access, cancellation),
        )
    }

    fn plan_destroy<'a>(
        &'a self,
        receipt: &'a ProvisioningReceipt,
        target: &'a ProvisioningTarget,
        connection: &'a PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, (ProvisioningPlan, String)> {
        Box::pin(
            self.scaffold
                .plan_destroy(receipt, target, connection, access, cancellation),
        )
    }

    fn plan_repair<'a>(
        &'a self,
        receipt: &'a ProvisioningReceipt,
        target: &'a ProvisioningTarget,
        connection: &'a PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningPlan> {
        Box::pin(
            self.scaffold
                .plan_repair(receipt, target, connection, access, cancellation),
        )
    }

    fn inspect<'a>(
        &'a self,
        plan: &'a ProvisioningPlan,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningInspection> {
        Box::pin(self.scaffold.inspect(plan, cancellation))
    }

    fn execute_step<'a>(
        &'a self,
        plan: &'a ProvisioningPlan,
        step: &'a ProvisioningPlanStep,
        permit: &'a ProvisioningExecutionPermit,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningStepEvidence> {
        Box::pin(self.scaffold.execute_step(plan, step, permit, cancellation))
    }

    fn verify<'a>(
        &'a self,
        plan: &'a ProvisioningPlan,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningVerification> {
        Box::pin(self.scaffold.verify(plan, cancellation))
    }
}

fn target_matches_authority(
    target: &ProvisioningTarget,
    authority: &AuthorizedProvisioningTarget,
) -> bool {
    let AuthorizedProvisioningResource::GcpCloudSql {
        project,
        instance,
        database,
        engine,
        network_mode: _,
    } = &authority.resource
    else {
        return false;
    };
    let region = target
        .selector(ProvisioningTargetSelector::Region)
        .unwrap_or_default();
    authority.connection_id == Uuid::from(target.connection_id())
        && authority.connection_revision == target.connection_revision()
        && authority.integration_id == target.integration_id()
        && authority.integration_generation == target.integration_generation()
        && authority.provider == target.provider()
        && authority.account_fingerprint
            == target
                .selector(ProvisioningTargetSelector::Account)
                .unwrap_or_default()
        && authority.resource_fingerprint == target.resource_fingerprint()
        && authority.provider_audit_id == target.provider_audit_id()
        && authority.provider_audit_id == format!("{project}:{region}:{instance}")
        && authority.production == target.production()
        && authority.safe_migrations.is_none()
        && authority.write_available == target.write_available()
        && authority.display_name.len() <= 120
        && *engine == target.engine()
        && project
            == target
                .selector(ProvisioningTargetSelector::Project)
                .unwrap_or_default()
        && instance
            == target
                .selector(ProvisioningTargetSelector::Instance)
                .unwrap_or_default()
        && database
            == target
                .selector(ProvisioningTargetSelector::Database)
                .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn assert_gcp_driver_contract() {
    let connection_id = Uuid::from_u128(901);
    let integration_id = Uuid::from_u128(902);
    let target = ProvisioningTarget::new(
        LocalProvider::GcpCloudSql,
        ConnectionId::from(connection_id),
        5,
        ProviderIntegrationId::from(integration_id),
        9,
        "ab".repeat(32),
        "app-db / app".into(),
        "sample-project-123 · asia-northeast3".into(),
        BTreeMap::from([
            (ProvisioningTargetSelector::Account, "cd".repeat(32)),
            (
                ProvisioningTargetSelector::Project,
                "sample-project-123".into(),
            ),
            (ProvisioningTargetSelector::Region, "asia-northeast3".into()),
            (ProvisioningTargetSelector::Instance, "app-db".into()),
            (ProvisioningTargetSelector::Database, "app".into()),
        ]),
        Engine::Postgres,
        false,
        None,
        true,
        "sample-project-123:asia-northeast3:app-db".into(),
    )
    .unwrap();
    let authority = AuthorizedProvisioningTarget {
        connection_id,
        connection_revision: 5,
        integration_id: ProviderIntegrationId::from(integration_id),
        integration_generation: 9,
        provider: LocalProvider::GcpCloudSql,
        account_fingerprint: "cd".repeat(32),
        resource_fingerprint: "ab".repeat(32),
        display_name: "Workspace app".into(),
        resource: AuthorizedProvisioningResource::GcpCloudSql {
            project: "sample-project-123".into(),
            instance: "app-db".into(),
            database: "app".into(),
            engine: Engine::Postgres,
            network_mode: "PUBLIC".into(),
        },
        write_available: true,
        production: false,
        safe_migrations: None,
        provider_audit_id: "sample-project-123:asia-northeast3:app-db".into(),
        expires_at: Utc::now() + chrono::Duration::minutes(5),
    };
    assert!(target_matches_authority(&target, &authority));

    let marker = ownership_marker(CONTRACT, &target);
    let steps = plan_steps(
        CONTRACT,
        ProvisioningIntent::Apply,
        &target,
        ProvisioningAccessMode::Write,
        &marker,
        vec![
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
    )
    .unwrap();
    let plan = ProvisioningPlan::new(
        ProvisioningIntent::Apply,
        GCP_MANIFEST_SHA256.into(),
        target.clone(),
        ProvisioningAccessMode::Write,
        full_capabilities(),
        steps,
        marker,
        idempotency_key(
            CONTRACT,
            "apply",
            &target,
            ProvisioningAccessMode::Write,
            "fixture",
        )
        .unwrap(),
    )
    .unwrap();
    assert!(has_complete_smoke_plan(&plan));
    assert_eq!(plan.target().connection_revision(), 5);
    assert_eq!(plan.target().integration_generation(), 9);
}

#[cfg(test)]
pub(crate) async fn assert_gcp_driver_failure_contract() {
    use super::test_support::{
        assert_driver_failure_contract, fixture_connection, FixtureProvisioningRuntime,
        FixtureTargetAuthority,
    };

    let connection_id = Uuid::from_u128(901);
    let integration_id = Uuid::from_u128(902);
    let target = ProvisioningTarget::new(
        LocalProvider::GcpCloudSql,
        ConnectionId::from(connection_id),
        5,
        ProviderIntegrationId::from(integration_id),
        9,
        "ab".repeat(32),
        "app-db / app".into(),
        "sample-project-123 · asia-northeast3".into(),
        BTreeMap::from([
            (ProvisioningTargetSelector::Account, "cd".repeat(32)),
            (
                ProvisioningTargetSelector::Project,
                "sample-project-123".into(),
            ),
            (ProvisioningTargetSelector::Region, "asia-northeast3".into()),
            (ProvisioningTargetSelector::Instance, "app-db".into()),
            (ProvisioningTargetSelector::Database, "app".into()),
        ]),
        Engine::Postgres,
        false,
        None,
        true,
        "sample-project-123:asia-northeast3:app-db".into(),
    )
    .unwrap();
    let authorized = AuthorizedProvisioningTarget {
        connection_id,
        connection_revision: 5,
        integration_id: ProviderIntegrationId::from(integration_id),
        integration_generation: 9,
        provider: LocalProvider::GcpCloudSql,
        account_fingerprint: "cd".repeat(32),
        resource_fingerprint: "ab".repeat(32),
        display_name: "Workspace app".into(),
        resource: AuthorizedProvisioningResource::GcpCloudSql {
            project: "sample-project-123".into(),
            instance: "app-db".into(),
            database: "app".into(),
            engine: Engine::Postgres,
            network_mode: "PUBLIC".into(),
        },
        write_available: true,
        production: false,
        safe_migrations: None,
        provider_audit_id: "sample-project-123:asia-northeast3:app-db".into(),
        expires_at: Utc::now() + chrono::Duration::minutes(5),
    };
    let store = Store::in_memory_for_test()
        .await
        .expect("open GCP driver contract store");
    let connection = fixture_connection(&store, &target, Provider::GcpCloudSql).await;
    let authority = Arc::new(FixtureTargetAuthority::new(authorized));
    let runtime = Arc::new(FixtureProvisioningRuntime::new(&target));
    let driver = GcpCloudSqlProvisioningDriver::new(
        ProvisioningRepository::new(store),
        authority.clone(),
        runtime.clone(),
    );
    assert_driver_failure_contract(&driver, &target, &connection, authority, runtime).await;
}
