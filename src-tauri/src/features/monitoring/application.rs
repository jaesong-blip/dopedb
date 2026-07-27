//! Monitoring use cases independent of concrete storage, pool, and operation adapters.

use uuid::Uuid;

use super::ports::MonitoringPort;
use super::MonitoringProposalRequest;

#[derive(Clone)]
pub(crate) struct MonitoringUseCases<P> {
    port: P,
}

impl<P> MonitoringUseCases<P>
where
    P: MonitoringPort,
{
    pub(crate) fn new(port: P) -> Self {
        Self { port }
    }

    pub(crate) async fn status(&self, connection_id: Uuid) -> Result<P::StatusReceipt, P::Error> {
        self.port.status(connection_id).await
    }

    pub(crate) async fn propose_postgres_role(
        &self,
        request: MonitoringProposalRequest,
    ) -> Result<P::ProposalReceipt, P::Error> {
        self.port.propose_postgres_role(request).await
    }

    pub(crate) async fn run_postgres_role(
        &self,
        operation_id: Uuid,
    ) -> Result<P::StatusReceipt, P::Error> {
        self.port.run_postgres_role(operation_id).await
    }
}
