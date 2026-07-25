//! Dialect-neutral DDL renderer adapter.

use dopedb_protocol::{CatalogSnapshot, DdlPlan, SchemaChangeRequest};

use crate::error::AppResult;

use super::super::ports::SchemaPlannerPort;

#[derive(Clone, Copy)]
pub(in crate::features::schema_editor) struct DdlSchemaPlanner;

impl SchemaPlannerPort for DdlSchemaPlanner {
    fn render(
        &self,
        snapshot: &CatalogSnapshot,
        request: &SchemaChangeRequest,
    ) -> AppResult<DdlPlan> {
        crate::ddl::render(snapshot, request)
    }
}
