//! SQLite operation persistence split by lifecycle responsibility.
//!
//! The repository remains the single writer for operation projections and ledgers,
//! while each child module owns one cohesive part of the durable state machine.

mod approval;
mod ledger;
mod lifecycle;
mod planning;
mod projection;
mod recovery;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use dopedb_protocol::{OperationEventKind, OperationState, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::canonicalize::{canonical_json, CanonicalJson};
use super::model::{
    actor_kind_str, approval_decision_str, event_kind_str, operation_kind_str, parse_actor_kind,
    parse_approval_decision, parse_event_kind, parse_operation_kind, parse_risk_level, parse_state,
    risk_level_str, state_str, NewOperation, OperationActor, OperationActorProvenance,
    OperationApprovalCommand, OperationApprovalDecision, OperationApprovalRecord,
    OperationApprover, OperationEventRecord, OperationRecord, RestartRecoveryReport,
};
use super::{ensure_transition, restart_recovery, RestartRecovery};
use crate::error::{AppError, AppResult};
use crate::store::Store;

use projection::*;

#[derive(Clone)]
pub(crate) struct OperationRepository {
    pool: SqlitePool,
    write_lock: Arc<Mutex<()>>,
}

impl OperationRepository {
    pub(crate) fn new(store: &Store) -> Self {
        Self {
            pool: store.pool().clone(),
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    #[cfg(test)]
    fn from_pool(pool: SqlitePool) -> Self {
        Self {
            pool,
            write_lock: Arc::new(Mutex::new(())),
        }
    }
}
