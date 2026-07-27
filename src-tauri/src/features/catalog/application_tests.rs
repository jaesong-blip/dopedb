use std::sync::{Arc, Mutex};

use dopedb_protocol::catalog::CatalogSnapshot;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::ConnectionId;
use crate::kernel::TerminalAuthority;

use super::application::CatalogUseCases;
use super::domain::{Catalog, CatalogOverview, CatalogReadPolicy};
use super::ports::CatalogGatewayPort;

#[derive(Clone, Default)]
struct RecordingCatalogGateway {
    loads: Arc<Mutex<Vec<(ConnectionId, CatalogReadPolicy)>>>,
    overview_loads: Arc<Mutex<Vec<ConnectionId>>>,
}

impl CatalogGatewayPort for RecordingCatalogGateway {
    async fn load(
        &self,
        connection_id: ConnectionId,
        policy: CatalogReadPolicy,
    ) -> AppResult<Catalog> {
        self.loads.lock().unwrap().push((connection_id, policy));
        Ok(Catalog::default())
    }

    async fn load_snapshot(
        &self,
        _connection_id: ConnectionId,
        _policy: CatalogReadPolicy,
    ) -> AppResult<CatalogSnapshot> {
        Err(AppError::Config("unused test path".into()))
    }

    async fn load_overview(&self, _connection_id: ConnectionId) -> AppResult<CatalogOverview> {
        self.overview_loads.lock().unwrap().push(_connection_id);
        Ok(CatalogOverview::default())
    }

    async fn load_terminal_snapshot(
        &self,
        _authority: &TerminalAuthority,
        _policy: CatalogReadPolicy,
    ) -> AppResult<CatalogSnapshot> {
        Err(AppError::Config("unused test path".into()))
    }

    async fn table_ddl(
        &self,
        _connection_id: ConnectionId,
        _schema: Option<&str>,
        _table: &str,
    ) -> AppResult<String> {
        Err(AppError::Config("unused test path".into()))
    }
}

#[tokio::test]
async fn cache_policy_and_typed_connection_reach_the_gateway_unchanged() {
    let gateway = RecordingCatalogGateway::default();
    let calls = Arc::clone(&gateway.loads);
    let use_cases = CatalogUseCases::new(gateway);
    let connection_id = ConnectionId::from(uuid::Uuid::new_v4());

    use_cases
        .load(connection_id, CatalogReadPolicy::Refresh)
        .await
        .unwrap();

    assert_eq!(
        calls.lock().unwrap().as_slice(),
        &[(connection_id, CatalogReadPolicy::Refresh)]
    );
}

#[tokio::test]
async fn overview_reaches_its_dedicated_gateway_path_without_a_cache_policy() {
    let gateway = RecordingCatalogGateway::default();
    let calls = Arc::clone(&gateway.overview_loads);
    let use_cases = CatalogUseCases::new(gateway);
    let connection_id = ConnectionId::from(uuid::Uuid::new_v4());

    let overview = use_cases.load_overview(connection_id).await.unwrap();

    assert_eq!(
        overview.detail_state,
        super::domain::CatalogOverviewDetailState::Deferred
    );
    assert_eq!(calls.lock().unwrap().as_slice(), &[connection_id]);
}
