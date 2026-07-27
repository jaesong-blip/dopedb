//! Platform contract required by Monitoring use cases.

use std::future::Future;

use uuid::Uuid;

use super::MonitoringProposalRequest;

pub(crate) trait MonitoringPort: Clone + Send + Sync + 'static {
    type StatusReceipt: Send;
    type ProposalReceipt: Send;
    type Error: Send;

    fn status(
        &self,
        connection_id: Uuid,
    ) -> impl Future<Output = Result<Self::StatusReceipt, Self::Error>> + Send;

    fn propose_postgres_role(
        &self,
        request: MonitoringProposalRequest,
    ) -> impl Future<Output = Result<Self::ProposalReceipt, Self::Error>> + Send;

    fn run_postgres_role(
        &self,
        operation_id: Uuid,
    ) -> impl Future<Output = Result<Self::StatusReceipt, Self::Error>> + Send;
}
