//! Complete PlanetScale managed-access lifecycle.
//!
//! The official CLI proves the member's local OAuth visibility during discovery.
//! The workspace service owns provider API validation and credential revocation,
//! while the connection runtime opens one uncached short-lived lease for smoke
//! verification. No provider token or database password crosses this module.

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
use crate::model::{Engine, Provider, WorkspaceCredentialMode};
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
use super::planetscale_cli::{PlanetScaleInventory, PLANETSCALE_MANIFEST_SHA256};
use super::repository::ProvisioningRepository;
use super::shared::{blocked, ManagedProvisioningContract, ManagedProvisioningScaffold};
#[cfg(test)]
use super::shared::{
    execution_hash, full_capabilities, has_complete_smoke_plan, idempotency_key, ownership_marker,
    plan_steps,
};
use super::{ProvisioningExecutionPermit, ProvisioningReadAuthority};

const CONTRACT: ManagedProvisioningContract = ManagedProvisioningContract {
    local_provider: LocalProvider::PlanetScale,
    profile_provider: Provider::PlanetScale,
    manifest_sha256: PLANETSCALE_MANIFEST_SHA256,
    execution_contract: "dopedb-planetscale-provisioning-execution-v1",
    idempotency_contract: "dopedb-planetscale-provisioning-idempotency-v1",
    idempotency_prefix: "ps",
    display_name: "PlanetScale",
    include_safe_migrations: true,
};

#[derive(Clone)]
pub(crate) struct PlanetScaleProvisioningDriver {
    scaffold: ManagedProvisioningScaffold,
}

impl PlanetScaleProvisioningDriver {
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

impl ProvisioningDriver for PlanetScaleProvisioningDriver {
    fn provider(&self) -> LocalProvider {
        LocalProvider::PlanetScale
    }

    fn manifest_sha256(&self) -> &str {
        PLANETSCALE_MANIFEST_SHA256
    }

    fn detect<'a>(
        &'a self,
        authority: &'a ProvisioningReadAuthority,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningDriverStatus> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(blocked("PlanetScale detection was cancelled"));
            }
            PlanetScaleInventory::detect(authority, cancellation).await
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
                return Err(blocked("PlanetScale discovery was cancelled"));
            }
            let connection = self
                .scaffold
                .connection_for_discovery(connection_id)
                .await?;
            if connection.profile.provider != Provider::PlanetScale
                || connection.profile.credential_mode != WorkspaceCredentialMode::Managed
            {
                return Err(blocked("connection is not a managed PlanetScale target"));
            }
            let authorized = self.scaffold.authorize(&connection).await?;
            let AuthorizedProvisioningResource::PlanetScale {
                organization,
                database,
                branch,
                engine,
            } = &authorized.resource
            else {
                return Err(blocked("PlanetScale target authority is invalid"));
            };
            let inventory = PlanetScaleInventory::locate()
                .await
                .map_err(|_| blocked("PlanetScale CLI failed its executable boundary"))?
                .ok_or_else(|| blocked("PlanetScale CLI is unavailable"))?;
            let cli_target = inventory
                .discover_exact(
                    authority,
                    organization,
                    database,
                    branch,
                    *engine,
                    authorized.production,
                    cancellation,
                )
                .await?;
            if cli_target.branch_id != authorized.provider_audit_id
                || cli_target.safe_migrations != authorized.safe_migrations
                || (authorized.production
                    && *engine == Engine::Mysql
                    && authorized.safe_migrations != Some(true))
            {
                return Err(blocked(
                    "PlanetScale CLI branch identity differs from workspace authority",
                ));
            }
            let target = ProvisioningTarget::new(
                LocalProvider::PlanetScale,
                ConnectionId::from(authorized.connection_id),
                authorized.connection_revision,
                authorized.integration_id,
                authorized.integration_generation,
                authorized.resource_fingerprint,
                format!("{database} / {branch}"),
                format!("{organization} · PlanetScale"),
                BTreeMap::from([
                    (
                        ProvisioningTargetSelector::Account,
                        authorized.account_fingerprint,
                    ),
                    (
                        ProvisioningTargetSelector::Organization,
                        organization.clone(),
                    ),
                    (ProvisioningTargetSelector::Database, database.clone()),
                    (ProvisioningTargetSelector::Branch, branch.clone()),
                ]),
                *engine,
                authorized.production,
                authorized.safe_migrations,
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
    let AuthorizedProvisioningResource::PlanetScale {
        organization,
        database,
        branch,
        engine,
    } = &authority.resource
    else {
        return false;
    };
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
        && authority.production == target.production()
        && authority.safe_migrations == target.safe_migrations()
        && authority.write_available == target.write_available()
        && authority.display_name.len() <= 120
        && *engine == target.engine()
        && organization
            == target
                .selector(ProvisioningTargetSelector::Organization)
                .unwrap_or_default()
        && database
            == target
                .selector(ProvisioningTargetSelector::Database)
                .unwrap_or_default()
        && branch
            == target
                .selector(ProvisioningTargetSelector::Branch)
                .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn assert_planetscale_driver_contract() {
    let connection_id = Uuid::from_u128(801);
    let integration_id = Uuid::from_u128(802);
    let target = ProvisioningTarget::new(
        LocalProvider::PlanetScale,
        ConnectionId::from(connection_id),
        7,
        ProviderIntegrationId::from(integration_id),
        11,
        "ab".repeat(32),
        "app / main".into(),
        "acme · PlanetScale".into(),
        BTreeMap::from([
            (ProvisioningTargetSelector::Account, "cd".repeat(32)),
            (ProvisioningTargetSelector::Organization, "acme".into()),
            (ProvisioningTargetSelector::Database, "app".into()),
            (ProvisioningTargetSelector::Branch, "main".into()),
        ]),
        Engine::Postgres,
        false,
        None,
        true,
        "br-main-123".into(),
    )
    .unwrap();
    let authority = AuthorizedProvisioningTarget {
        connection_id,
        connection_revision: 7,
        integration_id: ProviderIntegrationId::from(integration_id),
        integration_generation: 11,
        provider: LocalProvider::PlanetScale,
        account_fingerprint: "cd".repeat(32),
        resource_fingerprint: "ab".repeat(32),
        display_name: "Workspace app".into(),
        resource: AuthorizedProvisioningResource::PlanetScale {
            organization: "acme".into(),
            database: "app".into(),
            branch: "main".into(),
            engine: Engine::Postgres,
        },
        write_available: true,
        production: false,
        safe_migrations: None,
        provider_audit_id: "br-main-123".into(),
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
        PLANETSCALE_MANIFEST_SHA256.into(),
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
    assert_eq!(plan.target().connection_revision(), 7);
    assert_eq!(plan.target().integration_generation(), 11);
    assert_ne!(
        execution_hash(
            CONTRACT,
            ProvisioningIntent::Apply,
            &target,
            ProvisioningAccessMode::Write,
            plan.ownership_marker(),
            ProvisioningAction::SmokeTestReadCredential,
            Some(ProvisioningAccessMode::Read),
        )
        .unwrap(),
        execution_hash(
            CONTRACT,
            ProvisioningIntent::Apply,
            &target,
            ProvisioningAccessMode::Write,
            plan.ownership_marker(),
            ProvisioningAction::SmokeTestWriteCredential,
            Some(ProvisioningAccessMode::Write),
        )
        .unwrap(),
    );
}

#[cfg(test)]
pub(crate) async fn assert_planetscale_driver_failure_contract() {
    use super::test_support::{
        assert_driver_failure_contract, fixture_connection, FixtureProvisioningRuntime,
        FixtureTargetAuthority,
    };

    let connection_id = Uuid::from_u128(801);
    let integration_id = Uuid::from_u128(802);
    let target = ProvisioningTarget::new(
        LocalProvider::PlanetScale,
        ConnectionId::from(connection_id),
        7,
        ProviderIntegrationId::from(integration_id),
        11,
        "ab".repeat(32),
        "app / main".into(),
        "acme · PlanetScale".into(),
        BTreeMap::from([
            (ProvisioningTargetSelector::Account, "cd".repeat(32)),
            (ProvisioningTargetSelector::Organization, "acme".into()),
            (ProvisioningTargetSelector::Database, "app".into()),
            (ProvisioningTargetSelector::Branch, "main".into()),
        ]),
        Engine::Postgres,
        false,
        None,
        true,
        "br-main-123".into(),
    )
    .unwrap();
    let authorized = AuthorizedProvisioningTarget {
        connection_id,
        connection_revision: 7,
        integration_id: ProviderIntegrationId::from(integration_id),
        integration_generation: 11,
        provider: LocalProvider::PlanetScale,
        account_fingerprint: "cd".repeat(32),
        resource_fingerprint: "ab".repeat(32),
        display_name: "Workspace app".into(),
        resource: AuthorizedProvisioningResource::PlanetScale {
            organization: "acme".into(),
            database: "app".into(),
            branch: "main".into(),
            engine: Engine::Postgres,
        },
        write_available: true,
        production: false,
        safe_migrations: None,
        provider_audit_id: "br-main-123".into(),
        expires_at: Utc::now() + chrono::Duration::minutes(5),
    };
    let store = Store::in_memory_for_test()
        .await
        .expect("open PlanetScale driver contract store");
    let connection = fixture_connection(&store, &target, Provider::PlanetScale).await;
    let authority = Arc::new(FixtureTargetAuthority::new(authorized));
    let runtime = Arc::new(FixtureProvisioningRuntime::new(&target));
    let driver = PlanetScaleProvisioningDriver::new(
        ProvisioningRepository::new(store),
        authority.clone(),
        runtime.clone(),
    );
    assert_driver_failure_contract(&driver, &target, &connection, authority, runtime).await;
}
