//! Read-only dashboard execution adapter with audit/history recording.

use std::fmt;

use chrono::Utc;

use crate::audit::{self, RecordArgs};
use crate::connection::{
    ConnectionAccess, ConnectionLease, ConnectionManager, ConnectionOperationScope, DbPool,
};
use crate::error::AppError;
use crate::executor;
use crate::model::{HistoryEntry, QueryKind, QueryResult};
use crate::safety::{self, PoolRef};
use crate::store::{PinnedConnection, Store};

use super::super::domain::{DashboardDraft, DashboardRunRequest};
use super::super::ports::DashboardRunPort;
use super::super::validation;

pub(crate) struct DashboardRunReceipt {
    pub(in crate::features::dashboards) result: QueryResult,
    _lease: ConnectionLease,
}

impl serde::Serialize for DashboardRunReceipt {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serde::Serialize::serialize(&self.result, serializer)
    }
}

pub(crate) struct DashboardRunScopedFailure {
    pub(in crate::features::dashboards) error: AppError,
    _scope: ConnectionOperationScope,
}

impl fmt::Debug for DashboardRunScopedFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DashboardRunScopedFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

pub(crate) struct DashboardRunExecutionFailure {
    pub(in crate::features::dashboards) error: AppError,
    _lease: ConnectionLease,
}

impl fmt::Debug for DashboardRunExecutionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DashboardRunExecutionFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub(in crate::features::dashboards) struct DashboardRunner {
    store: Store,
    connections: ConnectionManager,
}

impl DashboardRunner {
    pub(in crate::features::dashboards) fn new(
        store: Store,
        connections: ConnectionManager,
    ) -> Self {
        Self { store, connections }
    }
}

impl DashboardRunPort for DashboardRunner {
    type Receipt = DashboardRunReceipt;
    type Error = DashboardRunError;

    async fn run(&self, request: DashboardRunRequest) -> Result<Self::Receipt, Self::Error> {
        self.run_scoped(request).await
    }
}

#[derive(Debug)]
pub(crate) enum DashboardRunError {
    Application(AppError),
    Scoped(DashboardRunScopedFailure),
    Execution(Box<DashboardRunExecutionFailure>),
}

impl DashboardRunError {
    pub(crate) fn into_error(self) -> AppError {
        match self {
            Self::Application(error) => error,
            Self::Scoped(failure) => failure.error,
            Self::Execution(failure) => failure.error,
        }
    }
}

impl DashboardRunner {
    async fn run_scoped(
        &self,
        request: DashboardRunRequest,
    ) -> Result<DashboardRunReceipt, DashboardRunError> {
        let operation_scope = self.connections.begin_operation_scope().await;
        let dashboard = match self.store.get_dashboard(request.dashboard_id).await {
            Ok(dashboard) => dashboard,
            Err(error) => {
                return Err(DashboardRunError::Scoped(DashboardRunScopedFailure {
                    error,
                    _scope: operation_scope,
                }))
            }
        };
        let operation_pin = match operation_scope
            .pin_connection(dashboard.connection_id.into())
            .await
        {
            Ok(pin) => pin,
            Err(error) => {
                return Err(DashboardRunError::Scoped(DashboardRunScopedFailure {
                    error,
                    _scope: operation_scope,
                }))
            }
        };
        let draft = DashboardDraft {
            connection_id: dashboard.connection_id,
            title: dashboard.title.clone(),
            description: dashboard.description.clone(),
            sql: dashboard.sql.clone(),
            visualization: dashboard.visualization.clone(),
        };
        if let Err(error) = validation::validate_draft(&draft, operation_pin.profile.engine) {
            let kind = safety::classify(&dashboard.sql, operation_pin.profile.engine)
                .map(|classification| classification.kind)
                .unwrap_or(QueryKind::Write);
            record_dashboard_run(
                &self.store,
                &operation_pin,
                DashboardRunRecord {
                    sql: &dashboard.sql,
                    kind,
                    status: "blocked",
                    row_count: None,
                    duration_ms: None,
                    error: Some(error.to_string()),
                },
            )
            .await;
            return Err(DashboardRunError::Scoped(DashboardRunScopedFailure {
                error,
                _scope: operation_scope,
            }));
        }
        let settings = match self.store.get_safety(dashboard.connection_id.into()).await {
            Ok(settings) => settings,
            Err(error) => {
                return Err(DashboardRunError::Scoped(DashboardRunScopedFailure {
                    error,
                    _scope: operation_scope,
                }))
            }
        };
        let lease = match operation_scope
            .connect(operation_pin.clone(), ConnectionAccess::Read)
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                record_dashboard_run(
                    &self.store,
                    &operation_pin,
                    DashboardRunRecord {
                        sql: &dashboard.sql,
                        kind: QueryKind::Read,
                        status: "error",
                        row_count: None,
                        duration_ms: None,
                        error: Some(error.to_string()),
                    },
                )
                .await;
                return Err(DashboardRunError::Application(error));
            }
        };
        let live = match lease.live().sql() {
            Ok(live) => live,
            Err(error) => {
                return Err(DashboardRunError::Execution(Box::new(
                    DashboardRunExecutionFailure {
                        error,
                        _lease: lease,
                    },
                )))
            }
        };
        let max_rows = settings.max_rows.clamp(1, 100_000);
        let run = safety::run_read_only(pool_ref(live.ro()), &dashboard.sql, max_rows);
        match executor::cancel::guard(
            request.query_id.map(Into::into),
            executor::cancel::QUERY_TIMEOUT,
            run,
        )
        .await
        {
            Ok(result) => {
                record_dashboard_run(
                    &self.store,
                    &operation_pin,
                    DashboardRunRecord {
                        sql: &dashboard.sql,
                        kind: QueryKind::Read,
                        status: "ok",
                        row_count: Some(result.row_count as i64),
                        duration_ms: Some(result.duration_ms as i64),
                        error: None,
                    },
                )
                .await;
                Ok(DashboardRunReceipt {
                    result,
                    _lease: lease,
                })
            }
            Err(error) => {
                record_dashboard_run(
                    &self.store,
                    &operation_pin,
                    DashboardRunRecord {
                        sql: &dashboard.sql,
                        kind: QueryKind::Read,
                        status: "error",
                        row_count: None,
                        duration_ms: None,
                        error: Some(error.to_string()),
                    },
                )
                .await;
                Err(DashboardRunError::Execution(Box::new(
                    DashboardRunExecutionFailure {
                        error,
                        _lease: lease,
                    },
                )))
            }
        }
    }
}

struct DashboardRunRecord<'a> {
    sql: &'a str,
    kind: QueryKind,
    status: &'a str,
    row_count: Option<i64>,
    duration_ms: Option<i64>,
    error: Option<String>,
}

async fn record_dashboard_run(
    store: &Store,
    pin: &PinnedConnection,
    record: DashboardRunRecord<'_>,
) {
    if let Err(error) = audit::record(
        store,
        RecordArgs {
            connection_id: pin.connection_id,
            engine: pin.profile.engine,
            agent_prompt: None,
            sql: record.sql.to_string(),
            kind: record.kind,
            action: "dashboard:run".into(),
            approved_by: None,
            affected_estimate: record.row_count,
            error: record.error.clone(),
        },
    )
    .await
    {
        tracing::error!(connection_id = %pin.connection_id, %error, "dashboard run audit record failed");
    }
    if let Err(error) = store
        .insert_history_if_current(
            pin,
            &HistoryEntry {
                id: uuid::Uuid::new_v4(),
                connection_id: pin.connection_id,
                sql: record.sql.to_string(),
                kind: record.kind,
                status: record.status.to_string(),
                row_count: record.row_count,
                duration_ms: record.duration_ms,
                error: record.error,
                executed_at: Utc::now(),
                origin: "dashboard".into(),
            },
        )
        .await
    {
        tracing::error!(connection_id = %pin.connection_id, %error, "dashboard run history insert failed");
    }
}

fn pool_ref(db: &DbPool) -> PoolRef<'_> {
    match db {
        DbPool::Postgres(pool) => PoolRef::Postgres(pool),
        DbPool::Mysql(pool) => PoolRef::Mysql(pool),
        DbPool::Sqlite(pool) => PoolRef::Sqlite(pool),
    }
}
