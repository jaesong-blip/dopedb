//! Saved-dashboard use-case entry points.

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, DashboardId, QueryRunId};
use crate::kernel::TerminalAuthority;

use super::domain::{
    AgentDashboardCreateError, AgentDashboardPresentation, Dashboard, DashboardRunRequest,
};
use super::ports::{DashboardCreatePort, DashboardMetadataPort, DashboardRunPort};

#[derive(Clone)]
pub(crate) struct DashboardUseCases<M, R, C> {
    metadata: M,
    runner: R,
    creator: C,
}

impl<M, R, C> DashboardUseCases<M, R, C>
where
    M: DashboardMetadataPort,
    R: DashboardRunPort,
    C: DashboardCreatePort,
{
    pub(crate) fn new(metadata: M, runner: R, creator: C) -> Self {
        Self {
            metadata,
            runner,
            creator,
        }
    }

    pub(crate) async fn list(&self, connection_id: ConnectionId) -> AppResult<Vec<Dashboard>> {
        self.metadata.list(connection_id).await
    }

    pub(crate) async fn delete(&self, dashboard_id: DashboardId) -> AppResult<()> {
        self.metadata.delete(dashboard_id).await
    }

    pub(crate) async fn run(&self, request: DashboardRunRequest) -> Result<R::Receipt, R::Error> {
        self.runner.run(request).await
    }

    pub(crate) async fn create_terminal(
        &self,
        authority: &TerminalAuthority,
        query_run_id: QueryRunId,
        presentation: AgentDashboardPresentation,
    ) -> Result<Dashboard, AgentDashboardCreateError> {
        self.creator
            .create_terminal(authority, query_run_id, presentation)
            .await
    }
}
