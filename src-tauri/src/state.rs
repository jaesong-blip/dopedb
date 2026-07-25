//! Shared application state managed by Tauri and injected into commands.

use crate::broker::BrokerRuntime;
use crate::connection::ConnectionManager;
use crate::error::AppResult;
use crate::features::{FeatureFlag, FeatureFlags};
use crate::operations::{LocalApprovalAuthority, OperationRuntime};
use crate::services::ApplicationServices;
use crate::skills::SkillManager;
use crate::store::Store;
use crate::terminal::TerminalManager;

pub struct AppState {
    /// Handle to the local app.db (connections, safety, history, audit, schema cache).
    pub store: Store,
    /// Transport-neutral application services shared by Tauri and the local broker.
    pub services: ApplicationServices,
    /// Owner-local CLI broker. Session capabilities live only inside this runtime.
    pub(crate) broker: BrokerRuntime,
    /// Safety-sensitive rollout gates captured once for this app runtime.
    pub features: crate::features::FeatureFlags,
    /// Offline Skill bundle inventory and atomic per-user installer.
    pub(crate) skills: SkillManager,
    /// PTY sessions, bounded output replay, and process-tree lifecycle.
    pub(crate) terminals: TerminalManager,
    /// Desktop-only approval capability. CLI/Terminal adapters receive only the
    /// ApplicationServices facade and therefore cannot obtain this value.
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
            FeatureFlag::SqlDocumentsV1,
            FeatureFlag::TableChangesV1,
            FeatureFlag::ErdV1,
            FeatureFlag::JobsV1,
        ]);
        let store = Store::open().await?;
        let connections = ConnectionManager::new(store.clone());
        let (operation, local_operation_approval) = OperationRuntime::new(&store);
        let broker = BrokerRuntime::new(operation.runtime_id());
        let terminals = TerminalManager::new(broker.sessions().clone());
        let services = ApplicationServices::new(store.clone(), connections.clone(), operation);
        let skills = SkillManager::new()?;
        if features.is_enabled(FeatureFlag::JobsV1) {
            services.job.recover_interrupted().await?;
        }
        if features.is_enabled(FeatureFlag::OperationRuntimeV1) {
            services.operation.recover_previous_runtimes().await?;
        }
        Ok(Self {
            store,
            services,
            broker,
            features,
            skills,
            terminals,
            local_operation_approval,
        })
    }
}
