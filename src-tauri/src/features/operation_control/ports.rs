//! Platform contract required by Operation-control use cases.

use std::future::Future;
use std::time::Duration;

use dopedb_protocol::OperationSummary;
use uuid::Uuid;

use crate::error::AppResult;
use crate::kernel::TerminalAuthority;
use crate::operations::LocalApprovalAuthority;

use super::{OperationDecisionReceipt, OperationDecisionRequest};

pub(crate) trait OperationControlPort: Clone + Send + Sync + 'static {
    fn recover_previous_runtimes(&self) -> impl Future<Output = AppResult<()>> + Send;

    fn approve_local<'a>(
        &'a self,
        authority: &'a LocalApprovalAuthority,
        request: OperationDecisionRequest,
    ) -> impl Future<Output = AppResult<OperationDecisionReceipt>> + Send + 'a;

    fn reject_local<'a>(
        &'a self,
        authority: &'a LocalApprovalAuthority,
        request: OperationDecisionRequest,
    ) -> impl Future<Output = AppResult<OperationDecisionReceipt>> + Send + 'a;

    fn show_terminal<'a>(
        &'a self,
        scope: &'a TerminalAuthority,
        operation_id: Uuid,
    ) -> impl Future<Output = AppResult<OperationSummary>> + Send + 'a;

    fn wait_terminal<'a>(
        &'a self,
        scope: &'a TerminalAuthority,
        operation_id: Uuid,
        timeout: Duration,
    ) -> impl Future<Output = AppResult<OperationSummary>> + Send + 'a;

    fn cancel_terminal<'a>(
        &'a self,
        scope: &'a TerminalAuthority,
        operation_id: Uuid,
    ) -> impl Future<Output = AppResult<OperationSummary>> + Send + 'a;
}
