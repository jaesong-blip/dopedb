//! Platform contract required by typed Document read use cases.

use std::future::Future;

use uuid::Uuid;

use super::{DesktopDocumentProposalRequest, TerminalDocumentReadRequest};

pub(crate) trait DocumentExecutionPort: Clone + Send + Sync + 'static {
    type DesktopProposalReceipt: Send;
    type ReadReceipt: Send;
    type DesktopError: Send;
    type TerminalError: Send;

    fn propose_desktop_read(
        &self,
        request: DesktopDocumentProposalRequest,
    ) -> impl Future<Output = Result<Self::DesktopProposalReceipt, Self::DesktopError>> + Send;

    fn run_desktop_read(
        &self,
        operation_id: Uuid,
    ) -> impl Future<Output = Result<Self::ReadReceipt, Self::DesktopError>> + Send;

    fn run_terminal_read(
        &self,
        request: TerminalDocumentReadRequest,
    ) -> impl Future<Output = Result<Self::ReadReceipt, Self::TerminalError>> + Send;
}
