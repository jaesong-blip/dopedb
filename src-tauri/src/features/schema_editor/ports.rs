//! Platform contracts required by structured schema-editor use cases.

use std::future::Future;

use dopedb_protocol::{CatalogSnapshot, DdlPlan, SchemaChangeRequest};
use serde::Serialize;

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionId, OperationId};

use super::domain::{SchemaScriptProposal, SchemaScriptProposalCommand};

pub(crate) trait SchemaCatalogPort: Clone + Send + Sync + 'static {
    fn refresh(
        &self,
        connection_id: ConnectionId,
    ) -> impl Future<Output = AppResult<CatalogSnapshot>> + Send;
}

pub(crate) trait SchemaPlannerPort: Clone + Send + Sync + 'static {
    fn render(
        &self,
        snapshot: &CatalogSnapshot,
        request: &SchemaChangeRequest,
    ) -> AppResult<DdlPlan>;
}

pub(crate) trait SchemaScriptPort: Clone + Send + Sync + 'static {
    type RunReceipt: Serialize + Send;

    fn propose(
        &self,
        command: SchemaScriptProposalCommand,
    ) -> impl Future<Output = AppResult<SchemaScriptProposal>> + Send;

    fn run(
        &self,
        operation_id: OperationId,
    ) -> impl Future<Output = AppResult<Self::RunReceipt>> + Send;
}
