//! Shared desktop SQL policy, preview, and best-effort provenance support.

use chrono::Utc;
use uuid::Uuid;

use crate::audit::{self, RecordArgs};
use crate::connection::{ConnectionAccess, DbPool};
use crate::model::{
    Classification, HistoryEntry, PreviewMode, PreviewReport, QueryKind, SafetySettings,
};
use crate::operations::{OperationKind, OperationRiskLevel};
use crate::safety::PoolRef;
use crate::store::{PinnedConnection, Store};

pub(super) fn operation_kind(kind: QueryKind) -> OperationKind {
    match kind {
        QueryKind::Read => OperationKind::ReadQuery,
        QueryKind::Write => OperationKind::WriteSql,
        QueryKind::Ddl => OperationKind::Ddl,
        QueryKind::Privilege => OperationKind::Privilege,
    }
}

pub(super) fn operation_risk(classification: &Classification) -> OperationRiskLevel {
    if classification.no_where && !matches!(classification.kind, QueryKind::Read) {
        return OperationRiskLevel::Critical;
    }
    match classification.risk {
        crate::model::RiskLevel::Low => OperationRiskLevel::Low,
        crate::model::RiskLevel::Medium => OperationRiskLevel::Medium,
        crate::model::RiskLevel::High => OperationRiskLevel::High,
    }
}

pub(super) fn desktop_preview_connection_access(
    _classification: &Classification,
    _settings: &SafetySettings,
) -> ConnectionAccess {
    ConnectionAccess::Read
}

pub(super) fn skipped_preview_report(note: &str) -> PreviewReport {
    PreviewReport {
        mode: PreviewMode::Skipped,
        estimated_rows: None,
        exact_rows: None,
        plan: None,
        note: Some(note.into()),
    }
}

pub(super) struct DesktopRunRecord<'a> {
    pub(super) sql: &'a str,
    pub(super) kind: QueryKind,
    pub(super) action: &'a str,
    pub(super) status: &'a str,
    pub(super) row_count: Option<i64>,
    pub(super) duration_ms: Option<i64>,
    pub(super) error: Option<String>,
    pub(super) origin: &'a str,
}

/// Append the established desktop audit and history pair. Logging remains
/// best-effort so provenance outages do not mask the target operation result.
pub(super) async fn record_desktop_run(
    store: &Store,
    pin: &PinnedConnection,
    record: DesktopRunRecord<'_>,
) {
    if let Err(error) = audit::record(
        store,
        RecordArgs {
            connection_id: pin.connection_id,
            engine: pin.profile.engine,
            agent_prompt: None,
            sql: record.sql.to_string(),
            kind: record.kind,
            action: record.action.to_string(),
            approved_by: None,
            affected_estimate: record.row_count,
            error: record.error.clone(),
        },
    )
    .await
    {
        tracing::error!(
            connection_id = %pin.connection_id,
            action = record.action,
            %error,
            "desktop SQL audit record failed"
        );
    }
    if let Err(error) = store
        .insert_history_if_current(
            pin,
            &HistoryEntry {
                id: Uuid::new_v4(),
                connection_id: pin.connection_id,
                sql: record.sql.to_string(),
                kind: record.kind,
                status: record.status.to_string(),
                row_count: record.row_count,
                duration_ms: record.duration_ms,
                error: record.error,
                executed_at: Utc::now(),
                origin: record.origin.to_string(),
            },
        )
        .await
    {
        tracing::error!(
            connection_id = %pin.connection_id,
            %error,
            "desktop SQL history insert failed"
        );
    }
}

pub(super) fn pool_ref(db: &DbPool) -> PoolRef<'_> {
    match db {
        DbPool::Postgres(pool) => PoolRef::Postgres(pool),
        DbPool::Mysql(pool) => PoolRef::Mysql(pool),
        DbPool::Sqlite(pool) => PoolRef::Sqlite(pool),
    }
}
