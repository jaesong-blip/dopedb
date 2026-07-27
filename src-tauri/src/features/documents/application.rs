//! Typed Document read use cases independent of concrete storage and pool adapters.

use uuid::Uuid;

use super::ports::DocumentExecutionPort;
use super::{DesktopDocumentProposalRequest, TerminalDocumentReadRequest};

#[derive(Clone)]
pub(crate) struct DocumentUseCases<P> {
    port: P,
}

impl<P> DocumentUseCases<P>
where
    P: DocumentExecutionPort,
{
    pub(crate) fn new(port: P) -> Self {
        Self { port }
    }

    pub(crate) async fn propose_desktop_read(
        &self,
        request: DesktopDocumentProposalRequest,
    ) -> Result<P::DesktopProposalReceipt, P::DesktopError> {
        self.port.propose_desktop_read(request).await
    }

    pub(crate) async fn run_desktop_read(
        &self,
        operation_id: Uuid,
    ) -> Result<P::ReadReceipt, P::DesktopError> {
        self.port.run_desktop_read(operation_id).await
    }

    pub(crate) async fn run_terminal_read(
        &self,
        request: TerminalDocumentReadRequest,
    ) -> Result<P::ReadReceipt, P::TerminalError> {
        self.port.run_terminal_read(request).await
    }
}
