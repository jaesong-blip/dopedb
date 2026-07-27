//! Transport-neutral application services shared by Tauri and the local CLI broker.
//! Services expose domain DTOs and errors, never transport types.

mod activity_service;
mod document_service;
mod monitoring_service;
mod operation_service;
mod safety_service;
mod script_service;

pub(crate) use activity_service::{ActivityService, AuditSnapshotReceipt, AuditVerdict};
pub(crate) use document_service::{
    AgentDocumentReadError, DesktopDocumentProposalReceipt, DesktopDocumentProposalRequest,
    DesktopDocumentReadError, DocumentReadReceipt, DocumentService, TerminalDocumentReadRequest,
};
pub(crate) use monitoring_service::{
    MonitoringProposalReceipt, MonitoringProposalRequest, MonitoringService,
    MonitoringServiceError, MonitoringStatusReceipt,
};
pub(crate) use operation_service::{
    OperationDecisionReceipt, OperationDecisionRequest, OperationService,
};
pub(crate) use safety_service::SafetyService;
pub(crate) use script_service::{
    DesktopScriptProposalReceipt, DesktopScriptProposalRequest, DesktopScriptRunError,
    DesktopScriptRunReceipt, SchemaScriptContext, ScriptService, TableScriptContext,
};

use crate::connection::ConnectionManager;
use crate::features::agents::{self, AgentsFeature};
use crate::features::catalog::{self, CatalogFeature};
use crate::features::connections::{self as connection_feature, ConnectionsFeature};
use crate::features::dashboards::{self, ErasedDashboardsFeature};
use crate::features::erd::{self, ErdFeature};
use crate::features::jobs::{self, JobsFeature};
use crate::features::providers::ProvidersFeature;
use crate::features::queries::QueriesFeature;
use crate::features::queries::QueryRunAuthorizationPort;
use crate::features::schema_editor::{self, SchemaEditorFeature};
use crate::features::sql_documents::{self, SqlDocumentsFeature};
use crate::features::workspaces::{self, WorkspacesFeature};
use crate::operations::OperationRuntime;
use crate::store::Store;
use std::sync::Arc;

/// Cloneable application-service facade. Every clone retains the same local store and
/// scope-aware connection runtime, so every service method uses one authority boundary.
#[derive(Clone)]
pub(crate) struct ApplicationServices {
    pub(crate) activity: ActivityService,
    pub(crate) agents: AgentsFeature,
    pub(crate) connections: ConnectionsFeature,
    pub(crate) catalog: CatalogFeature,
    pub(crate) dashboard: ErasedDashboardsFeature,
    pub(crate) document: DocumentService,
    pub(crate) erd: ErdFeature,
    pub(crate) job: JobsFeature,
    pub(crate) monitoring: MonitoringService,
    pub(crate) operation: OperationService,
    pub(crate) providers: ProvidersFeature,
    pub(crate) queries: QueriesFeature,
    pub(crate) safety: SafetyService,
    pub(crate) schema: SchemaEditorFeature,
    pub(crate) script: ScriptService,
    pub(crate) sql_documents: SqlDocumentsFeature,
    pub(crate) workspace: WorkspacesFeature,
}

impl ApplicationServices {
    /// Compatibility constructor for isolated tests and non-desktop adapters.
    /// Production composes the provider feature once in `AppState` and uses
    /// [`Self::with_providers`] so receipt/vault ownership is not duplicated.
    #[cfg(test)]
    pub(crate) fn new(
        store: Store,
        connections: ConnectionManager,
        operation: OperationRuntime,
    ) -> Self {
        let providers = crate::features::providers::compose(store.clone());
        providers
            .bind_revocation_port(Arc::new(connections.clone()))
            .expect("test service composition binds the provider runtime fence");
        Self::with_providers(store, connections, operation, providers)
    }

    /// Constructs application services from the single composed provider feature.
    pub(crate) fn with_providers(
        store: Store,
        connections: ConnectionManager,
        operation: OperationRuntime,
        providers: ProvidersFeature,
    ) -> Self {
        let connection_credentials = connection_feature::system_connection_credentials();
        let queries = crate::features::queries::compose(
            store.clone(),
            connections.clone(),
            operation.clone(),
        );
        let operation_service =
            OperationService::new(store.clone(), connections.clone(), operation.clone());
        let catalog = catalog::compose(store.clone(), connections.clone());
        let script = ScriptService::new(
            store.clone(),
            connections.clone(),
            catalog.clone(),
            operation.clone(),
        );
        let schema = schema_editor::compose(catalog.clone(), script.clone());
        let connection_feature = connection_feature::compose(
            store.clone(),
            connections.clone(),
            connection_credentials.clone(),
        );
        let sql_documents = sql_documents::compose(store.clone(), connections.clone());
        let erd = erd::compose(store.clone(), connections.clone());
        let job = jobs::compose(
            store.clone(),
            connections.clone(),
            catalog.clone(),
            operation.clone(),
        );
        let query_provenance: Arc<dyn QueryRunAuthorizationPort> = Arc::new(queries.provenance());
        let dashboard =
            dashboards::compose_erased(store.clone(), connections.clone(), query_provenance);
        Self {
            activity: ActivityService::new(store.clone()),
            agents: agents::compose(store.clone()),
            connections: connection_feature,
            catalog,
            dashboard,
            document: DocumentService::new(store.clone(), connections.clone(), operation.clone()),
            erd,
            job,
            monitoring: MonitoringService::new(
                store.clone(),
                connections.clone(),
                operation.clone(),
            ),
            operation: operation_service,
            providers,
            queries,
            safety: SafetyService::new(store.clone(), connections.clone()),
            schema,
            script,
            sql_documents,
            workspace: workspaces::compose(store, connections, connection_credentials),
        }
    }
}
