//! Catalog refresh adapter used by Job planning and execution.

use dopedb_protocol::catalog::CatalogSnapshot;

use crate::error::AppResult;
use crate::features::catalog::{CatalogFeature, CatalogReadPolicy};
use crate::kernel::identity::ConnectionId;

use super::super::ports::JobCatalogPort;

#[derive(Clone)]
pub(in crate::features::jobs) struct JobCatalogAdapter {
    catalog: CatalogFeature,
}

impl JobCatalogAdapter {
    pub(in crate::features::jobs) fn new(catalog: CatalogFeature) -> Self {
        Self { catalog }
    }
}

impl JobCatalogPort for JobCatalogAdapter {
    async fn refresh(&self, connection_id: ConnectionId) -> AppResult<CatalogSnapshot> {
        self.catalog
            .load_snapshot(connection_id, CatalogReadPolicy::Refresh)
            .await
    }
}
