//! Catalog feature adapter for schema-editor use cases.

use dopedb_protocol::CatalogSnapshot;

use crate::error::AppResult;
use crate::features::catalog::{CatalogFeature, CatalogReadPolicy};
use crate::kernel::identity::ConnectionId;

use super::super::ports::SchemaCatalogPort;

#[derive(Clone)]
pub(in crate::features::schema_editor) struct SchemaCatalogAdapter {
    catalog: CatalogFeature,
}

impl SchemaCatalogAdapter {
    pub(in crate::features::schema_editor) fn new(catalog: CatalogFeature) -> Self {
        Self { catalog }
    }
}

impl SchemaCatalogPort for SchemaCatalogAdapter {
    async fn refresh(&self, connection_id: ConnectionId) -> AppResult<CatalogSnapshot> {
        self.catalog
            .load_snapshot(connection_id, CatalogReadPolicy::Refresh)
            .await
    }
}
