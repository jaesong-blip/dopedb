//! Scope-aware database monitoring status and fixed PostgreSQL role changes.

mod adapters;
mod application;
mod ports;
mod recording;

#[cfg(test)]
mod tests;

use std::fmt;

use chrono::{Duration as ChronoDuration, Utc};
use dopedb_protocol::{OperationKind, OperationRiskLevel, OperationState};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::audit::{self, RecordArgs};
use crate::connection::{
    ConnectionAccess, ConnectionLease, ConnectionManager, ConnectionOperationScope,
};
use crate::error::AppError;
use crate::model::{Engine, HistoryEntry, MonitoringStatus, QueryKind};
use crate::monitoring;
use crate::operations::{
    actor_for_pin, capture_policy, ensure_operation_scope, required_confirmation, NewOperation,
    OperationPlanDisposition, OperationRuntime,
};
use crate::store::{PinnedConnection, Store};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MonitoringProposalRequest {
    pub(crate) connection_id: Uuid,
    pub(crate) enabled: bool,
}

/// Exact fixed-role operation rendered before the desktop may approve it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonitoringProposalReceipt {
    pub(crate) operation_id: Uuid,
    pub(crate) payload_hash: String,
    pub(crate) state: OperationState,
    pub(crate) enabled: bool,
    pub(crate) sql: String,
    pub(crate) confirmation_phrase: Option<String>,
    pub(crate) expires_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMonitoringPayload {
    enabled: bool,
    sql: String,
}

/// Monitoring response retaining either a metadata scope or a live target lease
/// through adapter serialization.
pub(crate) struct MonitoringStatusReceipt {
    status: MonitoringStatus,
    _scope: Option<ConnectionOperationScope>,
    _lease: Option<ConnectionLease>,
}

impl MonitoringStatusReceipt {
    fn scoped(status: MonitoringStatus, scope: ConnectionOperationScope) -> Self {
        Self {
            status,
            _scope: Some(scope),
            _lease: None,
        }
    }

    fn leased(status: MonitoringStatus, lease: ConnectionLease) -> Self {
        Self {
            status,
            _scope: None,
            _lease: Some(lease),
        }
    }
}

impl serde::Serialize for MonitoringStatusReceipt {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serde::Serialize::serialize(&self.status, serializer)
    }
}

#[derive(Debug)]
pub(crate) enum MonitoringError {
    Application(AppError),
    Scoped(MonitoringScopedFailure),
    Execution(Box<MonitoringExecutionFailure>),
}

impl MonitoringError {
    pub(crate) fn into_error(self) -> AppError {
        match self {
            Self::Application(error) => error,
            Self::Scoped(failure) => failure.into_error(),
            Self::Execution(failure) => failure.into_error(),
        }
    }
}

pub(crate) struct MonitoringScopedFailure {
    error: AppError,
    _scope: ConnectionOperationScope,
}

impl fmt::Debug for MonitoringScopedFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MonitoringScopedFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl MonitoringScopedFailure {
    fn into_error(self) -> AppError {
        self.error
    }
}

pub(crate) struct MonitoringExecutionFailure {
    error: AppError,
    _lease: ConnectionLease,
}

impl fmt::Debug for MonitoringExecutionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MonitoringExecutionFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl MonitoringExecutionFailure {
    fn into_error(self) -> AppError {
        self.error
    }
}

#[derive(Clone)]
struct MonitoringPlatformAdapter {
    store: Store,
    connections: ConnectionManager,
    operation: OperationRuntime,
}

use application::MonitoringUseCases;
use ports::MonitoringPort;
use recording::*;

type ComposedMonitoringApplication = MonitoringUseCases<MonitoringPlatformAdapter>;

/// Public Monitoring feature boundary.
#[derive(Clone)]
pub(crate) struct MonitoringFeature {
    application: ComposedMonitoringApplication,
}

impl MonitoringFeature {
    pub(crate) async fn status(
        &self,
        connection_id: Uuid,
    ) -> Result<MonitoringStatusReceipt, MonitoringError> {
        self.application.status(connection_id).await
    }

    pub(crate) async fn propose_postgres_role(
        &self,
        request: MonitoringProposalRequest,
    ) -> Result<MonitoringProposalReceipt, MonitoringError> {
        self.application.propose_postgres_role(request).await
    }

    pub(crate) async fn run_postgres_role(
        &self,
        operation_id: Uuid,
    ) -> Result<MonitoringStatusReceipt, MonitoringError> {
        self.application.run_postgres_role(operation_id).await
    }
}

pub(crate) fn compose(
    store: Store,
    connections: ConnectionManager,
    operation: OperationRuntime,
) -> MonitoringFeature {
    MonitoringFeature {
        application: MonitoringUseCases::new(MonitoringPlatformAdapter::new(
            store,
            connections,
            operation,
        )),
    }
}

impl MonitoringPlatformAdapter {
    fn new(store: Store, connections: ConnectionManager, operation: OperationRuntime) -> Self {
        Self {
            store,
            connections,
            operation,
        }
    }
}

impl MonitoringPort for MonitoringPlatformAdapter {
    type StatusReceipt = MonitoringStatusReceipt;
    type ProposalReceipt = MonitoringProposalReceipt;
    type Error = MonitoringError;

    fn status(
        &self,
        connection_id: Uuid,
    ) -> impl std::future::Future<Output = Result<Self::StatusReceipt, Self::Error>> + Send {
        MonitoringPlatformAdapter::status(self, connection_id)
    }

    fn propose_postgres_role(
        &self,
        request: MonitoringProposalRequest,
    ) -> impl std::future::Future<Output = Result<Self::ProposalReceipt, Self::Error>> + Send {
        MonitoringPlatformAdapter::propose_postgres_role(self, request)
    }

    fn run_postgres_role(
        &self,
        operation_id: Uuid,
    ) -> impl std::future::Future<Output = Result<Self::StatusReceipt, Self::Error>> + Send {
        MonitoringPlatformAdapter::run_postgres_role(self, operation_id)
    }
}
