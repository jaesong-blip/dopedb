//! Shared application state managed by Tauri and injected into commands.

use std::sync::Arc;

use crate::broker::BrokerRuntime;
use crate::connection::ConnectionManager;
use crate::error::AppResult;
use crate::features::terminals::{self, TerminalsFeature};
use crate::features::{FeatureFlag, FeatureFlags};
use crate::operations::{LocalApprovalAuthority, OperationRuntime};
use crate::services::ApplicationServices;
use crate::skills::SkillManager;
use crate::store::Store;

pub struct AppState {
    /// Transport-neutral application services shared by Tauri and the local broker.
    pub services: ApplicationServices,
    /// Owner-local CLI broker. Session capabilities live only inside this runtime.
    pub(crate) broker: BrokerRuntime,
    /// Safety-sensitive rollout gates captured once for this app runtime.
    pub features: crate::features::FeatureFlags,
    /// Offline Skill bundle inventory and atomic per-user installer.
    pub(crate) skills: SkillManager,
    /// PTY sessions, bounded output replay, and process-tree lifecycle.
    pub(crate) terminals: TerminalsFeature,
    /// Desktop-only approval capability. CLI and Terminal adapters are composed
    /// without this authority and therefore cannot obtain it.
    pub(crate) local_operation_approval: LocalApprovalAuthority,
}

impl AppState {
    pub async fn new() -> AppResult<Self> {
        let features = FeatureFlags::new([
            FeatureFlag::OperationRuntimeV1,
            FeatureFlag::LocalBrokerV1,
            FeatureFlag::CliV1,
            FeatureFlag::SkillManagerV1,
            FeatureFlag::TerminalDockV1,
            FeatureFlag::CatalogV2,
            FeatureFlag::DdlIrV1,
            FeatureFlag::TableChangesV1,
            FeatureFlag::ErdV1,
            FeatureFlag::JobsV1,
        ]);
        let store = Store::open().await?;
        let connections = ConnectionManager::with_remote_authority(
            store.clone(),
            Arc::new(crate::features::workspaces::adapters::HostedWorkspaceControlPlane),
        );
        let (operation, local_operation_approval) = OperationRuntime::new(&store);
        let broker = BrokerRuntime::new(operation.runtime_id());
        let terminals = terminals::compose(
            store.clone(),
            broker.clone(),
            features.is_enabled(FeatureFlag::TerminalDockV1),
        );
        let services = ApplicationServices::new(store.clone(), connections.clone(), operation);
        let skills = SkillManager::new()?;
        if features.is_enabled(FeatureFlag::JobsV1) {
            services.job.recover_interrupted().await?;
        }
        if features.is_enabled(FeatureFlag::OperationRuntimeV1) {
            services.operation.recover_previous_runtimes().await?;
        }
        Ok(Self {
            services,
            broker,
            features,
            skills,
            terminals,
            local_operation_approval,
        })
    }
}
