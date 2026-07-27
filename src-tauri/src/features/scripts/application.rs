//! Script use cases independent of concrete storage, pool, and operation adapters.

use uuid::Uuid;

use super::ports::ScriptExecutionPort;
use super::DesktopScriptProposalRequest;

#[derive(Clone)]
pub(crate) struct ScriptUseCases<P> {
    port: P,
}

impl<P> ScriptUseCases<P>
where
    P: ScriptExecutionPort,
{
    pub(crate) fn new(port: P) -> Self {
        Self { port }
    }

    pub(crate) async fn propose_desktop(
        &self,
        request: DesktopScriptProposalRequest,
    ) -> Result<P::ProposalReceipt, P::Error> {
        self.port.propose_desktop(request).await
    }

    pub(crate) async fn run_desktop(&self, operation_id: Uuid) -> Result<P::RunReceipt, P::Error> {
        self.port.run_desktop(operation_id).await
    }
}
