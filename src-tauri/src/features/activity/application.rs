//! Activity use cases independent of the concrete audit repository.

use uuid::Uuid;

use crate::error::AppResult;
use crate::model::HistoryEntry;

use super::ports::ActivityPort;
use super::{AuditSnapshotReceipt, AuditVerdict};

#[derive(Clone)]
pub(crate) struct ActivityUseCases<P> {
    port: P,
}

impl<P> ActivityUseCases<P>
where
    P: ActivityPort,
{
    pub(crate) fn new(port: P) -> Self {
        Self { port }
    }

    pub(crate) async fn verify_audit(&self, connection_id: Uuid) -> AppResult<AuditVerdict> {
        self.port.verify_audit(connection_id).await
    }

    pub(crate) async fn audit_snapshot(
        &self,
        connection_id: Uuid,
    ) -> AppResult<AuditSnapshotReceipt> {
        self.port.audit_snapshot(connection_id).await
    }

    pub(crate) async fn history(&self, connection_id: Uuid) -> AppResult<Vec<HistoryEntry>> {
        self.port.history(connection_id).await
    }
}
