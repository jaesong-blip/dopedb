//! Analysis Article runtime-only values.

use std::collections::BTreeMap;

use dopedb_protocol::{
    AnalysisArticleDefinition, AnalysisColumn, AnalysisQueryReceipt, AnalysisResultFragment,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisDefinitionRunRequest {
    #[serde(default)]
    pub(crate) workspace_id: Option<Uuid>,
    pub(crate) article_id: Uuid,
    pub(crate) article_revision: i64,
    pub(crate) definition: AnalysisArticleDefinition,
    pub(crate) connections: Vec<dopedb_protocol::AnalysisArticleConnection>,
    #[serde(default)]
    pub(crate) parameter_values: BTreeMap<String, Value>,
    pub(crate) run_id: Uuid,
    #[serde(default)]
    pub(crate) persist_local_result: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct AnalysisDataSet {
    pub(crate) columns: Vec<AnalysisColumn>,
    pub(crate) rows: Vec<Vec<Value>>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalysisDefinitionRunReceipt {
    pub(crate) run_id: Uuid,
    pub(crate) article_id: Uuid,
    pub(crate) article_revision: i64,
    pub(crate) parameter_values: BTreeMap<String, Value>,
    pub(crate) query_receipts: Vec<AnalysisQueryReceipt>,
    pub(crate) fragments: Vec<AnalysisResultFragment>,
    pub(crate) result_hash: String,
    pub(crate) started_at: chrono::DateTime<chrono::Utc>,
    pub(crate) finished_at: chrono::DateTime<chrono::Utc>,
}
