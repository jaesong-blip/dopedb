//! SQL Query vertical slice for desktop and authenticated Terminal workflows.

mod adapters;
mod application;
mod domain;
mod ports;
pub(crate) mod transport;

use crate::connection::ConnectionManager;
use crate::kernel::identity::OperationId;
use crate::kernel::TerminalAuthority;
use crate::operations::OperationRuntime;
use crate::store::Store;

#[cfg(test)]
pub(crate) use adapters::QueryPlatformAdapter;
#[cfg(not(test))]
use adapters::QueryPlatformAdapter;
pub(crate) use adapters::TerminalQueryRunRegistry;
pub(crate) use adapters::{AgentQueryPlanError, AgentQueryRunError, AgentQueryRunPrepareError};
use adapters::{AgentQueryPlanReceipt, PreparedAgentQueryRun};
pub(crate) use adapters::{
    DesktopSqlInspectionError, DesktopSqlInspectionReceipt, DesktopSqlProposalReceipt,
    DesktopSqlRunError, DesktopSqlRunReceipt,
};
use application::QueryUseCases;
pub(crate) use domain::{
    DesktopPreviewIntent, DesktopSqlInspectionRequest, DesktopSqlProposalRequest,
    TerminalQueryPlanRequest, TerminalSqlProposalRequest,
};
#[cfg(test)]
pub(crate) use ports::QueryRunProvenancePort;
pub(crate) use ports::{QueryRunAuthorizationError, QueryRunAuthorizationPort};

#[cfg(test)]
mod domain_tests;
#[cfg(test)]
mod tests;

type ComposedQueryApplication = QueryUseCases<QueryPlatformAdapter>;

/// Composition boundary for desktop SQL and Broker-owned query workflows.
#[derive(Clone)]
pub(crate) struct QueriesFeature {
    application: ComposedQueryApplication,
    provenance: TerminalQueryRunRegistry,
}

impl QueriesFeature {
    pub(crate) async fn inspect_desktop_sql(
        &self,
        request: DesktopSqlInspectionRequest,
    ) -> Result<DesktopSqlInspectionReceipt, DesktopSqlInspectionError> {
        self.application.inspect_desktop_sql(request).await
    }

    pub(crate) async fn propose_desktop_sql(
        &self,
        request: DesktopSqlProposalRequest,
    ) -> Result<DesktopSqlProposalReceipt, DesktopSqlInspectionError> {
        self.application.propose_desktop_sql(request).await
    }

    pub(crate) async fn propose_terminal_sql(
        &self,
        request: TerminalSqlProposalRequest,
    ) -> Result<DesktopSqlProposalReceipt, DesktopSqlInspectionError> {
        self.application.propose_terminal_sql(request).await
    }

    pub(crate) async fn run_desktop_sql(
        &self,
        operation_id: OperationId,
    ) -> Result<DesktopSqlRunReceipt, DesktopSqlRunError> {
        self.application.run_desktop_sql(operation_id).await
    }

    pub(crate) async fn plan_terminal_read(
        &self,
        request: TerminalQueryPlanRequest,
    ) -> Result<AgentQueryPlanReceipt, AgentQueryPlanError> {
        self.application.plan_terminal_read(request).await
    }

    pub(crate) async fn prepare_terminal_run(
        &self,
        plan_id: OperationId,
        authority: &TerminalAuthority,
    ) -> Result<PreparedAgentQueryRun, AgentQueryRunPrepareError> {
        self.application
            .prepare_terminal_run(plan_id, authority)
            .await
    }

    pub(crate) fn provenance(&self) -> TerminalQueryRunRegistry {
        self.provenance.clone()
    }
}

pub(crate) fn compose(
    store: Store,
    connections: ConnectionManager,
    operation: OperationRuntime,
) -> QueriesFeature {
    let provenance = TerminalQueryRunRegistry::default();
    let adapter = QueryPlatformAdapter::new(store, connections, operation, provenance.clone());
    QueriesFeature {
        application: QueryUseCases::new(adapter),
        provenance,
    }
}

#[cfg(test)]
fn compose_with_adapter(
    store: Store,
    connections: ConnectionManager,
    operation: OperationRuntime,
) -> (QueriesFeature, QueryPlatformAdapter) {
    let provenance = TerminalQueryRunRegistry::default();
    let adapter = QueryPlatformAdapter::new(store, connections, operation, provenance.clone());
    (
        QueriesFeature {
            application: QueryUseCases::new(adapter.clone()),
            provenance,
        },
        adapter,
    )
}
