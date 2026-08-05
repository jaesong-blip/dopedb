//! Scope-aware dashboard metadata adapter.

use crate::connection::ConnectionManager;
use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, DashboardId};
use crate::store::Store;

use super::super::domain::Dashboard;
use super::super::ports::DashboardMetadataPort;

#[derive(Clone)]
pub(in crate::features::dashboards) struct DashboardMetadataAdapter {
    store: Store,
    connections: ConnectionManager,
}

impl DashboardMetadataAdapter {
    pub(in crate::features::dashboards) fn new(
        store: Store,
        connections: ConnectionManager,
    ) -> Self {
        Self { store, connections }
    }
}

impl DashboardMetadataPort for DashboardMetadataAdapter {
    async fn list(&self, connection_id: ConnectionId) -> AppResult<Vec<Dashboard>> {
        let operation_scope = self.connections.begin_operation_scope().await;
        let connection = operation_scope
            .pin_shared_artifact_connection(connection_id.into())
            .await?;
        self.store.list_dashboards_if_current(&connection).await
    }

    async fn delete(&self, dashboard_id: DashboardId) -> AppResult<()> {
        let operation_scope = self.connections.begin_operation_scope().await;
        let dashboard = operation_scope.pin_dashboard(dashboard_id).await?;
        self.store.delete_dashboard_if_current(&dashboard).await
    }
}
