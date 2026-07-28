//! Transport-neutral audit verification and execution-history reads.

mod application;
mod ports;

use serde::Serialize;
use uuid::Uuid;

use crate::audit;
use crate::error::AppResult;
use crate::model::{AuditEntry, HistoryEntry};
use crate::store::Store;

use application::ActivityUseCases;
use ports::ActivityPort;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuditVerdict {
    pub(crate) ok: bool,
    pub(crate) first_bad_index: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuditSnapshotReceipt {
    pub(crate) entries: Vec<AuditEntry>,
    pub(crate) verdict: AuditVerdict,
}

#[derive(Clone)]
struct ActivityPlatformAdapter {
    store: Store,
}

type ComposedActivityApplication = ActivityUseCases<ActivityPlatformAdapter>;

#[derive(Clone)]
pub(crate) struct ActivityFeature {
    application: ComposedActivityApplication,
}

impl ActivityFeature {
    pub(crate) async fn verify_audit(&self, connection_id: Uuid) -> AppResult<AuditVerdict> {
        self.application.verify_audit(connection_id).await
    }

    pub(crate) async fn audit_snapshot(
        &self,
        connection_id: Uuid,
    ) -> AppResult<AuditSnapshotReceipt> {
        self.application.audit_snapshot(connection_id).await
    }

    pub(crate) async fn history(&self, connection_id: Uuid) -> AppResult<Vec<HistoryEntry>> {
        self.application.history(connection_id).await
    }
}

pub(crate) fn compose(store: Store) -> ActivityFeature {
    ActivityFeature {
        application: ActivityUseCases::new(ActivityPlatformAdapter::new(store)),
    }
}

impl ActivityPlatformAdapter {
    fn new(store: Store) -> Self {
        Self { store }
    }

    pub(crate) async fn verify_audit(&self, connection_id: Uuid) -> AppResult<AuditVerdict> {
        self.store.get_connection(connection_id).await?;
        let (ok, first_bad_index) = audit::verify_chain(&self.store, connection_id).await?;
        Ok(AuditVerdict {
            ok,
            first_bad_index,
        })
    }

    pub(crate) async fn audit_snapshot(
        &self,
        connection_id: Uuid,
    ) -> AppResult<AuditSnapshotReceipt> {
        self.store.get_connection(connection_id).await?;
        let (entries, ok, first_bad_index) = audit::snapshot(&self.store, connection_id).await?;
        Ok(AuditSnapshotReceipt {
            entries,
            verdict: AuditVerdict {
                ok,
                first_bad_index,
            },
        })
    }

    pub(crate) async fn history(&self, connection_id: Uuid) -> AppResult<Vec<HistoryEntry>> {
        self.store.list_history(connection_id).await
    }
}

impl ActivityPort for ActivityPlatformAdapter {
    fn verify_audit(
        &self,
        connection_id: Uuid,
    ) -> impl std::future::Future<Output = AppResult<AuditVerdict>> + Send {
        ActivityPlatformAdapter::verify_audit(self, connection_id)
    }

    fn audit_snapshot(
        &self,
        connection_id: Uuid,
    ) -> impl std::future::Future<Output = AppResult<AuditSnapshotReceipt>> + Send {
        ActivityPlatformAdapter::audit_snapshot(self, connection_id)
    }

    fn history(
        &self,
        connection_id: Uuid,
    ) -> impl std::future::Future<Output = AppResult<Vec<HistoryEntry>>> + Send {
        ActivityPlatformAdapter::history(self, connection_id)
    }
}
