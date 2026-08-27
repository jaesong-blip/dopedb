//! Versioned, credential-free Analysis Article contracts.
//!
//! Current definitions are sanitized HTML plus one bounded saved query. Legacy
//! fields remain in the shared read model only so old rows can be projected
//! safely; new Agent input never authors those structures.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisArticleState {
    Draft,
    Review,
    Live,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisArticleSource {
    Human,
    #[serde(rename = "dopedb.acp.claude")]
    DopedbAcpClaude,
    #[serde(rename = "dopedb.acp.codex")]
    DopedbAcpCodex,
    Migration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisParameterType {
    String,
    Number,
    Boolean,
    Date,
    Datetime,
    Enum,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisColumnType {
    String,
    Number,
    Boolean,
    Date,
    Datetime,
    Duration,
    Currency,
    Percent,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisColumnRole {
    Dimension,
    Measure,
    Time,
    Identifier,
    FreeText,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisColumnSensitivity {
    Public,
    Internal,
    Confidential,
    Restricted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisColumnMasking {
    None,
    Redact,
    Hash,
    Bucket,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleConnection {
    #[serde(deserialize_with = "deserialize_contract_uuid")]
    pub connection_id: Uuid,
    pub connection_revision: i64,
    pub role: String,
    pub alias: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisParameter {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub parameter_type: AnalysisParameterType,
    pub required: bool,
    pub default_value: Value,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: AnalysisColumnType,
    pub nullable: bool,
    pub role: AnalysisColumnRole,
    pub sensitivity: AnalysisColumnSensitivity,
    pub masking: AnalysisColumnMasking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisNumberStyle {
    Number,
    Percent,
    Currency,
    Duration,
    Compact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisNumberFormat {
    pub style: AnalysisNumberStyle,
    pub decimals: u8,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub currency: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisMetric {
    pub id: String,
    pub label: String,
    pub description: String,
    pub source_node_id: String,
    pub value_column: String,
    pub unit: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub lower_is_better: Option<bool>,
    pub format: AnalysisNumberFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisQueryNode {
    pub id: String,
    pub title: String,
    pub connection_role: String,
    pub sql: String,
    pub parameter_ids: Vec<String>,
    pub max_rows: u64,
    pub max_bytes: usize,
    pub cache_ttl_seconds: u64,
    pub columns: Vec<AnalysisColumn>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisTransformOperation {
    Project,
    Filter,
    Sort,
    Limit,
    Union,
    Group,
    Aggregate,
    InnerJoin,
    LeftJoin,
    Window,
    Lag,
    Ratio,
    Difference,
    Rate,
    Cohort,
    Retention,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisTransformNode {
    pub id: String,
    pub title: String,
    pub operation: AnalysisTransformOperation,
    pub input_node_ids: Vec<String>,
    pub config: Value,
    pub columns: Vec<AnalysisColumn>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisBlockKind {
    Heading,
    Markdown,
    Callout,
    Divider,
    Metric,
    TimeSeries,
    Bar,
    Area,
    Scatter,
    Table,
    Funnel,
    RetentionCohort,
    Heatmap,
    DateRangeControl,
    ComparisonControl,
    SegmentControl,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisBlock {
    pub id: String,
    pub kind: AnalysisBlockKind,
    pub title: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub source_node_id: Option<String>,
    pub width: u8,
    pub config: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisEvidenceClaim {
    pub id: String,
    pub text: String,
    pub block_ids: Vec<String>,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisRefreshMode {
    Manual,
    Scheduled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisRefreshPolicy {
    pub mode: AnalysisRefreshMode,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub cron: Option<String>,
    pub timezone: String,
    #[serde(deserialize_with = "deserialize_required_contract_uuid_nullable")]
    pub runner_id: Option<Uuid>,
    pub max_staleness_seconds: u64,
    pub result_retention_days: u16,
    pub share_reviewed_results: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleDefinition {
    pub version: u32,
    pub source: AnalysisArticleSource,
    pub title: String,
    pub html: String,
    pub question: String,
    pub summary: String,
    pub timezone: String,
    pub parameters: Vec<AnalysisParameter>,
    pub queries: Vec<AnalysisQueryNode>,
    pub transforms: Vec<AnalysisTransformNode>,
    pub metrics: Vec<AnalysisMetric>,
    pub blocks: Vec<AnalysisBlock>,
    pub claims: Vec<AnalysisEvidenceClaim>,
    pub refresh: AnalysisRefreshPolicy,
    pub warnings: Vec<String>,
}

/// Agent-authored portion of a current Analysis Article. Authority and the
/// fixed manual execution envelope are supplied by the Desktop session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleDraftDefinition {
    pub version: u32,
    pub title: String,
    pub html: String,
    pub query: AnalysisQueryNode,
}

impl AnalysisArticleDraftDefinition {
    pub fn with_source(self, source: AnalysisArticleSource) -> AnalysisArticleDefinition {
        let query = self.query;
        let block = AnalysisBlock {
            id: "query_result".into(),
            kind: AnalysisBlockKind::Table,
            title: "Query result".into(),
            source_node_id: Some(query.id.clone()),
            width: 12,
            config: serde_json::json!({
                "columns": query.columns.iter().map(|column| column.name.clone()).collect::<Vec<_>>(),
                "pageSize": query.max_rows.clamp(10, 500),
            }),
        };
        AnalysisArticleDefinition {
            version: self.version,
            source,
            title: self.title,
            html: self.html,
            question: String::new(),
            summary: String::new(),
            timezone: "UTC".into(),
            parameters: Vec::new(),
            queries: vec![query],
            transforms: Vec::new(),
            metrics: Vec::new(),
            blocks: vec![block],
            claims: Vec::new(),
            refresh: AnalysisRefreshPolicy {
                mode: AnalysisRefreshMode::Manual,
                cron: None,
                timezone: "UTC".into(),
                runner_id: None,
                max_staleness_seconds: 86_400,
                result_retention_days: 30,
                share_reviewed_results: false,
            },
            warnings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedAnalysisArticleCreate {
    #[serde(deserialize_with = "deserialize_contract_uuid")]
    pub id: Uuid,
    #[serde(deserialize_with = "deserialize_contract_uuid")]
    pub project_environment_id: Uuid,
    pub environment_revision: i64,
    #[serde(deserialize_with = "deserialize_required_contract_uuid_nullable")]
    pub source_knowledge_grant_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_contract_uuid_list")]
    pub graph_revision_ids: Vec<Uuid>,
    pub connections: Vec<AnalysisArticleConnection>,
    pub definition: AnalysisArticleDefinition,
}

impl SharedAnalysisArticleCreate {
    /// Validate the semantic create contract shared with Workspace Cloud.
    /// Callers receive only a boolean so invalid declarative content cannot be
    /// copied into transport errors or logs.
    pub fn validate(&self) -> bool {
        crate::analysis_article_validation::shared_create_is_valid(self)
    }
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn deserialize_contract_uuid<'de, D>(deserializer: D) -> Result<Uuid, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    parse_contract_uuid(&value).ok_or_else(|| serde::de::Error::custom("invalid contract UUID"))
}

fn deserialize_required_contract_uuid_nullable<'de, D>(
    deserializer: D,
) -> Result<Option<Uuid>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(|value| {
            parse_contract_uuid(&value)
                .ok_or_else(|| serde::de::Error::custom("invalid contract UUID"))
        })
        .transpose()
}

fn deserialize_contract_uuid_list<'de, D>(deserializer: D) -> Result<Vec<Uuid>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<String>::deserialize(deserializer)?
        .into_iter()
        .map(|value| {
            parse_contract_uuid(&value)
                .ok_or_else(|| serde::de::Error::custom("invalid contract UUID"))
        })
        .collect()
}

fn parse_contract_uuid(value: &str) -> Option<Uuid> {
    let bytes = value.as_bytes();
    (bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'A' | b'b' | b'B'))
    .then(|| Uuid::parse_str(value).ok())
    .flatten()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleVersionPayload {
    pub id: Uuid,
    pub project_environment_id: Uuid,
    pub environment_revision: i64,
    pub source_knowledge_grant_id: Option<Uuid>,
    pub graph_revision_ids: Vec<Uuid>,
    pub connections: Vec<AnalysisArticleConnection>,
    pub definition: AnalysisArticleDefinition,
    pub state: AnalysisArticleState,
    pub owner_member_id: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleRecord {
    pub id: Uuid,
    pub project_environment_id: Uuid,
    pub environment_revision: i64,
    pub source_knowledge_grant_id: Option<Uuid>,
    pub graph_revision_ids: Vec<Uuid>,
    pub connections: Vec<AnalysisArticleConnection>,
    pub definition: AnalysisArticleDefinition,
    pub state: AnalysisArticleState,
    pub owner_member_id: String,
    pub updated_by_member_id: String,
    pub revision: i64,
    pub live_revision: Option<i64>,
    pub live_run_id: Option<Uuid>,
    pub next_refresh_at: Option<DateTime<Utc>>,
    pub latest_successful_run_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisRunTrigger {
    Manual,
    Schedule,
    Signal,
    Publication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisRunState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisQueryState {
    Succeeded,
    Failed,
    Cancelled,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisQueryReceipt {
    pub query_node_id: String,
    pub connection_id: Uuid,
    pub connection_revision: i64,
    pub query_run_id: Uuid,
    pub query_hash: String,
    pub schema_fingerprint: String,
    pub state: AnalysisQueryState,
    pub row_count: u64,
    pub byte_count: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisResultFragment {
    pub version: u32,
    pub block_id: String,
    pub ordinal: u16,
    pub columns: Vec<AnalysisColumn>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisRunError {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisRunReceipt {
    pub id: Uuid,
    pub article_id: Uuid,
    pub article_revision: i64,
    pub state: AnalysisRunState,
    pub parameter_values: BTreeMap<String, Value>,
    pub query_receipts: Vec<AnalysisQueryReceipt>,
    pub fragments: Vec<AnalysisResultFragment>,
    pub result_hash: Option<String>,
    pub error: Option<AnalysisRunError>,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
}
