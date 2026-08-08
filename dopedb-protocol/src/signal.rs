//! Secret-free contracts for evaluating a published dashboard metric on an
//! explicitly selected Desktop runner.
//!
//! These values deliberately have no SQL, result value, result row, credential,
//! host, schema, transcript, or local artifact field. The control plane may
//! schedule and deduplicate work, but only a Desktop process holding the exact
//! member grants can execute it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SIGNAL_RULE_SCHEMA_VERSION: u16 = 1;
pub const MAX_SIGNAL_CONNECTIONS: usize = 32;
pub const MAX_SIGNAL_RECIPIENTS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalNotificationChannel {
    Desktop,
    WorkspaceWeb,
    Email,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SignalCondition {
    ThresholdAbove { value: f64 },
    ThresholdBelow { value: f64 },
    AbsoluteChange { value: f64 },
    PercentageChange { percentage: f64 },
    ConsecutiveFailure { count: u16 },
    MissingData { count: u16 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignalRuleDefinitionV1 {
    pub schema_version: u16,
    pub rule_id: Uuid,
    pub project_environment_id: Uuid,
    pub environment_revision: u64,
    pub source_analysis_id: Uuid,
    pub source_analysis_revision: u64,
    pub source_tile_id: String,
    pub metric_semantic_id: String,
    pub connection_ids: Vec<Uuid>,
    pub schedule: String,
    pub timezone: String,
    pub evaluation_window_seconds: u64,
    pub condition: SignalCondition,
    pub baseline_window_seconds: Option<u64>,
    pub minimum_sample_count: u64,
    pub cooldown_seconds: u64,
    pub rearm_after_normal_count: u16,
    pub severity: SignalSeverity,
    pub recipient_member_ids: Vec<String>,
    pub channels: Vec<SignalNotificationChannel>,
    pub enabled: bool,
    pub revision: u64,
    pub production_approved_by_member_id: Option<String>,
    pub production_approved_at: Option<DateTime<Utc>>,
}

impl SignalRuleDefinitionV1 {
    pub fn validate(&self) -> bool {
        self.schema_version == SIGNAL_RULE_SCHEMA_VERSION
            && self.environment_revision > 0
            && self.source_analysis_revision > 0
            && self.revision > 0
            && safe_text(&self.source_tile_id, 64)
            && safe_text(&self.metric_semantic_id, 256)
            && safe_text(&self.schedule, 256)
            && safe_text(&self.timezone, 128)
            && self.evaluation_window_seconds > 0
            && self.evaluation_window_seconds <= 31_622_400
            && self
                .baseline_window_seconds
                .is_none_or(|window| window > 0 && window <= 31_622_400)
            && self.minimum_sample_count <= 1_000_000_000
            && self.cooldown_seconds <= 31_622_400
            && self.rearm_after_normal_count > 0
            && self.connection_ids.len() > 0
            && self.connection_ids.len() <= MAX_SIGNAL_CONNECTIONS
            && unique(&self.connection_ids)
            && !self.recipient_member_ids.is_empty()
            && self.recipient_member_ids.len() <= MAX_SIGNAL_RECIPIENTS
            && self
                .recipient_member_ids
                .iter()
                .all(|member| safe_text(member, 256))
            && unique(&self.recipient_member_ids)
            && !self.channels.is_empty()
            && unique(&self.channels)
            && valid_condition(&self.condition)
            && self.production_approved_by_member_id.is_some()
                == self.production_approved_at.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalEvaluationState {
    Normal,
    Firing,
    Recovered,
    NoData,
    Error,
    Stale,
    RunnerOffline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalRowCountCategory {
    Zero,
    One,
    Small,
    Medium,
    Large,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalEvaluationErrorKind {
    QueryFailed,
    AuthorizationChanged,
    CredentialUnavailable,
    SchemaChanged,
    Timeout,
    Cancelled,
    RunnerError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignalEvaluationReceiptV1 {
    pub receipt_id: Uuid,
    pub rule_id: Uuid,
    pub rule_revision: u64,
    pub project_environment_id: Uuid,
    pub environment_revision: u64,
    pub runner_device_id: String,
    pub scheduled_at: DateTime<Utc>,
    pub evaluated_at: DateTime<Utc>,
    pub state: SignalEvaluationState,
    pub query_run_ids: Vec<Uuid>,
    pub connection_ids: Vec<Uuid>,
    pub duration_ms: u64,
    pub row_count_category: SignalRowCountCategory,
    pub schema_fingerprint: String,
    pub dedupe_key: String,
    pub transition_sequence: u64,
    pub error_kind: Option<SignalEvaluationErrorKind>,
}

impl SignalEvaluationReceiptV1 {
    pub fn validate(&self) -> bool {
        self.rule_revision > 0
            && self.environment_revision > 0
            && safe_text(&self.runner_device_id, 256)
            && self.evaluated_at >= self.scheduled_at
            && self.query_run_ids.len() <= MAX_SIGNAL_CONNECTIONS
            && unique(&self.query_run_ids)
            && !self.connection_ids.is_empty()
            && self.connection_ids.len() <= MAX_SIGNAL_CONNECTIONS
            && unique(&self.connection_ids)
            && sha256(&self.schema_fingerprint)
            && safe_text(&self.dedupe_key, 256)
            && self.transition_sequence > 0
            && (matches!(self.state, SignalEvaluationState::Error) == self.error_kind.is_some())
    }
}

fn valid_condition(condition: &SignalCondition) -> bool {
    match condition {
        SignalCondition::ThresholdAbove { value }
        | SignalCondition::ThresholdBelow { value }
        | SignalCondition::AbsoluteChange { value } => value.is_finite(),
        SignalCondition::PercentageChange { percentage } => {
            percentage.is_finite() && *percentage >= 0.0
        }
        SignalCondition::ConsecutiveFailure { count } | SignalCondition::MissingData { count } => {
            *count > 0 && *count <= 1_000
        }
    }
}

fn safe_text(value: &str, max_chars: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && value.chars().count() <= max_chars
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn unique<T: Ord + Clone>(values: &[T]) -> bool {
    let mut copy = values.to_vec();
    copy.sort_unstable();
    copy.dedup();
    copy.len() == values.len()
}
