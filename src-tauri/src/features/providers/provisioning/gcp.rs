//! Complete GCP Cloud SQL managed-access verification lifecycle.
//!
//! The workspace setup flow owns keyless WIF and least-privilege database
//! bootstrap. The official `gcloud` CLI independently proves the member-visible
//! project/instance/database identity, while the connection runtime validates
//! one uncached short-lived Read or Write lease. No Google token or database
//! credential crosses this module.

use std::collections::BTreeMap;
use std::sync::Arc;

use chrono::Utc;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
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
use crate::operations::canonical_hash;
use crate::store::{PinnedConnection, Store};

use super::super::domain::LocalProvider;
use super::application::{
    DriverFuture, ProvisioningDiscoveredTarget, ProvisioningDriver, ProvisioningDriverStatus,
    ProvisioningInspection, ProvisioningStepEvidence,
};
use super::domain::{
    ManagedAccessCapability, ProvisioningAccessMode, ProvisioningAction,
    ProvisioningCapabilityManifest, ProvisioningIntent, ProvisioningPhase, ProvisioningPlan,
    ProvisioningPlanStep, ProvisioningReceipt, ProvisioningRepairReason, ProvisioningTarget,
    ProvisioningTargetSelector, ProvisioningVerification,
};
use super::gcp_cli::{GcloudExactTarget, GcloudInventory, GCP_MANIFEST_SHA256};
use super::{ProvisioningExecutionPermit, ProvisioningReadAuthority};

#[derive(Clone)]
pub(crate) struct GcpCloudSqlProvisioningDriver {
    store: Store,
    target_authority: Arc<dyn ProvisioningTargetAuthorityPort>,
    runtime: Arc<dyn ProvisioningRuntimePort>,
}

impl GcpCloudSqlProvisioningDriver {
    pub(crate) fn new(
        store: Store,
        target_authority: Arc<dyn ProvisioningTargetAuthorityPort>,
        runtime: Arc<dyn ProvisioningRuntimePort>,
    ) -> Self {
        Self {
            store,
            target_authority,
            runtime,
        }
    }

    async fn pinned_connection(&self, target: &ProvisioningTarget) -> AppResult<PinnedConnection> {
        let connection = self
            .store
            .pin_connection_for_view(Uuid::from(target.connection_id()))
            .await?;
        validate_connection(target, &connection)?;
        Ok(connection)
    }

    async fn cleanup_connection(&self, target: &ProvisioningTarget) -> AppResult<PinnedConnection> {
        let connection = self
            .store
            .pin_connection_for_view(Uuid::from(target.connection_id()))
            .await?;
        validate_cleanup_connection(target, &connection)?;
        Ok(connection)
    }

    async fn target_status(
        &self,
        target: &ProvisioningTarget,
    ) -> AppResult<(PinnedConnection, bool)> {
        let connection = self.pinned_connection(target).await?;
        let authorized = self.target_authority.target(&connection).await?;
        let current = target_matches_authority(target, &authorized);
        Ok((connection, current))
    }

    async fn revalidate_target(&self, target: &ProvisioningTarget) -> AppResult<PinnedConnection> {
        let (connection, current) = self.target_status(target).await?;
        if !current {
            return Err(blocked("GCP Cloud SQL managed target changed"));
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
                LocalProvider::GcpCloudSql,
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
            return Err(blocked("GCP Cloud SQL managed write access is unavailable"));
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
        let ownership_marker = ownership_marker(target);
        let steps = plan_steps(
            ProvisioningIntent::Apply,
            target,
            access,
            &ownership_marker,
            actions,
        )?;
        ProvisioningPlan::new(
            ProvisioningIntent::Apply,
            GCP_MANIFEST_SHA256.into(),
            target.clone(),
            access,
            full_capabilities(),
            steps,
            ownership_marker,
            idempotency_key("apply", target, access, discriminator)?,
        )
    }

    fn build_destroy_plan(
        &self,
        target: &ProvisioningTarget,
        access: ProvisioningAccessMode,
        ownership_marker: String,
        discriminator: &str,
    ) -> AppResult<ProvisioningPlan> {
        let steps = plan_steps(
            ProvisioningIntent::Destroy,
            target,
            access,
            &ownership_marker,
            vec![(ProvisioningAction::RevokeIssuedCredentials, None)],
        )?;
        ProvisioningPlan::new(
            ProvisioningIntent::Destroy,
            GCP_MANIFEST_SHA256.into(),
            target.clone(),
            access,
            full_capabilities(),
            steps,
            ownership_marker,
            idempotency_key("destroy", target, access, discriminator)?,
        )
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
            let connection = self.store.pin_connection_for_view(connection_id).await?;
            if connection.profile.provider != Provider::GcpCloudSql
                || connection.profile.credential_mode != WorkspaceCredentialMode::Managed
            {
                return Err(blocked("connection is not a managed GCP Cloud SQL target"));
            }
            let authorized = self.target_authority.target(&connection).await?;
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
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(blocked("GCP Cloud SQL planning was cancelled"));
            }
            validate_connection(target, connection)?;
            let authorized = self.target_authority.target(connection).await?;
            if !target_matches_authority(target, &authorized) {
                return Err(blocked("GCP Cloud SQL target changed before planning"));
            }
            if access == ProvisioningAccessMode::Write && !connection.profile.allow_writes {
                return Err(blocked("GCP Cloud SQL connection does not allow writes"));
            }
            self.build_apply_plan(target, access, "initial")
        })
    }

    fn plan_destroy<'a>(
        &'a self,
        receipt: &'a ProvisioningReceipt,
        target: &'a ProvisioningTarget,
        connection: &'a PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, (ProvisioningPlan, String)> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(blocked("GCP Cloud SQL destroy planning was cancelled"));
            }
            validate_cleanup_connection(target, connection)?;
            if receipt.provider() != LocalProvider::GcpCloudSql
                || receipt.connection_id() != target.connection_id()
                || receipt.target_fingerprint() != target.resource_fingerprint()
                || receipt.ownership_marker() != ownership_marker(target)
            {
                return Err(blocked("GCP Cloud SQL destroy receipt is invalid"));
            }
            let marker = receipt.ownership_marker().to_owned();
            let plan =
                self.build_destroy_plan(target, access, marker.clone(), &receipt.id().to_string())?;
            Ok((plan, marker))
        })
    }

    fn plan_repair<'a>(
        &'a self,
        receipt: &'a ProvisioningReceipt,
        target: &'a ProvisioningTarget,
        connection: &'a PinnedConnection,
        access: ProvisioningAccessMode,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningPlan> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(blocked("GCP Cloud SQL repair planning was cancelled"));
            }
            validate_connection(target, connection)?;
            if receipt.provider() != LocalProvider::GcpCloudSql
                || receipt.ownership_marker() != ownership_marker(target)
            {
                return Err(blocked("GCP Cloud SQL repair receipt is invalid"));
            }
            let authorized = self.target_authority.target(connection).await?;
            if !target_matches_authority(target, &authorized) {
                return Err(blocked("GCP Cloud SQL target must be rediscovered"));
            }
            self.build_apply_plan(target, access, &receipt.id().to_string())
        })
    }

    fn inspect<'a>(
        &'a self,
        plan: &'a ProvisioningPlan,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningInspection> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(blocked("GCP Cloud SQL inspection was cancelled"));
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
        })
    }

    fn execute_step<'a>(
        &'a self,
        plan: &'a ProvisioningPlan,
        step: &'a ProvisioningPlanStep,
        permit: &'a ProvisioningExecutionPermit,
        cancellation: &'a CancellationToken,
    ) -> DriverFuture<'a, ProvisioningStepEvidence> {
        Box::pin(async move {
            plan.validate()?;
            let expected = execution_hash(
                plan.intent(),
                plan.target(),
                plan.access(),
                plan.ownership_marker(),
                step.action(),
                step.access(),
            )?;
            if cancellation.is_cancelled()
                || permit.operation_id.is_nil()
                || permit.provider != LocalProvider::GcpCloudSql
                || permit.plan_sha256 != plan.payload_sha256()
                || permit.execution_sha256 != step.execution_sha256()
                || expected != step.execution_sha256()
            {
                return Err(blocked("GCP Cloud SQL execution permit is invalid"));
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
                        .await?;
                }
                (
                    ProvisioningIntent::Apply,
                    ProvisioningAction::SmokeTestWriteCredential,
                    Some(ProvisioningAccessMode::Write),
                ) if plan.access() == ProvisioningAccessMode::Write => {
                    self.smoke(plan.target(), ProvisioningAccessMode::Write)
                        .await?;
                }
                (
                    ProvisioningIntent::Destroy,
                    ProvisioningAction::RevokeIssuedCredentials,
                    None,
                ) => {
                    self.runtime
                        .force_fence(Uuid::from(plan.target().connection_id()))
                        .await?;
                    let connection = self.cleanup_connection(plan.target()).await?;
                    self.target_authority
                        .destroy(&connection, plan.target(), plan.ownership_marker())
                        .await?;
                }
                _ => return Err(blocked("GCP Cloud SQL provisioning action is invalid")),
            }
            if cancellation.is_cancelled() {
                return Err(blocked("GCP Cloud SQL provisioning was cancelled"));
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
            if cancellation.is_cancelled()
                || plan.intent() != ProvisioningIntent::Apply
                || !has_complete_smoke_plan(plan)
            {
                return Err(blocked("GCP Cloud SQL verification plan is incomplete"));
            }
            self.revalidate_target(plan.target()).await?;
            ProvisioningVerification::complete(
                Some(plan.target().provider_audit_id().into()),
                Utc::now(),
            )
        })
    }
}

fn full_capabilities() -> ProvisioningCapabilityManifest {
    use ManagedAccessCapability::{
        Apply, Destroy, Detect, Discover, Issue, Plan, Reconcile, Verify,
    };
    ProvisioningCapabilityManifest::new([
        Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
    ])
}

fn plan_steps(
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
                u16::try_from(index + 1)
                    .map_err(|_| blocked("GCP Cloud SQL plan has too many steps"))?,
                phase,
                action,
                step_access,
                execution_hash(
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

fn execution_hash(
    intent: ProvisioningIntent,
    target: &ProvisioningTarget,
    access: ProvisioningAccessMode,
    ownership_marker: &str,
    action: ProvisioningAction,
    step_access: Option<ProvisioningAccessMode>,
) -> AppResult<String> {
    canonical_hash(&json!({
        "contract": "dopedb-gcp-cloud-sql-provisioning-execution-v1",
        "manifestSha256": GCP_MANIFEST_SHA256,
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
    }))
}

fn idempotency_key(
    intent: &str,
    target: &ProvisioningTarget,
    access: ProvisioningAccessMode,
    discriminator: &str,
) -> AppResult<String> {
    let hash = canonical_hash(&json!({
        "contract": "dopedb-gcp-cloud-sql-provisioning-idempotency-v1",
        "intent": intent,
        "connectionId": Uuid::from(target.connection_id()),
        "connectionRevision": target.connection_revision().to_string(),
        "integrationGeneration": target.integration_generation().to_string(),
        "resourceFingerprint": target.resource_fingerprint(),
        "access": access,
        "discriminator": discriminator,
    }))?;
    Ok(format!("gcp-{intent}-{}", &hash[..32]))
}

fn ownership_marker(target: &ProvisioningTarget) -> String {
    format!(
        "dopedb:{}:{}",
        LocalProvider::GcpCloudSql.storage_key(),
        Uuid::from(target.connection_id())
    )
}

fn validate_connection(
    target: &ProvisioningTarget,
    connection: &PinnedConnection,
) -> AppResult<()> {
    if target.provider() != LocalProvider::GcpCloudSql
        || Uuid::from(target.connection_id()) != connection.connection_id
        || target.connection_revision() != connection.connection_revision
        || target.engine() != connection.profile.engine
        || connection.profile.provider != Provider::GcpCloudSql
        || connection.profile.credential_mode != WorkspaceCredentialMode::Managed
        || connection.profile.database
            != target
                .selector(ProvisioningTargetSelector::Database)
                .unwrap_or_default()
    {
        return Err(blocked("GCP Cloud SQL connection pin changed"));
    }
    Ok(())
}

fn validate_cleanup_connection(
    target: &ProvisioningTarget,
    connection: &PinnedConnection,
) -> AppResult<()> {
    if target.provider() != LocalProvider::GcpCloudSql
        || Uuid::from(target.connection_id()) != connection.connection_id
        || target.connection_revision() > connection.connection_revision
        || target.engine() != connection.profile.engine
        || connection.profile.provider != Provider::GcpCloudSql
        || connection.profile.credential_mode != WorkspaceCredentialMode::Managed
        || connection.profile.database
            != target
                .selector(ProvisioningTargetSelector::Database)
                .unwrap_or_default()
    {
        return Err(blocked("GCP Cloud SQL cleanup target changed"));
    }
    Ok(())
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

fn has_complete_smoke_plan(plan: &ProvisioningPlan) -> bool {
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

fn blocked(reason: &'static str) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
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

    let marker = ownership_marker(&target);
    let steps = plan_steps(
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
        idempotency_key("apply", &target, ProvisioningAccessMode::Write, "fixture").unwrap(),
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
    let driver = GcpCloudSqlProvisioningDriver::new(store, authority.clone(), runtime.clone());
    assert_driver_failure_contract(&driver, &target, &connection, authority, runtime).await;
}
