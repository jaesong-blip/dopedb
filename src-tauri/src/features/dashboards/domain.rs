//! Saved-dashboard values and typed command identities.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::kernel::identity::{ConnectionId, DashboardId, QueryExecutionId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DashboardKind {
    #[default]
    Auto,
    Metric,
    Line,
    Bar,
    Table,
}

const fn dashboard_visualization_version() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardVisualization {
    #[serde(default = "dashboard_visualization_version")]
    pub(crate) version: u32,
    pub(crate) kind: DashboardKind,
    pub(crate) x_column: Option<String>,
    #[serde(default)]
    pub(crate) y_columns: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DashboardState {
    Draft,
    Published,
    Archived,
}

impl DashboardState {
    pub(crate) fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "draft" => Ok(Self::Draft),
            "published" => Ok(Self::Published),
            "archived" => Ok(Self::Archived),
            _ => Err(AppError::Config("dashboard has an invalid state".into())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DashboardSyncStatus {
    Local,
    Dirty,
    Synced,
    Conflict,
}

impl DashboardSyncStatus {
    pub(crate) fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "local" => Ok(Self::Local),
            "dirty" => Ok(Self::Dirty),
            "synced" => Ok(Self::Synced),
            "conflict" => Ok(Self::Conflict),
            _ => Err(AppError::Config(
                "dashboard has an invalid sync status".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Dashboard {
    pub(crate) id: DashboardId,
    pub(crate) connection_id: ConnectionId,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) sql: String,
    pub(crate) visualization: DashboardVisualization,
    pub(crate) state: DashboardState,
    pub(crate) sync_status: DashboardSyncStatus,
    pub(crate) owner_member_id: Option<String>,
    pub(crate) updated_by_member_id: Option<String>,
    pub(crate) revision: i64,
    pub(crate) remote_revision: Option<i64>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardDraft {
    pub(crate) connection_id: ConnectionId,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) description: String,
    pub(crate) sql: String,
    pub(crate) visualization: DashboardVisualization,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentDashboardPresentation {
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) kind: DashboardKind,
    pub(crate) x_column: Option<String>,
    pub(crate) y_columns: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DashboardRunRequest {
    pub(crate) dashboard_id: DashboardId,
    pub(crate) query_id: Option<QueryExecutionId>,
}

#[derive(Debug, Clone)]
pub(crate) struct DashboardDefinitionRunRequest {
    pub(crate) draft: DashboardDraft,
    pub(crate) expected_connection_revision: i64,
    pub(crate) query_id: Option<QueryExecutionId>,
}

#[derive(Debug)]
pub(crate) enum AgentDashboardCreateError {
    QueryRunNotFound,
    QueryRunIneligible,
    InvalidDraft(AppError),
    Application(AppError),
    Persistence(AppError),
}
