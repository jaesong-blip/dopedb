//! Platform error and guard-bearing failure receipts for Terminal query adapters.

use std::fmt;

use crate::connection::ConnectionLease;
use crate::error::AppError;

/// Stable planning failures projected by the Broker adapter.
#[derive(Debug)]
pub(crate) enum AgentQueryPlanError {
    DocumentConnection,
    NotSingleRead,
    Application(AppError),
}

/// Stable failures after a Terminal plan is selected but before execution starts.
#[derive(Debug)]
pub(crate) enum AgentQueryRunPrepareError {
    UnknownOrAlreadyUsed,
    Expired,
    SessionMismatch,
    AuthorityChanged,
    StoredPlanInvalid,
    Application(AppError),
}

/// Failures after the adapter has announced an execution tool call.
#[derive(Debug)]
pub(crate) enum AgentQueryRunError {
    Connection(AppError),
    Execution(AgentQueryExecutionFailure),
    ProvenancePersistence(AgentQueryProvenanceFailure),
}

/// A post-connect failure whose lease remains alive through Broker projection.
pub(crate) struct AgentQueryExecutionFailure {
    error: AppError,
    _lease: Box<ConnectionLease>,
}

impl fmt::Debug for AgentQueryExecutionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentQueryExecutionFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl AgentQueryExecutionFailure {
    pub(super) fn new(error: AppError, lease: ConnectionLease) -> Self {
        Self {
            error,
            _lease: Box::new(lease),
        }
    }

    pub(crate) fn error(&self) -> &AppError {
        &self.error
    }
}

/// A successful target read whose mandatory provenance receipt could not persist.
pub(crate) struct AgentQueryProvenanceFailure {
    error: AppError,
    _lease: Box<ConnectionLease>,
}

impl fmt::Debug for AgentQueryProvenanceFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentQueryProvenanceFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl AgentQueryProvenanceFailure {
    pub(super) fn new(error: AppError, lease: ConnectionLease) -> Self {
        Self {
            error,
            _lease: Box::new(lease),
        }
    }

    pub(crate) fn into_error(self) -> AppError {
        self.error
    }
}
