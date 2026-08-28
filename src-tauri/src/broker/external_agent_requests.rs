//! In-memory handoff between owner-local Broker requests and the Desktop approval UI.

use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use dopedb_protocol::{ExternalAgentConfig, ExternalAgentProvider};
use serde::Serialize;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::sync::lock_unpoisoned;

const MAX_PENDING_REQUESTS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExternalAgentRequestKind {
    Configure,
    Start,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalAgentRequestSummary {
    pub(crate) id: Uuid,
    pub(crate) kind: ExternalAgentRequestKind,
    pub(crate) provider: ExternalAgentProvider,
    pub(crate) working_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) config: Option<ExternalAgentConfig>,
}

pub(crate) enum ExternalAgentRequestDecision {
    Approved(Option<ExternalAgentConfig>),
    Rejected,
}

struct PendingExternalAgentRequest {
    summary: ExternalAgentRequestSummary,
    response: Mutex<Option<oneshot::Sender<ExternalAgentRequestDecision>>>,
}

#[derive(Clone, Default)]
pub(crate) struct ExternalAgentRequestRegistry {
    pending: Arc<DashMap<Uuid, Arc<PendingExternalAgentRequest>>>,
    admission: Arc<Mutex<()>>,
}

impl ExternalAgentRequestRegistry {
    pub(crate) fn begin(
        &self,
        summary: ExternalAgentRequestSummary,
    ) -> AppResult<oneshot::Receiver<ExternalAgentRequestDecision>> {
        // Keep the limit exact even when several local CLI processes ask for
        // approval at the same time. DashMap protects each operation, but a
        // separate admission lock is required around the count-and-insert pair.
        let _admission = lock_unpoisoned(&self.admission);
        if self.pending.len() >= MAX_PENDING_REQUESTS {
            return Err(AppError::Blocked {
                reason: "too many external Agent approval requests are already pending".into(),
            });
        }
        let (sender, receiver) = oneshot::channel();
        let id = summary.id;
        if self
            .pending
            .insert(
                id,
                Arc::new(PendingExternalAgentRequest {
                    summary,
                    response: Mutex::new(Some(sender)),
                }),
            )
            .is_some()
        {
            self.pending.remove(&id);
            return Err(AppError::Config(
                "external Agent approval request identifier collision".into(),
            ));
        }
        Ok(receiver)
    }

    pub(crate) fn list(&self) -> Vec<ExternalAgentRequestSummary> {
        let mut requests = self
            .pending
            .iter()
            .map(|entry| entry.summary.clone())
            .collect::<Vec<_>>();
        requests.sort_by_key(|request| request.id);
        requests
    }

    pub(crate) fn respond(
        &self,
        id: Uuid,
        decision: ExternalAgentRequestDecision,
    ) -> AppResult<()> {
        let pending = self.pending.get(&id).ok_or_else(|| AppError::Blocked {
            reason: "the external Agent approval request is no longer pending".into(),
        })?;
        let sender =
            lock_unpoisoned(&pending.response)
                .take()
                .ok_or_else(|| AppError::Blocked {
                    reason: "the external Agent approval request was already answered".into(),
                })?;
        sender.send(decision).map_err(|_| AppError::Blocked {
            reason: "the external Agent process stopped before approval completed".into(),
        })
    }

    pub(crate) fn finish(&self, id: Uuid) {
        self.pending.remove(&id);
    }

    pub(crate) fn reject_all(&self) {
        let ids = self
            .pending
            .iter()
            .map(|entry| *entry.key())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some((_, pending)) = self.pending.remove(&id) {
                if let Some(sender) = lock_unpoisoned(&pending.response).take() {
                    let _ = sender.send(ExternalAgentRequestDecision::Rejected);
                }
            }
        }
    }
}
