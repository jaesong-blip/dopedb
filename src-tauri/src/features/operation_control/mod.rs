//! Desktop-only exact approval orchestration. The service derives the approver and
//! current policy from the active scope; Tauri callers may provide only an operation
//! id, the hash rendered to the user, and an optional human reason.

mod application;
mod ports;

use std::time::Duration;

use dopedb_protocol::{OperationState, OperationSummary};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::connection::ConnectionManager;
use crate::error::{AppError, AppResult};
use crate::kernel::TerminalAuthority;
use crate::operations::{
    approver_for_pin, capture_policy, ensure_operation_scope, required_confirmation,
    ExactApprovalRequest, LocalApprovalAuthority, OperationRecord, OperationRuntime,
};
use crate::store::Store;

use application::OperationUseCases;
use ports::OperationControlPort;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OperationDecisionRequest {
    pub(crate) operation_id: Uuid,
    pub(crate) expected_payload_hash: String,
    pub(crate) reason: Option<String>,
}

/// Redacted lifecycle projection returned after a local approval decision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationDecisionReceipt {
    pub(crate) operation_id: Uuid,
    pub(crate) payload_hash: String,
    pub(crate) state: OperationState,
}

#[derive(Clone)]
struct OperationPlatformAdapter {
    store: Store,
    connections: ConnectionManager,
    runtime: OperationRuntime,
}

type ComposedOperationApplication = OperationUseCases<OperationPlatformAdapter>;

#[derive(Clone)]
pub(crate) struct OperationControlFeature {
    application: ComposedOperationApplication,
}

impl OperationControlFeature {
    pub(crate) async fn recover_previous_runtimes(&self) -> AppResult<()> {
        self.application.recover_previous_runtimes().await
    }

    pub(crate) async fn approve_local(
        &self,
        authority: &LocalApprovalAuthority,
        request: OperationDecisionRequest,
    ) -> AppResult<OperationDecisionReceipt> {
        self.application.approve_local(authority, request).await
    }

    pub(crate) async fn reject_local(
        &self,
        authority: &LocalApprovalAuthority,
        request: OperationDecisionRequest,
    ) -> AppResult<OperationDecisionReceipt> {
        self.application.reject_local(authority, request).await
    }

    pub(crate) async fn show_terminal(
        &self,
        scope: &TerminalAuthority,
        operation_id: Uuid,
    ) -> AppResult<OperationSummary> {
        self.application.show_terminal(scope, operation_id).await
    }

    pub(crate) async fn wait_terminal(
        &self,
        scope: &TerminalAuthority,
        operation_id: Uuid,
        timeout: Duration,
    ) -> AppResult<OperationSummary> {
        self.application
            .wait_terminal(scope, operation_id, timeout)
            .await
    }

    pub(crate) async fn cancel_terminal(
        &self,
        scope: &TerminalAuthority,
        operation_id: Uuid,
    ) -> AppResult<OperationSummary> {
        self.application.cancel_terminal(scope, operation_id).await
    }
}

pub(crate) fn compose(
    store: Store,
    connections: ConnectionManager,
    runtime: OperationRuntime,
) -> OperationControlFeature {
    OperationControlFeature {
        application: OperationUseCases::new(OperationPlatformAdapter::new(
            store,
            connections,
            runtime,
        )),
    }
}

impl OperationPlatformAdapter {
    fn new(store: Store, connections: ConnectionManager, runtime: OperationRuntime) -> Self {
        Self {
            store,
            connections,
            runtime,
        }
    }

    pub(crate) async fn recover_previous_runtimes(&self) -> AppResult<()> {
        self.runtime.recover_previous_runtimes().await.map(|_| ())
    }

    pub(crate) async fn approve_local(
        &self,
        authority: &LocalApprovalAuthority,
        request: OperationDecisionRequest,
    ) -> AppResult<OperationDecisionReceipt> {
        let exact = self.exact_request(request, true).await?;
        self.runtime
            .approve_exact(authority, exact)
            .await
            .map(OperationDecisionReceipt::from)
    }

    pub(crate) async fn reject_local(
        &self,
        authority: &LocalApprovalAuthority,
        request: OperationDecisionRequest,
    ) -> AppResult<OperationDecisionReceipt> {
        let exact = self.exact_request(request, false).await?;
        self.runtime
            .reject_exact(authority, exact)
            .await
            .map(OperationDecisionReceipt::from)
    }

    pub(crate) async fn show_terminal(
        &self,
        scope: &TerminalAuthority,
        operation_id: Uuid,
    ) -> AppResult<OperationSummary> {
        let record = self.runtime.get(operation_id).await?;
        ensure_terminal_scope(&record, scope)?;
        Ok(operation_summary(&record))
    }

    pub(crate) async fn wait_terminal(
        &self,
        scope: &TerminalAuthority,
        operation_id: Uuid,
        timeout: Duration,
    ) -> AppResult<OperationSummary> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let summary = self.show_terminal(scope, operation_id).await?;
            if summary.state.is_terminal() {
                return Ok(summary);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(AppError::Safety("operation wait timed out".into()));
            }
            tokio::time::sleep(
                deadline
                    .saturating_duration_since(now)
                    .min(Duration::from_millis(50)),
            )
            .await;
        }
    }

    pub(crate) async fn cancel_terminal(
        &self,
        scope: &TerminalAuthority,
        operation_id: Uuid,
    ) -> AppResult<OperationSummary> {
        let record = self.runtime.get(operation_id).await?;
        ensure_terminal_scope(&record, scope)?;
        if record.state.is_terminal() {
            return Ok(operation_summary(&record));
        }
        if record.state == OperationState::Executing {
            crate::executor::cancel::cancel(operation_id);
            return Ok(operation_summary(&record));
        }
        let cancelled = self
            .runtime
            .cancel_before_execution(
                operation_id,
                &json!({
                    "origin": "cli",
                    "terminalSessionId": scope.terminal_session_id,
                }),
            )
            .await?;
        Ok(operation_summary(&cancelled))
    }

    async fn exact_request(
        &self,
        request: OperationDecisionRequest,
        validate_confirmation: bool,
    ) -> AppResult<ExactApprovalRequest> {
        let record = self.runtime.get(request.operation_id).await?;
        if validate_confirmation {
            if let Some(expected) = required_confirmation(&record) {
                if request.reason.as_deref() != Some(expected) {
                    return Err(AppError::Blocked {
                        reason: format!(
                            "type the exact confirmation phrase `{expected}` before approving this operation"
                        ),
                    });
                }
            }
        }
        let operation_scope = self.connections.begin_operation_scope().await;
        let pin = operation_scope
            .pin_connection_for_view(record.connection_id)
            .await?;
        ensure_operation_scope(&record, &pin)?;
        let settings = self.store.get_safety(pin.connection_id).await?;
        let policy = capture_policy(&pin, &settings)?;
        Ok(ExactApprovalRequest {
            operation_id: request.operation_id,
            expected_payload_hash: request.expected_payload_hash,
            approver: approver_for_pin(&pin),
            current_policy_revision: policy.revision,
            reason: request.reason,
        })
    }
}

impl OperationControlPort for OperationPlatformAdapter {
    fn recover_previous_runtimes(&self) -> impl std::future::Future<Output = AppResult<()>> + Send {
        OperationPlatformAdapter::recover_previous_runtimes(self)
    }

    fn approve_local<'a>(
        &'a self,
        authority: &'a LocalApprovalAuthority,
        request: OperationDecisionRequest,
    ) -> impl std::future::Future<Output = AppResult<OperationDecisionReceipt>> + Send + 'a {
        OperationPlatformAdapter::approve_local(self, authority, request)
    }

    fn reject_local<'a>(
        &'a self,
        authority: &'a LocalApprovalAuthority,
        request: OperationDecisionRequest,
    ) -> impl std::future::Future<Output = AppResult<OperationDecisionReceipt>> + Send + 'a {
        OperationPlatformAdapter::reject_local(self, authority, request)
    }

    fn show_terminal<'a>(
        &'a self,
        scope: &'a TerminalAuthority,
        operation_id: Uuid,
    ) -> impl std::future::Future<Output = AppResult<OperationSummary>> + Send + 'a {
        OperationPlatformAdapter::show_terminal(self, scope, operation_id)
    }

    fn wait_terminal<'a>(
        &'a self,
        scope: &'a TerminalAuthority,
        operation_id: Uuid,
        timeout: Duration,
    ) -> impl std::future::Future<Output = AppResult<OperationSummary>> + Send + 'a {
        OperationPlatformAdapter::wait_terminal(self, scope, operation_id, timeout)
    }

    fn cancel_terminal<'a>(
        &'a self,
        scope: &'a TerminalAuthority,
        operation_id: Uuid,
    ) -> impl std::future::Future<Output = AppResult<OperationSummary>> + Send + 'a {
        OperationPlatformAdapter::cancel_terminal(self, scope, operation_id)
    }
}

fn ensure_terminal_scope(record: &OperationRecord, scope: &TerminalAuthority) -> AppResult<()> {
    let matches = record.terminal_session_id == Some(scope.terminal_session_id.into())
        && record.workspace_id == Uuid::from(scope.workspace_id)
        && record.account_scope == scope.account_scope.as_str()
        && record.connection_id == Uuid::from(scope.connection_id)
        && record.connection_revision == scope.connection_revision;
    if matches {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "operation belongs to a different Terminal or connection scope".into(),
        })
    }
}

fn operation_summary(record: &OperationRecord) -> OperationSummary {
    OperationSummary {
        operation_id: record.id,
        connection_id: record.connection_id,
        kind: record.kind,
        state: record.state,
        risk_level: record.risk_level,
        payload_hash: record.payload_hash.clone(),
        expires_at: record.expires_at,
        started_at: record.started_at,
        finished_at: record.finished_at,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

impl From<OperationRecord> for OperationDecisionReceipt {
    fn from(record: OperationRecord) -> Self {
        Self {
            operation_id: record.id,
            payload_hash: record.payload_hash,
            state: record.state,
        }
    }
}
