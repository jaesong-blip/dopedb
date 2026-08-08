//! Provenance-bound dashboard creation contracts for the local broker.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AuthenticationRequirement, CommandName, CommandSpec, ConnectionSelector};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DashboardKind {
    Auto,
    Metric,
    Line,
    Bar,
    Table,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardCreateArguments {
    pub query_run_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<ConnectionSelector>,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub kind: DashboardKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_column: Option<String>,
    #[serde(default)]
    pub y_columns: Vec<String>,
}

pub struct DashboardCreateCommand;

impl CommandSpec for DashboardCreateCommand {
    type Arguments = DashboardCreateArguments;
    type Result = DashboardCreateResult;

    const NAME: CommandName = CommandName::DashboardCreate;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::TerminalSession;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardVisualization {
    pub version: u32,
    pub kind: DashboardKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_column: Option<String>,
    pub y_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardRecord {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub revision: i64,
    pub title: String,
    pub description: String,
    pub sql: String,
    pub visualization: DashboardVisualization,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardCreateResult {
    pub query_run_id: Uuid,
    pub dashboard: DashboardRecord,
}
