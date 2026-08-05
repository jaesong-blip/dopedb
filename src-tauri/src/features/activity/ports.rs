//! Persistence contract required by Activity reads.

use std::future::Future;

use uuid::Uuid;

use crate::error::AppResult;
use crate::model::{AuditEntry, AuditPage, HistoryEntry, HistoryPage};

use super::{AuditPageRequest, AuditVerdict, HistoryPageRequest};

pub(crate) trait ActivityPort: Clone + Send + Sync + 'static {
    fn verify_audit(
        &self,
        connection_id: Uuid,
    ) -> impl Future<Output = AppResult<AuditVerdict>> + Send;

    fn audit_page(
        &self,
        request: AuditPageRequest,
    ) -> impl Future<Output = AppResult<AuditPage>> + Send;

    fn audit_entry(
        &self,
        connection_id: Uuid,
        entry_id: Uuid,
    ) -> impl Future<Output = AppResult<AuditEntry>> + Send;

    fn history_page(
        &self,
        request: HistoryPageRequest,
    ) -> impl Future<Output = AppResult<HistoryPage>> + Send;

    fn history_entry(
        &self,
        connection_id: Uuid,
        history_id: Uuid,
    ) -> impl Future<Output = AppResult<HistoryEntry>> + Send;
}
