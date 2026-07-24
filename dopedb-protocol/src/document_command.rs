//! Typed MongoDB read contracts for the Terminal-scoped local broker.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{AuthenticationRequirement, CommandName, CommandSpec, ConnectionSelector};

/// One typed, read-only MongoDB request. There is deliberately no raw-command
/// variant: every operation is classified from this bounded shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op", deny_unknown_fields)]
pub enum DocumentQuery {
    Find {
        collection: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filter: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        projection: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sort: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skip: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u64>,
    },
    Aggregate {
        collection: String,
        pipeline: Vec<Value>,
    },
    Count {
        collection: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filter: Option<Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentRunArguments {
    pub connection: ConnectionSelector,
    pub query: DocumentQuery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rows: Option<u64>,
}

pub struct DocumentRunCommand;

impl CommandSpec for DocumentRunCommand {
    type Arguments = DocumentRunArguments;
    type Result = DocumentRunResult;

    const NAME: CommandName = CommandName::DocumentRun;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::TerminalSession;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentPage {
    pub documents: Vec<Value>,
    pub doc_count: usize,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentRunResult {
    pub operation_id: Uuid,
    pub connection_id: Uuid,
    pub connection_name: String,
    pub query: DocumentQuery,
    pub result: DocumentPage,
}
