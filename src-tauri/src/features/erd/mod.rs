//! Workspace-scoped ERD persistence vertical slice.

mod adapters;
mod application;
mod domain;
mod ports;
pub(crate) mod transport;

use crate::connection::ConnectionManager;
use crate::error::AppResult;
use crate::kernel::identity::ConnectionId;
use crate::store::Store;

use adapters::{ConnectionErdAuthority, SqliteErdRepository, SystemErdGenerator};
use application::ErdUseCases;
pub(crate) use application::{SaveErdLayoutOutcome, SaveErdLayoutRequest};
pub(crate) use domain::ErdLayout;

type ComposedErdApplication =
    ErdUseCases<SqliteErdRepository, ConnectionErdAuthority, SystemErdGenerator>;

#[derive(Clone)]
pub(crate) struct ErdFeature {
    application: ComposedErdApplication,
}

impl ErdFeature {
    pub(crate) async fn list(&self, connection_id: ConnectionId) -> AppResult<Vec<ErdLayout>> {
        self.application.list(connection_id).await
    }

    pub(crate) async fn save(
        &self,
        request: SaveErdLayoutRequest,
    ) -> AppResult<SaveErdLayoutOutcome> {
        self.application.save(request).await
    }
}

pub(crate) fn compose(store: Store, connections: ConnectionManager) -> ErdFeature {
    ErdFeature {
        application: ErdUseCases::new(
            SqliteErdRepository::new(store),
            ConnectionErdAuthority::new(connections),
            SystemErdGenerator,
        ),
    }
}
