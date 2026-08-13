//! Neon managed-access lifecycle backed by the workspace integration.
//!
//! Neon has no member-local login prerequisite: the encrypted project-scoped
//! API key remains in the workspace service. Every discovery, apply, drift
//! inspection, and destroy revalidates that server-owned authority. The desktop
//! receives only a secret-free target pin and one uncached short database lease.

use std::collections::BTreeMap;
use std::sync::Arc;

#[cfg(test)]
use chrono::Utc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::AppResult;
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
    ProvisioningInspection, ProvisioningPrerequisiteKind, ProvisioningReadiness,
    ProvisioningStepEvidence,
};
use super::domain::{
    ProvisioningAccessMode, ProvisioningPlan, ProvisioningPlanStep, ProvisioningReceipt,
    ProvisioningTarget, ProvisioningTargetSelector, ProvisioningVerification,
};
#[cfg(test)]
use super::domain::{ProvisioningAction, ProvisioningIntent};
use super::repository::ProvisioningRepository;
use super::shared::{blocked, ManagedProvisioningContract, ManagedProvisioningScaffold};
#[cfg(test)]
use super::shared::{
    execution_hash, full_capabilities, has_complete_smoke_plan, idempotency_key, ownership_marker,
    plan_steps,
};
use super::{ProvisioningExecutionPermit, ProvisioningReadAuthority};

pub(super) const NEON_MANIFEST_SHA256: &str =
    "2b4da5e4858086217b00a35e6ed53b2e826c34a90cbfc51ce889b27e8cdfd7b0";

const CONTRACT: ManagedProvisioningContract = ManagedProvisioningContract {
    local_provider: LocalProvider::Neon,
    profile_provider: Provider::Neon,
    manifest_sha256: NEON_MANIFEST_SHA256,
    execution_contract: "dopedb-neon-provisioning-execution-v1",
    idempotency_contract: "dopedb-neon-provisioning-idempotency-v1",
    idempotency_prefix: "neon",
    display_name: "Neon",
    include_safe_migrations: false,
};

#[derive(Clone)]
pub(crate) struct NeonProvisioningDriver {
    scaffold: ManagedProvisioningScaffold,
}

impl NeonProvisioningDriver {
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

impl ProvisioningDriver for NeonProvisioningDriver {
    fn provider(&self) -> LocalProvider {
        LocalProvider::Neon
    }

    fn manifest_sha256(&self) -> &str {
        NEON_MANIFEST_SHA256
    }

    fn detect<'a>(
        &'a self,
        authority: &'a ProvisioningReadAuthority,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningDriverStatus> {
        Box::pin(async move {
            ensure_authority(authority)?;
            if cancellation.is_cancelled() {
                return Err(blocked("Neon prerequisite detection was cancelled"));
            }
            Ok(ProvisioningDriverStatus {
                provider: LocalProvider::Neon,
                prerequisite_kind: ProvisioningPrerequisiteKind::WorkspaceIntegration,
                prerequisite_name: "Workspace integration".into(),
                minimum_version: None,
                installed_version: None,
                active_identity: None,
                readiness: ProvisioningReadiness::Ready,
            })
        })
    }

    fn discover<'a>(
        &'a self,
        connection_id: Uuid,
        authority: &'a ProvisioningReadAuthority,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, Vec<ProvisioningDiscoveredTarget>> {
        Box::pin(async move {
            ensure_authority(authority)?;
            if cancellation.is_cancelled() {
                return Err(blocked("Neon discovery was cancelled"));
            }
            let connection = self
                .scaffold
                .connection_for_discovery(connection_id)
                .await?;
            if connection.profile.provider != Provider::Neon
                || connection.profile.credential_mode != WorkspaceCredentialMode::Managed
            {
                return Err(blocked("connection is not a managed Neon target"));
            }
            // POST preparation performs live project/branch/database/endpoint and
            // owner/delegation checks using only the server-held integration key.
            let authorized = self.scaffold.authorize(&connection).await?;
            let AuthorizedProvisioningResource::Neon {
                project,
                branch,
                database_id: _,
                database,
                schemas,
            } = &authorized.resource
            else {
                return Err(blocked("Neon target authority is invalid"));
            };
            if schemas.is_empty() {
                return Err(blocked("Neon target policy is invalid"));
            }
            let target = ProvisioningTarget::new(
                LocalProvider::Neon,
                ConnectionId::from(authorized.connection_id),
                authorized.connection_revision,
                authorized.integration_id,
                authorized.integration_generation,
                authorized.resource_fingerprint,
                format!("{branch} / {database}"),
                format!("{project} · Neon"),
                BTreeMap::from([
                    (
                        ProvisioningTargetSelector::Account,
                        authorized.account_fingerprint,
                    ),
                    (ProvisioningTargetSelector::Project, project.clone()),
                    (ProvisioningTargetSelector::Branch, branch.clone()),
                    (ProvisioningTargetSelector::Database, database.clone()),
                ]),
                connection.profile.engine,
                authorized.production,
                None,
                authorized.write_available,
                authorized.provider_audit_id,
            )?;
            if cancellation.is_cancelled() {
                return Err(blocked("Neon discovery was cancelled"));
            }
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

fn ensure_authority(authority: &ProvisioningReadAuthority) -> AppResult<()> {
    if authority.provider != LocalProvider::Neon
        || authority.manifest_sha256 != NEON_MANIFEST_SHA256
    {
        return Err(blocked("Neon discovery authority is invalid"));
    }
    Ok(())
}

fn target_matches_authority(
    target: &ProvisioningTarget,
    authority: &AuthorizedProvisioningTarget,
) -> bool {
    let AuthorizedProvisioningResource::Neon {
        project,
        branch,
        database_id: _,
        database,
        schemas,
    } = &authority.resource
    else {
        return false;
    };
    !schemas.is_empty()
        && authority.connection_id == Uuid::from(target.connection_id())
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
        && authority.safe_migrations.is_none()
        && authority.write_available == target.write_available()
        && authority.display_name.len() <= 120
        && target.engine() == crate::model::Engine::Postgres
        && project
            == target
                .selector(ProvisioningTargetSelector::Project)
                .unwrap_or_default()
        && branch
            == target
                .selector(ProvisioningTargetSelector::Branch)
                .unwrap_or_default()
        && database
            == target
                .selector(ProvisioningTargetSelector::Database)
                .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn assert_neon_driver_contract() {
    let connection_id = Uuid::from_u128(1_001);
    let integration_id = Uuid::from_u128(1_002);
    let target = ProvisioningTarget::new(
        LocalProvider::Neon,
        ConnectionId::from(connection_id),
        13,
        ProviderIntegrationId::from(integration_id),
        17,
        "ab".repeat(32),
        "br-dev / app".into(),
        "quiet-sun · Neon".into(),
        BTreeMap::from([
            (ProvisioningTargetSelector::Account, "cd".repeat(32)),
            (ProvisioningTargetSelector::Project, "quiet-sun".into()),
            (ProvisioningTargetSelector::Branch, "br-dev".into()),
            (ProvisioningTargetSelector::Database, "app".into()),
        ]),
        Engine::Postgres,
        false,
        None,
        true,
        "br-dev:834686".into(),
    )
    .unwrap();
    let authority = AuthorizedProvisioningTarget {
        connection_id,
        connection_revision: 13,
        integration_id: ProviderIntegrationId::from(integration_id),
        integration_generation: 17,
        provider: LocalProvider::Neon,
        account_fingerprint: "cd".repeat(32),
        resource_fingerprint: "ab".repeat(32),
        display_name: "Workspace app".into(),
        resource: AuthorizedProvisioningResource::Neon {
            project: "quiet-sun".into(),
            branch: "br-dev".into(),
            database_id: "834686".into(),
            database: "app".into(),
            schemas: vec!["public".into()],
        },
        write_available: true,
        production: false,
        safe_migrations: None,
        provider_audit_id: "br-dev:834686".into(),
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
        NEON_MANIFEST_SHA256.into(),
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
    assert_eq!(plan.target().connection_revision(), 13);
    assert_eq!(plan.target().integration_generation(), 17);
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
pub(crate) async fn assert_neon_driver_failure_contract() {
    use super::test_support::{
        assert_driver_failure_contract, fixture_connection, FixtureProvisioningRuntime,
        FixtureTargetAuthority,
    };

    let connection_id = Uuid::from_u128(1_001);
    let integration_id = Uuid::from_u128(1_002);
    let target = ProvisioningTarget::new(
        LocalProvider::Neon,
        ConnectionId::from(connection_id),
        13,
        ProviderIntegrationId::from(integration_id),
        17,
        "ab".repeat(32),
        "br-dev / app".into(),
        "quiet-sun · Neon".into(),
        BTreeMap::from([
            (ProvisioningTargetSelector::Account, "cd".repeat(32)),
            (ProvisioningTargetSelector::Project, "quiet-sun".into()),
            (ProvisioningTargetSelector::Branch, "br-dev".into()),
            (ProvisioningTargetSelector::Database, "app".into()),
        ]),
        Engine::Postgres,
        false,
        None,
        true,
        "br-dev:834686".into(),
    )
    .unwrap();
    let authorized = AuthorizedProvisioningTarget {
        connection_id,
        connection_revision: 13,
        integration_id: ProviderIntegrationId::from(integration_id),
        integration_generation: 17,
        provider: LocalProvider::Neon,
        account_fingerprint: "cd".repeat(32),
        resource_fingerprint: "ab".repeat(32),
        display_name: "Workspace app".into(),
        resource: AuthorizedProvisioningResource::Neon {
            project: "quiet-sun".into(),
            branch: "br-dev".into(),
            database_id: "834686".into(),
            database: "app".into(),
            schemas: vec!["public".into()],
        },
        write_available: true,
        production: false,
        safe_migrations: None,
        provider_audit_id: "br-dev:834686".into(),
        expires_at: Utc::now() + chrono::Duration::minutes(5),
    };
    let store = Store::in_memory_for_test()
        .await
        .expect("open Neon driver contract store");
    let connection = fixture_connection(&store, &target, Provider::Neon).await;
    let authority = Arc::new(FixtureTargetAuthority::new(authorized));
    let runtime = Arc::new(FixtureProvisioningRuntime::new(&target));
    let driver = NeonProvisioningDriver::new(
        ProvisioningRepository::new(store),
        authority.clone(),
        runtime.clone(),
    );
    assert_driver_failure_contract(&driver, &target, &connection, authority, runtime).await;
}
