//! Saved-dashboard vertical slice.

mod adapters;
mod application;
mod domain;
mod ports;
pub(crate) mod transport;
mod validation;

#[cfg(test)]
mod adapter_tests;

use crate::connection::ConnectionManager;
use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, DashboardId, QueryRunId};
use crate::kernel::TerminalAuthority;
use crate::services::TerminalQueryRunRegistry;
use crate::store::Store;

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

type ComposedDashboardApplication =
    DashboardUseCases<DashboardMetadataAdapter, DashboardRunner, TerminalDashboardCreator>;

#[derive(Clone)]
pub(crate) struct DashboardsFeature {
    application: ComposedDashboardApplication,
}

impl DashboardsFeature {
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

pub(crate) fn compose(
    store: Store,
    connections: ConnectionManager,
    terminal_runs: TerminalQueryRunRegistry,
) -> DashboardsFeature {
    DashboardsFeature {
        application: DashboardUseCases::new(
            DashboardMetadataAdapter::new(store.clone(), connections.clone()),
            DashboardRunner::new(store.clone(), connections.clone()),
            TerminalDashboardCreator::new(store, connections, terminal_runs),
        ),
    }
}
