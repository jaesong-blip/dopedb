//! Terminal-query provenance adapter for saved-dashboard creation.

use crate::connection::{ensure_terminal_pin, ConnectionManager};
use crate::error::AppError;
use crate::kernel::identity::QueryRunId;
use crate::kernel::TerminalAuthority;
use crate::model::{HistoryEntry, QueryKind};
use crate::services::TerminalQueryRunRegistry;
use crate::store::Store;

use super::super::domain::{
    AgentDashboardCreateError, AgentDashboardPresentation, Dashboard, DashboardDraft,
    DashboardVisualization,
};
use super::super::ports::DashboardCreatePort;
use super::super::validation;

fn is_eligible_terminal_run(source: &HistoryEntry) -> bool {
    source.origin == "agent" && source.status == "ok" && matches!(source.kind, QueryKind::Read)
}

#[derive(Clone)]
pub(in crate::features::dashboards) struct TerminalDashboardCreator {
    store: Store,
    connections: ConnectionManager,
    terminal_runs: TerminalQueryRunRegistry,
}

impl TerminalDashboardCreator {
    pub(in crate::features::dashboards) fn new(
        store: Store,
        connections: ConnectionManager,
        terminal_runs: TerminalQueryRunRegistry,
    ) -> Self {
        Self {
            store,
            connections,
            terminal_runs,
        }
    }
}

impl DashboardCreatePort for TerminalDashboardCreator {
    async fn create_terminal(
        &self,
        authority: &TerminalAuthority,
        query_run_id: QueryRunId,
        presentation: AgentDashboardPresentation,
    ) -> Result<Dashboard, AgentDashboardCreateError> {
        self.terminal_runs
            .authorize(query_run_id.into(), authority)
            .map_err(AgentDashboardCreateError::Application)?;
        let operation_scope = self.connections.begin_operation_scope().await;
        let resolved = match self
            .store
            .resolve_history_for_dashboard_prepare(query_run_id.into())
            .await
        {
            Ok(resolved) => resolved,
            Err(AppError::NotFound(_)) => return Err(AgentDashboardCreateError::QueryRunNotFound),
            Err(error) => return Err(AgentDashboardCreateError::Application(error)),
        };
        if !is_eligible_terminal_run(&resolved.history) {
            return Err(AgentDashboardCreateError::QueryRunIneligible);
        }
        let connection = operation_scope
            .pin_dashboard_connection(resolved.history.connection_id)
            .await
            .map_err(AgentDashboardCreateError::Application)?;
        let source = match self
            .store
            .get_history_if_current(&connection, &resolved)
            .await
        {
            Ok(source) => source,
            Err(AppError::NotFound(_)) => return Err(AgentDashboardCreateError::QueryRunNotFound),
            Err(error) => return Err(AgentDashboardCreateError::Application(error)),
        };
        if !is_eligible_terminal_run(&source) {
            return Err(AgentDashboardCreateError::QueryRunIneligible);
        }
        ensure_terminal_pin(authority, &connection)
            .map_err(AgentDashboardCreateError::Application)?;
        let draft = DashboardDraft {
            connection_id: source.connection_id.into(),
            title: presentation.title,
            description: presentation.description,
            sql: source.sql,
            visualization: DashboardVisualization {
                version: validation::VISUALIZATION_VERSION,
                kind: presentation.kind,
                x_column: presentation.x_column,
                y_columns: presentation.y_columns,
            },
        };
        validation::validate_draft(&draft, connection.profile.engine)
            .map_err(AgentDashboardCreateError::InvalidDraft)?;
        self.store
            .save_dashboard_if_current(&connection, &draft)
            .await
            .map_err(AgentDashboardCreateError::Persistence)
    }
}
