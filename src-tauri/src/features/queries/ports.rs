//! Ports through which Terminal query use cases reach platform adapters.

use std::future::Future;

use crate::kernel::identity::{QueryRunId, TerminalSessionId};
use crate::kernel::TerminalAuthority;

use super::domain::TerminalQueryPlanRequest;

pub(crate) trait TerminalQueryPort: Clone + Send + Sync + 'static {
    type PlanReceipt: Send;
    type PreparedRun: Send;
    type PlanError: Send;
    type PrepareError: Send;

    fn plan_terminal_read(
        &self,
        request: TerminalQueryPlanRequest,
    ) -> impl Future<Output = Result<Self::PlanReceipt, Self::PlanError>> + Send;

    fn prepare_terminal_run(
        &self,
        plan_id: crate::kernel::identity::OperationId,
        authority: &TerminalAuthority,
    ) -> impl Future<Output = Result<Self::PreparedRun, Self::PrepareError>> + Send;
}

/// Minimal capability a dashboard needs to authorize a Terminal query-run source.
pub(crate) trait QueryRunAuthorizationPort: Send + Sync + 'static {
    fn authorize(
        &self,
        query_run_id: QueryRunId,
        authority: &TerminalAuthority,
    ) -> Result<(), QueryRunAuthorizationError>;
}

/// Producer-only capability that records a successfully completed Terminal query run.
pub(crate) trait QueryRunProvenancePort: Send + Sync + 'static {
    fn register(
        &self,
        query_run_id: QueryRunId,
        terminal_session_id: TerminalSessionId,
        connection_id: crate::kernel::identity::ConnectionId,
    );
}

/// Pure authorization outcome for an in-memory query-run capability lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueryRunAuthorizationError {
    NotAuthorized,
}
