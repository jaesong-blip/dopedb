//! Activity use cases independent of the concrete audit repository.

use uuid::Uuid;

use crate::error::AppError;
use crate::error::AppResult;
use crate::model::{AuditEntry, AuditPage, HistoryEntry, HistoryPage};

use super::ports::ActivityPort;
use super::{AuditPageRequest, AuditVerdict, HistoryPageRequest};

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

    pub(crate) async fn audit_page(&self, request: AuditPageRequest) -> AppResult<AuditPage> {
        self.port.audit_page(request).await
    }

    pub(crate) async fn audit_entry(
        &self,
        connection_id: Uuid,
        entry_id: Uuid,
    ) -> AppResult<AuditEntry> {
        self.port.audit_entry(connection_id, entry_id).await
    }

    pub(crate) async fn history_page(
        &self,
        mut request: HistoryPageRequest,
    ) -> AppResult<HistoryPage> {
        request.search = bounded_filter(request.search, 256, "history search")?;
        request.status = bounded_filter(request.status, 64, "history status")?;
        request.origin = bounded_filter(request.origin, 64, "history origin")?;
        self.port.history_page(request).await
    }

    pub(crate) async fn history_entry(
        &self,
        connection_id: Uuid,
        history_id: Uuid,
    ) -> AppResult<HistoryEntry> {
        self.port.history_entry(connection_id, history_id).await
    }
}

fn bounded_filter(
    value: Option<String>,
    max_chars: usize,
    label: &str,
) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let normalized = value.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    if normalized.chars().count() > max_chars || normalized.chars().any(char::is_control) {
        return Err(AppError::Config(format!("{label} is invalid")));
    }
    Ok(Some(normalized.to_string()))
}
