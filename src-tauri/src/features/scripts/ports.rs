//! Platform contract required by Script application use cases.

use std::future::Future;

use uuid::Uuid;

use super::DesktopScriptProposalRequest;

pub(crate) trait ScriptExecutionPort: Clone + Send + Sync + 'static {
    type ProposalReceipt: Send;
    type RunReceipt: Send;
    type Error: Send;

    fn propose_desktop(
        &self,
        request: DesktopScriptProposalRequest,
    ) -> impl Future<Output = Result<Self::ProposalReceipt, Self::Error>> + Send;

    fn run_desktop(
        &self,
        operation_id: Uuid,
    ) -> impl Future<Output = Result<Self::RunReceipt, Self::Error>> + Send;
}
