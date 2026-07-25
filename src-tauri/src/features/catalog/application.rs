//! Typed catalog use cases.

use dopedb_protocol::catalog::CatalogSnapshot;

use crate::error::AppResult;
use crate::kernel::identity::ConnectionId;
use crate::kernel::TerminalAuthority;

use super::domain::{Catalog, CatalogReadPolicy};
use super::ports::CatalogGatewayPort;

#[derive(Clone)]
pub(crate) struct CatalogUseCases<G> {
    gateway: G,
}

impl<G> CatalogUseCases<G>
where
    G: CatalogGatewayPort,
{
    pub(crate) fn new(gateway: G) -> Self {
        Self { gateway }
    }

    pub(crate) async fn load(
        &self,
        connection_id: ConnectionId,
        policy: CatalogReadPolicy,
    ) -> AppResult<Catalog> {
        self.gateway.load(connection_id, policy).await
    }

    pub(crate) async fn load_snapshot(
        &self,
        connection_id: ConnectionId,
        policy: CatalogReadPolicy,
    ) -> AppResult<CatalogSnapshot> {
        self.gateway.load_snapshot(connection_id, policy).await
    }

    pub(crate) async fn load_terminal_snapshot(
        &self,
        authority: &TerminalAuthority,
        policy: CatalogReadPolicy,
    ) -> AppResult<CatalogSnapshot> {
        self.gateway.load_terminal_snapshot(authority, policy).await
    }

    pub(crate) async fn table_ddl(
        &self,
        connection_id: ConnectionId,
        schema: Option<&str>,
        table: &str,
    ) -> AppResult<String> {
        self.gateway.table_ddl(connection_id, schema, table).await
    }
}
