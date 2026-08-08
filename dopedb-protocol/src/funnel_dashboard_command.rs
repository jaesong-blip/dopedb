//! Human-reviewable, Environment-scoped funnel dashboard proposals.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AcpPluginId, AuthenticationRequirement, CommandName, CommandSpec, DashboardRecord,
    EmptyArguments,
};

pub const MAX_FUNNEL_STEPS: usize = 32;
pub const MAX_FUNNEL_TILES: usize = 32;
pub const MAX_FUNNEL_WARNINGS: usize = 32;
pub const MAX_FUNNEL_REFERENCES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FunnelMappingState {
    Inferred,
    Confirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FunnelTileKind {
    Metric,
    Funnel,
    TimeSeries,
    Breakdown,
    Table,
    Markdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FunnelMetricOperation {
    Funnel,
    Ratio,
    Sum,
    Difference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunnelMetricInput {
    pub tile_id: String,
    pub label: String,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunnelMetricComposition {
    pub operation: FunnelMetricOperation,
    pub inputs: Vec<FunnelMetricInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FunnelTileAvailability {
    Ready,
    MissingGrant,
    StaleDashboard,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FunnelAnalysisFreshness {
    Current,
    GraphDrift,
    SchemaDrift,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunnelStepDefinition {
    pub id: String,
    pub label: String,
    pub meaning: String,
    pub connection_role: String,
    pub entity_key: String,
    pub timestamp_field: String,
    pub ordering_rule: String,
    pub mapping_state: FunnelMappingState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapping_proposal_id: Option<Uuid>,
    #[serde(default)]
    pub graph_node_ids: Vec<String>,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunnelTileDefinition {
    pub id: String,
    pub title: String,
    pub kind: FunnelTileKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dashboard_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_dashboard_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_run_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composition: Option<FunnelMetricComposition>,
    #[serde(default)]
    pub step_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunnelDashboardProposeArguments {
    pub title: String,
    pub question: String,
    pub purpose: String,
    pub timezone: String,
    pub time_range: String,
    pub segment_filters: Vec<String>,
    pub conversion_window_seconds: u64,
    pub denominator_semantics: String,
    pub numerator_semantics: String,
    pub deduplication_policy: String,
    pub late_event_policy: String,
    pub steps: Vec<FunnelStepDefinition>,
    pub tiles: Vec<FunnelTileDefinition>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunnelDashboardTileRecord {
    pub definition: FunnelTileDefinition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dashboard: Option<DashboardRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_revision: Option<i64>,
    pub availability: FunnelTileAvailability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunnelAnalysisArtifactRecord {
    pub id: Uuid,
    pub project_environment_id: Uuid,
    pub environment_revision: u64,
    pub knowledge_grant_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_from_knowledge_grant_id: Option<Uuid>,
    pub graph_revision_ids: Vec<Uuid>,
    pub source_agent: AcpPluginId,
    pub title: String,
    pub question: String,
    pub purpose: String,
    pub timezone: String,
    pub time_range: String,
    pub segment_filters: Vec<String>,
    pub conversion_window_seconds: u64,
    pub denominator_semantics: String,
    pub numerator_semantics: String,
    pub deduplication_policy: String,
    pub late_event_policy: String,
    pub steps: Vec<FunnelStepDefinition>,
    pub tiles: Vec<FunnelDashboardTileRecord>,
    pub warnings: Vec<String>,
    pub freshness: FunnelAnalysisFreshness,
    pub state: String,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunnelDashboardProposeResult {
    pub artifact: FunnelAnalysisArtifactRecord,
}

pub struct FunnelDashboardProposeCommand;

impl CommandSpec for FunnelDashboardProposeCommand {
    type Arguments = FunnelDashboardProposeArguments;
    type Result = FunnelDashboardProposeResult;

    const NAME: CommandName = CommandName::FunnelDashboardPropose;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::TerminalSession;
}

pub struct FunnelDashboardListCommand;

impl CommandSpec for FunnelDashboardListCommand {
    type Arguments = EmptyArguments;
    type Result = Vec<FunnelAnalysisArtifactRecord>;

    const NAME: CommandName = CommandName::FunnelDashboardList;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::TerminalSession;
}
