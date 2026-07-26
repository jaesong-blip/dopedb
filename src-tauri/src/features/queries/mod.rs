//! Terminal Agent SQL-read vertical slice.

mod adapters;
mod application;
mod domain;
mod ports;

use crate::connection::ConnectionManager;
use crate::kernel::identity::OperationId;
use crate::kernel::TerminalAuthority;
use crate::operations::OperationRuntime;
use crate::store::Store;

#[cfg(test)]
pub(crate) use adapters::TerminalQueryAdapter;
#[cfg(not(test))]
use adapters::TerminalQueryAdapter;
pub(crate) use adapters::TerminalQueryRunRegistry;
pub(crate) use adapters::{AgentQueryPlanError, AgentQueryRunError, AgentQueryRunPrepareError};
use adapters::{AgentQueryPlanReceipt, PreparedAgentQueryRun};
use application::TerminalQueryUseCases;
pub(crate) use domain::TerminalQueryPlanRequest;
#[cfg(test)]
pub(crate) use ports::QueryRunProvenancePort;
pub(crate) use ports::{QueryRunAuthorizationError, QueryRunAuthorizationPort};

#[cfg(test)]
mod domain_tests;
#[cfg(test)]
mod tests;

type ComposedTerminalQueryApplication = TerminalQueryUseCases<TerminalQueryAdapter>;

/// Composition boundary for Broker-owned read planning and execution.
#[derive(Clone)]
pub(crate) struct QueriesFeature {
    application: ComposedTerminalQueryApplication,
    provenance: TerminalQueryRunRegistry,
}

impl QueriesFeature {
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
    let adapter = TerminalQueryAdapter::new(store, connections, operation, provenance.clone());
    QueriesFeature {
        application: TerminalQueryUseCases::new(adapter),
        provenance,
    }
}

#[cfg(test)]
fn compose_with_adapter(
    store: Store,
    connections: ConnectionManager,
    operation: OperationRuntime,
) -> (QueriesFeature, TerminalQueryAdapter) {
    let provenance = TerminalQueryRunRegistry::default();
    let adapter = TerminalQueryAdapter::new(store, connections, operation, provenance.clone());
    (
        QueriesFeature {
            application: TerminalQueryUseCases::new(adapter.clone()),
            provenance,
        },
        adapter,
    )
}
