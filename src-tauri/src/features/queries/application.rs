//! Terminal Agent query use cases, independent of persistence and pool adapters.

use crate::kernel::identity::OperationId;
use crate::kernel::TerminalAuthority;

use super::domain::TerminalQueryPlanRequest;
use super::ports::TerminalQueryPort;

#[derive(Clone)]
pub(crate) struct TerminalQueryUseCases<P> {
    port: P,
}

impl<P> TerminalQueryUseCases<P>
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
