//! Capabilities required by saved-dashboard use cases.

use std::future::Future;

use serde::Serialize;

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, DashboardId, QueryRunId};
use crate::kernel::TerminalAuthority;

use super::domain::{
    AgentDashboardCreateError, AgentDashboardPresentation, Dashboard, DashboardRunRequest,
};

pub(crate) trait DashboardMetadataPort: Clone + Send + Sync + 'static {
    fn list(
        &self,
        connection_id: ConnectionId,
    ) -> impl Future<Output = AppResult<Vec<Dashboard>>> + Send;

    fn delete(&self, dashboard_id: DashboardId) -> impl Future<Output = AppResult<()>> + Send;
}

pub(crate) trait DashboardRunPort: Clone + Send + Sync + 'static {
    type Receipt: Serialize + Send;
    type Error: Send;

    fn run(
        &self,
        request: DashboardRunRequest,
    ) -> impl Future<Output = Result<Self::Receipt, Self::Error>> + Send;
}

pub(crate) trait DashboardCreatePort: Clone + Send + Sync + 'static {
    fn create_terminal(
        &self,
        authority: &TerminalAuthority,
        query_run_id: QueryRunId,
        presentation: AgentDashboardPresentation,
    ) -> impl Future<Output = Result<Dashboard, AgentDashboardCreateError>> + Send;
}
