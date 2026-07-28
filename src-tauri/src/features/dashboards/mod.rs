//! Saved-dashboard vertical slice.

use std::sync::Arc;

mod adapters;
mod application;
mod domain;
mod ports;
pub(crate) mod transport;
mod validation;

use crate::connection::ConnectionManager;
use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, DashboardId, QueryRunId};
use crate::kernel::TerminalAuthority;
use crate::store::Store;

use crate::features::queries::{QueryRunAuthorizationError, QueryRunAuthorizationPort};

use adapters::{DashboardMetadataAdapter, DashboardRunner, TerminalDashboardCreator};
pub(crate) use adapters::{DashboardRunError, DashboardRunReceipt};
use application::DashboardUseCases;
#[cfg(test)]
pub(crate) use domain::DashboardVisualization;
pub(crate) use domain::{
    AgentDashboardCreateError, AgentDashboardPresentation, Dashboard, DashboardDraft,
    DashboardKind, DashboardRunRequest,
};
pub(crate) use validation::validate_visualization;

type ComposedDashboardApplication<P> =
    DashboardUseCases<DashboardMetadataAdapter, DashboardRunner, TerminalDashboardCreator<P>>;

/// Dashboard facade whose Terminal provenance dependency is erased at composition.
pub(crate) type ErasedDashboardsFeature = DashboardsFeature<ErasedQueryRunProvenance>;

/// Dashboard-owned type erasure for the feature port that authorizes a query run.
#[derive(Clone)]
pub(crate) struct ErasedQueryRunProvenance(Arc<dyn QueryRunAuthorizationPort>);

impl ErasedQueryRunProvenance {
    pub(crate) fn new(port: Arc<dyn QueryRunAuthorizationPort>) -> Self {
        Self(port)
    }
}

impl QueryRunAuthorizationPort for ErasedQueryRunProvenance {
    fn authorize(
        &self,
        query_run_id: QueryRunId,
        authority: &TerminalAuthority,
    ) -> Result<(), QueryRunAuthorizationError> {
        self.0.authorize(query_run_id, authority)
    }
}

#[derive(Clone)]
pub(crate) struct DashboardsFeature<P> {
    application: ComposedDashboardApplication<P>,
}

impl<P> DashboardsFeature<P>
where
    P: QueryRunAuthorizationPort + Clone,
{
    pub(crate) async fn list(&self, connection_id: ConnectionId) -> AppResult<Vec<Dashboard>> {
        self.application.list(connection_id).await
    }

    pub(crate) async fn delete(&self, dashboard_id: DashboardId) -> AppResult<()> {
        self.application.delete(dashboard_id).await
    }

    pub(crate) async fn run(
        &self,
        request: DashboardRunRequest,
    ) -> Result<DashboardRunReceipt, DashboardRunError> {
        self.application.run(request).await
    }

    pub(crate) async fn create_terminal(
        &self,
        authority: &TerminalAuthority,
        query_run_id: QueryRunId,
        presentation: AgentDashboardPresentation,
    ) -> Result<Dashboard, AgentDashboardCreateError> {
        self.application
            .create_terminal(authority, query_run_id, presentation)
            .await
    }
}

pub(crate) fn compose<P>(
    store: Store,
    connections: ConnectionManager,
    terminal_runs: P,
) -> DashboardsFeature<P>
where
    P: QueryRunAuthorizationPort + Clone,
{
    DashboardsFeature {
        application: DashboardUseCases::new(
            DashboardMetadataAdapter::new(store.clone(), connections.clone()),
            DashboardRunner::new(store.clone(), connections.clone()),
            TerminalDashboardCreator::new(store, connections, terminal_runs),
        ),
    }
}

pub(crate) fn compose_erased(
    store: Store,
    connections: ConnectionManager,
    terminal_runs: Arc<dyn QueryRunAuthorizationPort>,
) -> ErasedDashboardsFeature {
    compose(
        store,
        connections,
        ErasedQueryRunProvenance::new(terminal_runs),
    )
}
