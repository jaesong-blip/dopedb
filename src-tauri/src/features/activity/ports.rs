//! Persistence contract required by Activity reads.

use std::future::Future;

use uuid::Uuid;

use crate::error::AppResult;
use crate::model::HistoryEntry;

use super::{AuditSnapshotReceipt, AuditVerdict};

pub(crate) trait ActivityPort: Clone + Send + Sync + 'static {
    fn verify_audit(
        &self,
        connection_id: Uuid,
    ) -> impl Future<Output = AppResult<AuditVerdict>> + Send;

    fn audit_snapshot(
        &self,
        connection_id: Uuid,
    ) -> impl Future<Output = AppResult<AuditSnapshotReceipt>> + Send;

    fn history(
        &self,
        connection_id: Uuid,
    ) -> impl Future<Output = AppResult<Vec<HistoryEntry>>> + Send;
}
