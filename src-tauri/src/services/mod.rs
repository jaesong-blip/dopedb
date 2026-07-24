//! Transport-neutral application services shared by Tauri and the local CLI broker.
//! Services expose domain DTOs and errors, never transport types.

mod activity_service;
mod catalog_service;
mod connection_credentials;
mod connection_service;
mod dashboard_service;
mod document_service;
mod legacy_chat_service;
mod monitoring_service;
mod operation_service;
mod query_service;
mod safety_service;
mod script_service;
mod terminal_authority;
mod terminal_run_registry;
mod workspace_service;

pub(crate) use activity_service::{ActivityService, AuditSnapshotReceipt, AuditVerdict};
pub(crate) use catalog_service::{CatalogReadPolicy, CatalogService};
pub(crate) use connection_service::{
    AgentConnectionSummary, CliConnectionResolutionError, ConnectionProfileTestRequest,
    ConnectionService, ConnectionUpsertRequest,
};
pub(crate) use dashboard_service::{
    AgentDashboardCommitError, AgentDashboardPrepareError, AgentDashboardPresentation,
    DashboardRunError, DashboardRunReceipt, DashboardRunRequest, DashboardService,
};
pub(crate) use document_service::{
    AgentDocumentReadError, DesktopDocumentProposalReceipt, DesktopDocumentProposalRequest,
    DesktopDocumentReadError, DocumentReadReceipt, DocumentService, TerminalDocumentReadRequest,
};
pub(crate) use legacy_chat_service::LegacyChatService;
pub(crate) use monitoring_service::{
    MonitoringProposalReceipt, MonitoringProposalRequest, MonitoringService,
    MonitoringServiceError, MonitoringStatusReceipt,
};
pub(crate) use operation_service::{
    OperationDecisionReceipt, OperationDecisionRequest, OperationService,
};
pub(crate) use query_service::{
    AgentQueryPlanError, AgentQueryRunError, AgentQueryRunPrepareError,
    DesktopSqlClassificationReceipt, DesktopSqlClassificationRequest, DesktopSqlInspectionError,
    DesktopSqlPreviewReceipt, DesktopSqlPreviewRequest, DesktopSqlProposalReceipt,
    DesktopSqlProposalRequest, DesktopSqlRunError, DesktopSqlRunReceipt, QueryService,
    TerminalQueryPlanRequest, TerminalSqlProposalRequest,
};
pub(crate) use safety_service::SafetyService;
pub(crate) use script_service::{
    DesktopScriptProposalReceipt, DesktopScriptProposalRequest, DesktopScriptRunError,
    DesktopScriptRunReceipt, ScriptService,
};
pub(crate) use terminal_authority::TerminalAuthority;
pub(crate) use terminal_run_registry::TerminalQueryRunRegistry;
pub(crate) use workspace_service::{
    WorkspaceConnectionCopyRequest, WorkspaceCredentialBindingRequest, WorkspaceService,
};

use crate::connection::ConnectionManager;
use crate::operations::OperationRuntime;
use crate::store::Store;

/// Cloneable application-service facade. Every clone retains the same local store and
/// scope-aware connection runtime, so every service method uses one authority boundary.
#[derive(Clone)]
pub(crate) struct ApplicationServices {
    pub(crate) activity: ActivityService,
    pub(crate) legacy_chat: LegacyChatService,
    pub(crate) connections: ConnectionService,
    pub(crate) catalog: CatalogService,
    pub(crate) dashboard: DashboardService,
    pub(crate) document: DocumentService,
    pub(crate) monitoring: MonitoringService,
    pub(crate) operation: OperationService,
    pub(crate) query: QueryService,
    pub(crate) safety: SafetyService,
    pub(crate) script: ScriptService,
    pub(crate) workspace: WorkspaceService,
}

impl ApplicationServices {
    pub(crate) fn new(
        store: Store,
        connections: ConnectionManager,
        operation: OperationRuntime,
    ) -> Self {
        let connection_credentials = connection_credentials::system_connection_credentials();
        let terminal_runs = TerminalQueryRunRegistry::default();
        let operation_service =
            OperationService::new(store.clone(), connections.clone(), operation.clone());
        Self {
            activity: ActivityService::new(store.clone()),
            legacy_chat: LegacyChatService::new(store.clone()),
            connections: ConnectionService::new(
                store.clone(),
                connections.clone(),
                connection_credentials.clone(),
            ),
            catalog: CatalogService::new(store.clone(), connections.clone()),
            dashboard: DashboardService::new(
                store.clone(),
                connections.clone(),
                terminal_runs.clone(),
            ),
            document: DocumentService::new(store.clone(), connections.clone(), operation.clone()),
            monitoring: MonitoringService::new(
                store.clone(),
                connections.clone(),
                operation.clone(),
            ),
            operation: operation_service,
            query: QueryService::new(
                store.clone(),
                connections.clone(),
                operation.clone(),
                terminal_runs,
            ),
            safety: SafetyService::new(store.clone(), connections.clone()),
            script: ScriptService::new(store.clone(), connections.clone(), operation),
            workspace: WorkspaceService::new(store, connections, connection_credentials),
        }
    }
}
