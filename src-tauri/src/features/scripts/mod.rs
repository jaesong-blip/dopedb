//! Transport-neutral multi-statement SQL script execution.

mod application;
mod execution;
mod helpers;
mod ports;
mod proposal;
mod read_execution;
mod write_execution;

use std::fmt;

use chrono::{Duration as ChronoDuration, Utc};
use dopedb_protocol::{DdlPlan, SchemaChangeRequest};
use serde::{Deserialize, Serialize};
use sqlx::AssertSqlSafe;
use uuid::Uuid;

use crate::audit::{self, RecordArgs};
use crate::connection::{
    ConnectionAccess, ConnectionLease, ConnectionManager, ConnectionOperationScope, DbPool,
};
use crate::error::{AppError, AppResult};
use crate::executor;
use crate::features::catalog::CatalogFeature;
use crate::features::queries::{
    ManualExecutionTarget, ManualScriptRequest, ManualTransactionRuntime,
};
use crate::kernel::access::PinnedConnection;
use crate::kernel::agent_policy::QUERY_PLAN_TTL;
use crate::model::{HistoryEntry, QueryKind, ScriptOutcome, ScriptStatement};
use crate::operations::{
    actor_for_pin, capture_policy, ensure_operation_scope, required_confirmation, ClaimedOperation,
    ExecutionGrant, NewOperation, OperationKind, OperationPlanDisposition, OperationRiskLevel,
    OperationRuntime, OperationState,
};
use crate::safety;
use crate::store::Store;

const DESKTOP_SCRIPT_PAYLOAD_SCHEMA_VERSION: u32 = 3;

/// Desktop script input accepted only at the immutable proposal boundary.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DesktopScriptProposalRequest {
    pub(crate) connection_id: Uuid,
    pub(crate) sql: String,
    pub(crate) database: Option<String>,
    pub(crate) namespace: Option<String>,
    pub(crate) origin: Option<String>,
    /// Present only for a Catalog-pinned plan produced by the structured schema
    /// editor. The public manual-script command always supplies `None`.
    pub(crate) schema_change: Option<SchemaScriptContext>,
    /// Present only for staged table-editor statements. Each mutation must affect
    /// exactly the corresponding row count or the entire transaction rolls back.
    pub(crate) table_change: Option<TableScriptContext>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SchemaScriptContext {
    pub(crate) request: SchemaChangeRequest,
    pub(crate) plan: DdlPlan,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TableScriptContext {
    pub(crate) catalog_fingerprint: String,
    pub(crate) expected_affected: Vec<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopScriptProposalReceipt {
    pub(crate) operation_id: Uuid,
    pub(crate) payload_hash: String,
    pub(crate) state: OperationState,
    pub(crate) approval_required: bool,
    pub(crate) confirmation_phrase: Option<String>,
    pub(crate) statement_count: usize,
    pub(crate) expires_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDesktopScriptPayload {
    sql: String,
    history_origin: String,
    database: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schema_change: Option<SchemaScriptContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    table_change: Option<TableScriptContext>,
}

/// Successful script execution retaining target authority until the adapter has
/// serialized the established [`ScriptOutcome`] payload.
pub(crate) struct DesktopScriptRunReceipt {
    outcome: ScriptOutcome,
    _lease: ConnectionLease,
}

impl serde::Serialize for DesktopScriptRunReceipt {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serde::Serialize::serialize(&self.outcome, serializer)
    }
}

#[derive(Debug)]
pub(crate) enum DesktopScriptRunError {
    Application(AppError),
    Scoped(DesktopScriptScopedFailure),
    Execution(Box<DesktopScriptExecutionFailure>),
}

impl DesktopScriptRunError {
    pub(crate) fn into_error(self) -> AppError {
        match self {
            Self::Application(error) => error,
            Self::Scoped(failure) => failure.into_error(),
            Self::Execution(failure) => failure.into_error(),
        }
    }
}

pub(crate) struct DesktopScriptScopedFailure {
    error: AppError,
    _scope: ConnectionOperationScope,
}

impl fmt::Debug for DesktopScriptScopedFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DesktopScriptScopedFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl DesktopScriptScopedFailure {
    fn into_error(self) -> AppError {
        self.error
    }
}

pub(crate) struct DesktopScriptExecutionFailure {
    error: AppError,
    _lease: ConnectionLease,
}

impl fmt::Debug for DesktopScriptExecutionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DesktopScriptExecutionFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl DesktopScriptExecutionFailure {
    fn into_error(self) -> AppError {
        self.error
    }
}

#[derive(Clone)]
struct ScriptPlatformAdapter {
    store: Store,
    connections: ConnectionManager,
    catalog: CatalogFeature,
    operation: OperationRuntime,
    manual_transactions: ManualTransactionRuntime,
}

struct PreparedScriptRun {
    operation_scope: ConnectionOperationScope,
    operation_pin: PinnedConnection,
    operation: ClaimedOperation,
    payload: StoredDesktopScriptPayload,
    statements: Vec<String>,
    kinds: Vec<QueryKind>,
    settings: crate::model::SafetySettings,
    engine: crate::model::Engine,
    history_origin: String,
}

use application::ScriptUseCases;
use helpers::*;
use ports::ScriptExecutionPort;

type ComposedScriptApplication = ScriptUseCases<ScriptPlatformAdapter>;

/// Public Script feature boundary used by transports and collaborating features.
#[derive(Clone)]
pub(crate) struct ScriptFeature {
    application: ComposedScriptApplication,
}

impl ScriptFeature {
    pub(crate) async fn propose_desktop(
        &self,
        request: DesktopScriptProposalRequest,
    ) -> Result<DesktopScriptProposalReceipt, DesktopScriptRunError> {
        self.application.propose_desktop(request).await
    }

    pub(crate) async fn run_desktop(
        &self,
        operation_id: Uuid,
    ) -> Result<DesktopScriptRunReceipt, DesktopScriptRunError> {
        self.application.run_desktop(operation_id).await
    }
}

pub(crate) fn compose(
    store: Store,
    connections: ConnectionManager,
    catalog: CatalogFeature,
    operation: OperationRuntime,
    manual_transactions: ManualTransactionRuntime,
) -> ScriptFeature {
    ScriptFeature {
        application: ScriptUseCases::new(ScriptPlatformAdapter::new(
            store,
            connections,
            catalog,
            operation,
            manual_transactions,
        )),
    }
}

impl ScriptPlatformAdapter {
    fn new(
        store: Store,
        connections: ConnectionManager,
        catalog: CatalogFeature,
        operation: OperationRuntime,
        manual_transactions: ManualTransactionRuntime,
    ) -> Self {
        Self {
            store,
            connections,
            catalog,
            operation,
            manual_transactions,
        }
    }
}

impl ScriptExecutionPort for ScriptPlatformAdapter {
    type ProposalReceipt = DesktopScriptProposalReceipt;
    type RunReceipt = DesktopScriptRunReceipt;
    type Error = DesktopScriptRunError;

    fn propose_desktop(
        &self,
        request: DesktopScriptProposalRequest,
    ) -> impl std::future::Future<Output = Result<Self::ProposalReceipt, Self::Error>> + Send {
        ScriptPlatformAdapter::propose_desktop(self, request)
    }

    fn run_desktop(
        &self,
        operation_id: Uuid,
    ) -> impl std::future::Future<Output = Result<Self::RunReceipt, Self::Error>> + Send {
        ScriptPlatformAdapter::run_desktop(self, operation_id)
    }
}
