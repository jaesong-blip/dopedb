//! SQL query contracts and pure planning guidance.
//!
//! These values deliberately contain only typed identities and allowlisted display
//! data; platform persistence, pool handles, and protocol UUID conversion stay in adapters.

use chrono::{DateTime, Utc};

use crate::kernel::identity::{ConnectionId, OperationId, QueryRunId};
use crate::kernel::TerminalAuthority;
use crate::model::{ConnectionProfile, QueryResult};
use crate::monitoring::HealthSnapshot;

/// Broker-only read-plan input bound to one authenticated Terminal authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalQueryPlanRequest {
    pub(crate) connection_id: ConnectionId,
    pub(crate) sql: String,
    pub(crate) max_rows: Option<u64>,
    pub(crate) authority: TerminalAuthority,
}

/// The server-owned purpose for a desktop SQL inspection.
///
/// `ReadOnlyExplain` is deliberately narrower than an operation proposal: it
/// must reject any uncertain or target-mutating shape before credentials or a
/// target pool are requested. `ImpactPreview` may return a static skipped report
/// for a dangerous shape so the proposal workflow can still apply its durable
/// approval gate without opening the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DesktopPreviewIntent {
    ReadOnlyExplain,
    ImpactPreview,
}

/// Atomic desktop SQL inspection input after transport decoding.
///
/// Classification, authority pinning, safety policy capture, and preview are
/// one operation so a caller cannot classify one connection revision and preview
/// another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DesktopSqlInspectionRequest {
    pub(crate) connection_id: ConnectionId,
    pub(crate) sql: String,
    pub(crate) intent: DesktopPreviewIntent,
}

/// Immutable desktop SQL proposal input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DesktopSqlProposalRequest {
    pub(crate) connection_id: ConnectionId,
    pub(crate) sql: String,
    pub(crate) origin: Option<String>,
}

/// One bounded desktop-only page of a read result. It is intentionally not a
/// model contract: CLI, Broker, dashboards, and bounded execution retain their
/// materialized bounded receipt wire.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSqlStreamBatch {
    pub(crate) operation_id: OperationId,
    pub(crate) sequence: u64,
    pub(crate) columns: Vec<String>,
    pub(crate) rows: Vec<Vec<serde_json::Value>>,
}

/// Small notification sent over Tauri Channel; rows remain in the feature-owned
/// registry until the originating renderer proves its one-time capability.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSqlStreamReady {
    pub(crate) operation_id: OperationId,
    pub(crate) sequence: u64,
    pub(crate) capability: String,
}

/// A transport-only sink outcome. It is deliberately feature-owned so core query
/// use cases do not expose the application's platform error type through a port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DesktopSqlStreamSinkError {
    ReceiverDropped,
    AcknowledgementTimedOut,
    StreamAlreadyActive,
    StreamNotActive,
    InvalidAcknowledgement,
    BatchTooLarge,
    Cancelled,
}

impl std::fmt::Display for DesktopSqlStreamSinkError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReceiverDropped => {
                formatter.write_str("desktop query result receiver disconnected")
            }
            Self::AcknowledgementTimedOut => {
                formatter.write_str("desktop query stream acknowledgement timed out")
            }
            Self::StreamAlreadyActive => {
                formatter.write_str("desktop query stream is already active")
            }
            Self::StreamNotActive => formatter.write_str("desktop query stream is not active"),
            Self::InvalidAcknowledgement => {
                formatter.write_str("desktop query stream acknowledgement is invalid")
            }
            Self::BatchTooLarge => {
                formatter.write_str("desktop query stream batch exceeds its safe wire limit")
            }
            Self::Cancelled => formatter.write_str("query cancelled"),
        }
    }
}

/// Terminal SQL proposal input bound to an authenticated authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalSqlProposalRequest {
    pub(crate) connection_id: ConnectionId,
    pub(crate) sql: String,
    pub(crate) authority: TerminalAuthority,
}

/// Trusted local adapter family frozen into an Agent plan and its audit trail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentQueryInvocationOrigin {
    Cli,
}

impl AgentQueryInvocationOrigin {
    pub(crate) const fn as_str(self) -> &'static str {
        "cli"
    }

    pub(crate) const fn plan_audit_action(self) -> &'static str {
        "cli:plan_query"
    }

    pub(crate) const fn run_audit_action(self) -> &'static str {
        "cli:run_query"
    }
}

/// Aggregate-only planning result. It deliberately excludes the full profile and
/// every credential or endpoint field.
#[derive(Debug, Clone)]
pub(crate) struct AgentQueryPlan {
    pub(crate) connection_id: ConnectionId,
    pub(crate) connection_name: String,
    pub(crate) environment: Option<String>,
    pub(crate) plan_id: OperationId,
    pub(crate) decision: String,
    pub(crate) notices: Vec<String>,
    pub(crate) suggestions: Vec<String>,
    pub(crate) estimated_rows: Option<i64>,
    pub(crate) health: HealthSnapshot,
    pub(crate) expires_at: DateTime<Utc>,
}

/// Allowlisted event data retained by an opaque prepared read capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentQueryRunEventContext {
    pub(crate) connection_id: ConnectionId,
    pub(crate) connection_name: String,
    pub(crate) plan_id: OperationId,
    pub(crate) sql: String,
}

/// A successful DB-enforced read and its durable provenance identity.
#[derive(Debug, Clone)]
pub(crate) struct AgentQueryRun {
    pub(crate) connection_id: ConnectionId,
    pub(crate) connection_name: String,
    pub(crate) plan_id: OperationId,
    pub(crate) planning_decision: String,
    pub(crate) query_run_id: QueryRunId,
    pub(crate) result: QueryResult,
}

/// Produces conservative user guidance from already-safe aggregate observations.
pub(crate) fn planning_guidance(
    profile: &ConnectionProfile,
    health: &HealthSnapshot,
    estimated_rows: Option<i64>,
    estimate_limit: i64,
) -> (String, Vec<String>, Vec<String>) {
    let mut caution = false;
    let mut notices = Vec::new();
    let mut suggestions = Vec::new();
    if profile.env.as_deref() == Some("prod") {
        caution = true;
        notices.push("This connection is labeled production.".into());
        suggestions
            .push("Prefer a read replica or a bounded time range for production analysis.".into());
    }
    if health.level != "normal" {
        caution = true;
    }
    notices.extend(health.reasons.clone());
    if health.coverage == "limited" {
        caution = true;
        suggestions.push(
            "Enable PostgreSQL pg_monitor in DopeDB settings for fuller aggregate load checks."
                .into(),
        );
    }
    match estimated_rows {
        Some(rows) if rows > estimate_limit.max(0) => {
            caution = true;
            notices.push(format!("EXPLAIN estimates {rows} result/plan rows, above the configured {estimate_limit} review threshold."));
            suggestions.push("Add a selective time/filter condition or aggregate before joining large log tables.".into());
        }
        None if profile.env.as_deref() == Some("prod") => {
            caution = true;
            notices.push(
                "EXPLAIN did not provide a usable row estimate for this production query.".into(),
            );
            suggestions.push("Review the plan and narrow the query before execution.".into());
        }
        _ => {}
    }
    if health.level == "busy" {
        suggestions.push("Wait for database pressure to fall before running this query.".into());
    }
    suggestions.sort();
    suggestions.dedup();
    (
        if caution { "caution" } else { "ready" }.into(),
        notices,
        suggestions,
    )
}
