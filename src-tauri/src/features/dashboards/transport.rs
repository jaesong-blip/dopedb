//! Tauri transport for saved-dashboard use cases.

use tauri::State;

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, DashboardId, QueryExecutionId};
use crate::state::AppState;

use super::{Dashboard, DashboardRunError, DashboardRunReceipt, DashboardRunRequest};

#[tauri::command]
pub async fn list_dashboards(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
) -> AppResult<Vec<Dashboard>> {
    state.services.dashboard.list(connection_id).await
}

#[tauri::command]
pub async fn delete_dashboard(state: State<'_, AppState>, id: DashboardId) -> AppResult<()> {
    state.services.dashboard.delete(id).await
}

#[tauri::command]
pub async fn run_dashboard(
    state: State<'_, AppState>,
    id: DashboardId,
    query_id: Option<QueryExecutionId>,
) -> AppResult<DashboardRunReceipt> {
    state
        .services
        .dashboard
        .run(DashboardRunRequest {
            dashboard_id: id,
            query_id,
        })
        .await
        .map_err(DashboardRunError::into_error)
}
