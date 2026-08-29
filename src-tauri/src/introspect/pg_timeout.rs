use std::time::{Duration, Instant};

use crate::error::AppError;

/// The core relation tree has a fixed ceiling.  It is intentionally separate from
/// target connection establishment and workspace authorization, which complete
/// before this module is entered and must retain their own error semantics.
pub(super) const CORE_RELATION_TIMEOUT: Duration = Duration::from_secs(5);
/// Detailed metadata shares one bounded scan budget so a large schema cannot turn
/// six individually-valid statements into an unbounded foreground operation.
pub(super) const DETAIL_SCAN_BUDGET: Duration = Duration::from_secs(45);
pub(super) const DETAIL_STAGE_MIN_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const DETAIL_STAGE_MAX_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug)]
pub(super) enum MetadataStage {
    Columns,
    Constraints,
    ForeignKeys,
    Indexes,
    ServerVersion,
    Objects,
}

impl MetadataStage {
    pub(super) const fn name(self) -> &'static str {
        match self {
            Self::Columns => "columns",
            Self::Constraints => "constraints",
            Self::ForeignKeys => "foreign_keys",
            Self::Indexes => "indexes",
            Self::ServerVersion => "server_version",
            Self::Objects => "objects",
        }
    }
}

/// Scale the maximum wait for one detail stage with the useful part of the schema,
/// then clamp it.  The remaining global budget is applied separately at execution
/// time, so this function cannot increase total foreground latency.
pub(super) fn adaptive_detail_stage_timeout(relation_count: usize) -> Duration {
    let extra = Duration::from_millis((relation_count as u64).saturating_mul(25));
    DETAIL_STAGE_MIN_TIMEOUT
        .saturating_add(extra)
        .min(DETAIL_STAGE_MAX_TIMEOUT)
}

pub(super) fn remaining_detail_timeout(
    started: Instant,
    relation_count: usize,
) -> Option<Duration> {
    let remaining = DETAIL_SCAN_BUDGET.checked_sub(started.elapsed())?;
    if remaining < DETAIL_STAGE_MIN_TIMEOUT {
        return None;
    }
    Some(adaptive_detail_stage_timeout(relation_count).min(remaining))
}

pub(super) fn statement_timeout_sql(timeout: Duration) -> String {
    // The duration is generated only from the bounded constants above.  PostgreSQL
    // does not consistently accept a bind parameter for SET LOCAL across versions.
    format!(
        "SET LOCAL statement_timeout = {}",
        timeout.as_millis().max(1)
    )
}

pub(super) fn is_statement_timeout_details(code: Option<&str>, message: &str) -> bool {
    // SQLSTATE 57014 covers both a local statement_timeout and an explicit
    // cancellation (for example pg_cancel_backend). Only rewrite the timeout we
    // installed; callers must still see manual/admin cancellation as a DB error.
    code == Some("57014") && message.to_ascii_lowercase().contains("statement timeout")
}

pub(super) fn is_statement_timeout(error: &sqlx::Error) -> bool {
    error.as_database_error().is_some_and(|database| {
        is_statement_timeout_details(database.code().as_deref(), database.message())
    })
}

pub(super) fn catalog_stage_timeout(stage: &str, elapsed: Duration, limit: Duration) -> AppError {
    AppError::Timeout(format!(
        "PostgreSQL catalog {stage} metadata timed out after {} ms (limit {} ms); retry schema loading",
        elapsed.as_millis(),
        limit.as_millis()
    ))
}

pub(super) fn catalog_detail_budget_exhausted(stage: &str, elapsed: Duration) -> AppError {
    AppError::Timeout(format!(
        "PostgreSQL catalog detail budget expired before {stage} after {} ms; retry schema loading",
        elapsed.as_millis()
    ))
}
