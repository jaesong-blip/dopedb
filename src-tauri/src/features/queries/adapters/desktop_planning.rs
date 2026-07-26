//! Durable desktop and Terminal SQL proposal planning adapter operations.

use chrono::{Duration as ChronoDuration, Utc};
use uuid::Uuid;

use crate::error::AppError;
use crate::kernel::agent_policy::QUERY_PLAN_TTL;
use crate::kernel::identity::OperationId;
use crate::kernel::TerminalAuthority;
use crate::model::QueryKind;
use crate::operations::{
    actor_for_pin, agent_actor_for_pin, capture_policy, required_confirmation, NewOperation,
    OperationPlanDisposition,
};
use crate::safety;

use super::super::domain::{
    DesktopSqlPreviewRequest, DesktopSqlProposalRequest, TerminalSqlProposalRequest,
};
use super::desktop_contracts::{
    DesktopSqlInspectionError, DesktopSqlProposalReceipt, StoredDesktopSqlPayload,
};
use super::desktop_support::{operation_kind, operation_risk};
use super::platform::QueryPlatformAdapter;

impl QueryPlatformAdapter {
    pub(crate) async fn propose_desktop_sql(
        &self,
        request: DesktopSqlProposalRequest,
    ) -> Result<DesktopSqlProposalReceipt, DesktopSqlInspectionError> {
        self.propose_sql(request, None).await
    }

    pub(crate) async fn propose_terminal_sql(
        &self,
        request: TerminalSqlProposalRequest,
    ) -> Result<DesktopSqlProposalReceipt, DesktopSqlInspectionError> {
        self.propose_sql(
            DesktopSqlProposalRequest {
                connection_id: request.connection_id,
                sql: request.sql,
                origin: Some("cli".into()),
            },
            Some(request.authority),
        )
        .await
    }

    async fn propose_sql(
        &self,
        request: DesktopSqlProposalRequest,
        terminal: Option<TerminalAuthority>,
    ) -> Result<DesktopSqlProposalReceipt, DesktopSqlInspectionError> {
        let preview_receipt = self
            .preview_sql(
                DesktopSqlPreviewRequest {
                    connection_id: request.connection_id,
                    sql: request.sql.clone(),
                },
                terminal.as_ref(),
            )
            .await?;
        let pin = &preview_receipt.pin;
        let settings = self
            .store
            .get_safety(pin.connection_id)
            .await
            .map_err(DesktopSqlInspectionError::Application)?;
        let classification = safety::classify(&request.sql, pin.profile.engine)
            .map_err(DesktopSqlInspectionError::Application)?;
        let is_write = !matches!(classification.kind, QueryKind::Read);

        if is_write && !pin.profile.workspace_access.can_write() {
            return Err(DesktopSqlInspectionError::Application(AppError::Blocked {
                reason: "your workspace role grants read-only database access".into(),
            }));
        }
        if let safety::GateDecision::Block { reason } = safety::decide(&settings, &classification) {
            return Err(DesktopSqlInspectionError::Application(AppError::Blocked {
                reason,
            }));
        }

        let policy =
            capture_policy(pin, &settings).map_err(DesktopSqlInspectionError::Application)?;
        let history_origin = request.origin.unwrap_or_else(|| "manual".into());
        let payload = serde_json::to_value(StoredDesktopSqlPayload {
            sql: request.sql,
            history_origin: history_origin.clone(),
        })
        .map_err(AppError::from)
        .map_err(DesktopSqlInspectionError::Application)?;
        let operation_id = OperationId::from(Uuid::new_v4());
        let expires_at = Utc::now()
            + if is_write {
                ChronoDuration::minutes(5)
            } else {
                ChronoDuration::from_std(QUERY_PLAN_TTL)
                    .expect("query plan TTL is representable by chrono")
            };
        let disposition = if is_write {
            OperationPlanDisposition::ApprovalRequired
        } else {
            OperationPlanDisposition::Ready
        };
        let actor = if let Some(authority) = terminal.as_ref() {
            let mut actor = agent_actor_for_pin(pin, "cli".into(), "cli".into());
            actor.provenance.client_protocol_version = Some(authority.client_protocol_version);
            actor
        } else {
            actor_for_pin(pin, history_origin)
        };
        let operation = self
            .operation
            .plan(
                NewOperation {
                    id: operation_id.into(),
                    workspace_id: pin.scope.workspace_id,
                    account_scope: pin.scope.account_scope.storage_key().into(),
                    connection_id: pin.connection_id,
                    connection_revision: pin.connection_revision,
                    terminal_session_id: terminal
                        .as_ref()
                        .map(|authority| authority.terminal_session_id.into()),
                    actor,
                    kind: operation_kind(classification.kind),
                    payload_schema_version: 1,
                    payload,
                    schema_fingerprint: None,
                    risk_level: operation_risk(&classification),
                    preview: serde_json::to_value(&preview_receipt.report)
                        .map_err(AppError::from)
                        .map_err(DesktopSqlInspectionError::Application)?,
                    policy_snapshot: policy.snapshot,
                    policy_revision: policy.revision,
                    single_use: true,
                    idempotency_key: operation_id.to_string(),
                    expires_at: Some(expires_at),
                },
                disposition,
            )
            .await
            .map_err(DesktopSqlInspectionError::Application)?;
        let confirmation_phrase = required_confirmation(&operation).map(str::to_owned);

        Ok(DesktopSqlProposalReceipt {
            operation_id: operation.id.into(),
            payload_hash: operation.payload_hash,
            state: operation.state,
            approval_required: is_write,
            auto_run: !is_write && settings.auto_run_reads,
            confirmation_phrase,
            expires_at,
            classification,
            preview: preview_receipt.report.clone(),
        })
    }
}
