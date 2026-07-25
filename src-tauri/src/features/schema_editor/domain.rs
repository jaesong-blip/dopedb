//! Structured schema-editor commands and receipts.

use chrono::{DateTime, Utc};
use dopedb_protocol::{DdlPlan, OperationState, SchemaChangeRequest};
use serde::Serialize;

use crate::kernel::identity::{ConnectionId, OperationId};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SchemaChangeCommand {
    pub(crate) connection_id: ConnectionId,
    pub(crate) request: SchemaChangeRequest,
}

#[derive(Debug, Clone)]
pub(crate) struct SchemaScriptProposalCommand {
    pub(crate) connection_id: ConnectionId,
    pub(crate) request: SchemaChangeRequest,
    pub(crate) plan: DdlPlan,
}

#[derive(Debug, Clone)]
pub(crate) struct SchemaScriptProposal {
    pub(crate) operation_id: OperationId,
    pub(crate) payload_hash: String,
    pub(crate) state: OperationState,
    pub(crate) confirmation_phrase: Option<String>,
    pub(crate) statement_count: usize,
    pub(crate) expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SchemaChangeProposal {
    pub(crate) operation_id: OperationId,
    pub(crate) payload_hash: String,
    pub(crate) state: OperationState,
    pub(crate) confirmation_phrase: Option<String>,
    pub(crate) statement_count: usize,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) plan: DdlPlan,
}
