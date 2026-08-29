//! Pure, secret-free provisioning plan and receipt state machines.

#[path = "domain_plan.rs"]
mod plan;
#[path = "domain_receipt.rs"]
mod receipt;

pub(crate) use plan::*;
pub(crate) use receipt::*;

#[cfg(test)]
use chrono::Utc;
#[cfg(test)]
use std::collections::BTreeMap;
#[cfg(test)]
use uuid::Uuid;

#[cfg(test)]
use super::super::domain::LocalProvider;
#[cfg(test)]
use crate::kernel::identity::{ConnectionId, ProviderIntegrationId, WorkspaceId};
#[cfg(test)]
use crate::model::Engine;

#[cfg(test)]
pub(super) fn fixture_plan(
    intent: ProvisioningIntent,
    capabilities: ProvisioningCapabilityManifest,
) -> ProvisioningPlan {
    use ProvisioningTargetSelector::{Account, Database, Instance, Project, Region};

    let target = ProvisioningTarget::new(
        LocalProvider::GcpCloudSql,
        ConnectionId::from(Uuid::from_u128(10)),
        3,
        ProviderIntegrationId::from(Uuid::from_u128(20)),
        4,
        "ab".repeat(32),
        "fixture-instance / app".into(),
        "sample-project-123 · asia-northeast3".into(),
        BTreeMap::from([
            (Account, "owner@example.com".into()),
            (Project, "sample-project-123".into()),
            (Region, "asia-northeast3".into()),
            (Instance, "fixture-instance".into()),
            (Database, "app".into()),
        ]),
        Engine::Postgres,
        true,
        None,
        true,
        "instance-fixture-123".into(),
    )
    .unwrap();
    let (phase, actions) = match intent {
        ProvisioningIntent::Apply => (
            ProvisioningPhase::Apply,
            vec![
                ProvisioningAction::CreateProviderIdentity,
                ProvisioningAction::CreateDatabasePrincipal,
                ProvisioningAction::GrantExistingObjects,
                ProvisioningAction::GrantFutureObjects,
            ],
        ),
        ProvisioningIntent::Destroy => (
            ProvisioningPhase::Destroy,
            vec![
                ProvisioningAction::RevokeIssuedCredentials,
                ProvisioningAction::RemoveOwnedProviderIdentity,
            ],
        ),
    };
    let steps = actions
        .into_iter()
        .enumerate()
        .map(|(index, action)| {
            ProvisioningPlanStep::new(
                u16::try_from(index + 1).unwrap(),
                phase,
                action,
                Some(ProvisioningAccessMode::Read),
                format!("{:02x}", index + 1).repeat(32),
            )
            .unwrap()
        })
        .collect();
    let marker = format!(
        "dopedb:{}:{}",
        LocalProvider::GcpCloudSql.storage_key(),
        Uuid::from_u128(21)
    );
    ProvisioningPlan::new(
        intent,
        "cd".repeat(32),
        target,
        ProvisioningAccessMode::Read,
        capabilities,
        steps,
        marker,
        match intent {
            ProvisioningIntent::Apply => "fixture_apply_0001",
            ProvisioningIntent::Destroy => "fixture_destroy_01",
        }
        .into(),
    )
    .unwrap()
}

#[cfg(test)]
pub(super) fn fixture_repair_plan(
    capabilities: ProvisioningCapabilityManifest,
) -> ProvisioningPlan {
    let original = fixture_plan(ProvisioningIntent::Apply, capabilities.clone());
    ProvisioningPlan::new(
        ProvisioningIntent::Apply,
        original.adapter_manifest_sha256().into(),
        original.target().clone(),
        original.access(),
        capabilities,
        original.steps().to_vec(),
        original.ownership_marker().into(),
        "fixture_repair_0001".into(),
    )
    .unwrap()
}

#[cfg(test)]
pub(crate) fn assert_mock_provider_lifecycle() {
    use ManagedAccessCapability::{
        Apply, Destroy, Detect, Discover, Issue, Plan, Reconcile, Verify,
    };

    let full = ProvisioningCapabilityManifest::new([
        Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
    ]);
    let apply = fixture_plan(ProvisioningIntent::Apply, full.clone());
    let operation_id = Uuid::from_u128(22);
    let started = Utc::now();
    assert!(ProvisioningReceipt::ready_to_apply(
        WorkspaceId::from(Uuid::from_u128(1)),
        "fixture-account".into(),
        ConnectionId::from(Uuid::from_u128(999)),
        operation_id,
        &apply,
        started,
    )
    .is_err());
    let mut receipt = ProvisioningReceipt::ready_to_apply(
        WorkspaceId::from(Uuid::from_u128(1)),
        "fixture-account".into(),
        apply.target().connection_id(),
        operation_id,
        &apply,
        started,
    )
    .unwrap();
    assert!(!receipt.can_issue());
    assert!(receipt
        .begin_apply(&apply, Uuid::from_u128(999), started)
        .is_err());
    receipt.begin_apply(&apply, operation_id, started).unwrap();
    receipt.checkpoint(&apply, 1, started).unwrap();
    assert!(receipt.checkpoint(&apply, 1, started).is_err());
    receipt.checkpoint(&apply, 2, started).unwrap();
    receipt.checkpoint(&apply, 3, started).unwrap();
    receipt.checkpoint(&apply, 4, started).unwrap();
    receipt.begin_verification(&apply, started).unwrap();
    receipt
        .complete_verification(
            ProvisioningVerification::complete(Some("provider-audit-1".into()), started).unwrap(),
            started,
        )
        .unwrap();
    assert!(receipt.can_issue());
    receipt
        .needs_repair(ProvisioningRepairReason::ProviderDrift, started)
        .unwrap();
    assert!(!receipt.can_issue());

    let destroy = fixture_plan(ProvisioningIntent::Destroy, full);
    assert!(receipt
        .begin_destroy(
            &destroy,
            Uuid::from_u128(24),
            "dopedb:gcp_cloud_sql:not-the-owned-id",
            started,
        )
        .is_err());
    let marker = destroy.ownership_marker().to_owned();
    receipt
        .begin_destroy(&destroy, Uuid::from_u128(24), &marker, started)
        .unwrap();
    receipt.checkpoint_destroy(&destroy, 1, started).unwrap();
    receipt.checkpoint_destroy(&destroy, 2, started).unwrap();
    receipt.finish_destroy(&destroy, started).unwrap();
    assert_eq!(receipt.state(), ProvisioningState::NeedsSetup);
    assert!(!receipt.can_issue());

    let incomplete = ProvisioningCapabilityManifest::new([Detect, Discover, Plan, Apply, Verify]);
    let incomplete_plan = fixture_plan(ProvisioningIntent::Apply, incomplete);
    let mut incomplete_receipt = ProvisioningReceipt::ready_to_apply(
        WorkspaceId::from(Uuid::from_u128(1)),
        "fixture-account".into(),
        incomplete_plan.target().connection_id(),
        Uuid::from_u128(26),
        &incomplete_plan,
        started,
    )
    .unwrap();
    incomplete_receipt
        .begin_apply(&incomplete_plan, Uuid::from_u128(26), started)
        .unwrap();
    incomplete_receipt
        .checkpoint(&incomplete_plan, 4, started)
        .unwrap();
    incomplete_receipt
        .begin_verification(&incomplete_plan, started)
        .unwrap();
    assert!(incomplete_receipt
        .complete_verification(
            ProvisioningVerification::complete(None, started).unwrap(),
            started,
        )
        .is_err());
    assert!(!incomplete_receipt.can_issue());
}
