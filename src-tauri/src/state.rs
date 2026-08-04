//! Shared application state managed by Tauri and injected into commands.

use std::sync::Arc;

use crate::broker::BrokerRuntime;
use crate::connection::ConnectionManager;
use crate::error::AppResult;
use crate::features::agents::acp::AcpRuntime;
use crate::features::providers;
use crate::features::terminals::{self, TerminalsFeature};
use crate::operations::{LocalApprovalAuthority, OperationRuntime};
use crate::services::ApplicationServices;
use crate::skills::SkillManager;
use crate::store::Store;

pub struct AppState {
    /// Transport-neutral application services shared by Tauri and the local broker.
    pub services: ApplicationServices,
    /// Owner-local CLI broker. Session capabilities live only inside this runtime.
    pub(crate) broker: BrokerRuntime,
    /// Offline Skill bundle inventory and atomic per-user installer.
    pub(crate) skills: SkillManager,
    /// PTY sessions, bounded output replay, and process-tree lifecycle.
    pub(crate) terminals: TerminalsFeature,
    /// Official ACP client sessions. Authentication remains in local agent tooling.
    pub(crate) agents_acp: AcpRuntime,
    /// Desktop-only approval capability. CLI and Terminal adapters are composed
    /// without this authority and therefore cannot obtain it.
    pub(crate) local_operation_approval: LocalApprovalAuthority,
}

impl AppState {
    pub async fn new() -> AppResult<Self> {
        let store = Store::open().await?;
        store.recover_interrupted_agent_acp_sessions().await?;
        let (operation, local_operation_approval) = OperationRuntime::new(&store);
        let providers = providers::compose(store.clone(), operation.clone());
        let connections = ConnectionManager::with_authorities(
            store.clone(),
            Arc::new(crate::features::workspaces::adapters::HostedWorkspaceControlPlane),
            providers.local_connection_port(),
        );
        providers.bind_revocation_port(Arc::new(connections.clone()))?;
        providers.bind_provisioning_runtime(Arc::new(connections.clone()))?;
        let broker = BrokerRuntime::new(operation.runtime_id().into());
        let terminals = terminals::compose(store.clone(), broker.clone());
        let agents_acp = AcpRuntime::new(store.clone(), broker.clone());
        let services = ApplicationServices::with_providers(
            store.clone(),
            connections.clone(),
            operation,
            providers,
        );
        let skills = SkillManager::new()?;
        services.job.recover_interrupted().await?;
        let recovery = services.operation.recover_previous_runtimes().await?;
        services
            .providers
            .recover_provisioning(&recovery.provisioning_checkpoint_validation_required)
            .await?;
        Ok(Self {
            services,
            broker,
            skills,
            terminals,
            agents_acp,
            local_operation_approval,
        })
    }
}
