//! SQL query use cases, independent of persistence and pool adapters.

use crate::kernel::identity::OperationId;
use crate::kernel::TerminalAuthority;

use super::domain::{
    DesktopSqlInspectionRequest, DesktopSqlProposalRequest, TerminalQueryPlanRequest,
    TerminalSqlProposalRequest,
};
use super::ports::{DesktopQueryPort, TerminalQueryPort};

#[derive(Clone)]
pub(crate) struct QueryUseCases<P> {
    port: P,
}

impl<P> QueryUseCases<P>
where
    P: TerminalQueryPort,
{
    pub(crate) fn new(port: P) -> Self {
        Self { port }
    }

    pub(crate) async fn plan_terminal_read(
        &self,
        request: TerminalQueryPlanRequest,
    ) -> Result<P::PlanReceipt, P::PlanError> {
        self.port.plan_terminal_read(request).await
    }

    pub(crate) async fn prepare_terminal_run(
        &self,
        plan_id: OperationId,
        authority: &TerminalAuthority,
    ) -> Result<P::PreparedRun, P::PrepareError> {
        self.port.prepare_terminal_run(plan_id, authority).await
    }
}

impl<P> QueryUseCases<P>
where
    P: DesktopQueryPort,
{
    pub(crate) async fn inspect_desktop_sql(
        &self,
        request: DesktopSqlInspectionRequest,
    ) -> Result<P::InspectionReceipt, P::InspectionError> {
        self.port.inspect_desktop_sql(request).await
    }

    pub(crate) async fn propose_desktop_sql(
        &self,
        request: DesktopSqlProposalRequest,
    ) -> Result<P::ProposalReceipt, P::InspectionError> {
        self.port.propose_desktop_sql(request).await
    }

    pub(crate) async fn propose_terminal_sql(
        &self,
        request: TerminalSqlProposalRequest,
    ) -> Result<P::ProposalReceipt, P::InspectionError> {
        self.port.propose_terminal_sql(request).await
    }

    pub(crate) async fn run_desktop_sql(
        &self,
        operation_id: OperationId,
    ) -> Result<P::RunReceipt, P::RunError> {
        self.port.run_desktop_sql(operation_id).await
    }
}
