//! Concrete planning adapter for immutable Terminal SQL-read capabilities.

use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::time::Instant;
use uuid::Uuid;

use crate::connection::{
    ensure_terminal_pin, ConnectionAccess, ConnectionLease, ConnectionManager,
};
use crate::error::AppError;
#[cfg(test)]
use crate::kernel::agent_policy::MAX_AGENT_ROWS;
use crate::kernel::agent_policy::QUERY_PLAN_TTL;
use crate::kernel::identity::{ConnectionId, OperationId};
use crate::monitoring;
use crate::operations::{
    agent_actor_for_pin, NewOperation, OperationKind, OperationPlanDisposition, OperationRiskLevel,
    OperationRuntime,
};
use crate::safety;
use crate::store::Store;

use super::super::domain::{
    planning_guidance, AgentQueryInvocationOrigin, AgentQueryPlan, TerminalQueryPlanRequest,
};
use super::super::ports::TerminalQueryPort;
use super::errors::{AgentQueryPlanError, AgentQueryRunPrepareError};
use super::provenance::TerminalQueryRunRegistry;
use super::terminal_support::{
    audit_best_effort, bounded_max_rows, capture_agent_read_policy, pool_ref,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredAgentReadPayload {
    pub(super) sql: String,
    pub(super) max_rows: u64,
    pub(super) decision: String,
    pub(super) origin: AgentQueryInvocationOrigin,
}

#[cfg(test)]
pub(crate) struct SeedQueryPlanForTest {
    pub(crate) plan_id: OperationId,
    pub(crate) sql: String,
    pub(crate) max_rows: u64,
    pub(crate) decision: String,
    pub(crate) created_at: Instant,
    pub(crate) actor_id: Option<String>,
}

/// Concrete platform adapter; this is the only Terminal-query code that owns Store,
/// connection runtime, Operation Runtime, and ephemeral provenance state together.
#[derive(Clone)]
pub(crate) struct TerminalQueryAdapter {
    pub(super) store: Store,
    pub(super) connections: ConnectionManager,
    pub(super) operation: OperationRuntime,
    pub(super) terminal_runs: TerminalQueryRunRegistry,
}

impl TerminalQueryAdapter {
    pub(crate) fn new(
        store: Store,
        connections: ConnectionManager,
        operation: OperationRuntime,
        terminal_runs: TerminalQueryRunRegistry,
    ) -> Self {
        Self {
            store,
            connections,
            operation,
            terminal_runs,
        }
    }

    /// Seeds a durable plan only for crate characterization fixtures.
    #[cfg(test)]
    pub(crate) async fn seed_plan_for_test(
        &self,
        pin: &crate::store::PinnedConnection,
        authority: &crate::kernel::TerminalAuthority,
        seed: SeedQueryPlanForTest,
    ) {
        let policy = capture_agent_read_policy(pin).unwrap();
        let elapsed = Instant::now().saturating_duration_since(seed.created_at);
        let remaining = QUERY_PLAN_TTL.saturating_sub(elapsed);
        let expires_at = Utc::now()
            + ChronoDuration::from_std(remaining)
                .expect("seeded query plan TTL is representable by chrono");
        let origin = AgentQueryInvocationOrigin::Cli;
        let actor_id = seed.actor_id.unwrap_or_else(|| origin.as_str().into());
        let mut actor = agent_actor_for_pin(pin, actor_id, origin.as_str().into());
        actor.provenance.client_protocol_version = Some(authority.client_protocol_version);
        self.operation
            .plan(
                NewOperation {
                    id: seed.plan_id.into(),
                    workspace_id: pin.scope.workspace_id,
                    account_scope: pin.scope.account_scope.storage_key().into(),
                    connection_id: pin.connection_id,
                    connection_revision: pin.connection_revision,
                    terminal_session_id: Some(authority.terminal_session_id.into()),
                    actor,
                    kind: OperationKind::ReadQuery,
                    payload_schema_version: 1,
                    payload: serde_json::to_value(StoredAgentReadPayload {
                        sql: seed.sql,
                        max_rows: seed.max_rows.min(MAX_AGENT_ROWS),
                        decision: seed.decision,
                        origin,
                    })
                    .unwrap(),
                    schema_fingerprint: None,
                    risk_level: OperationRiskLevel::Low,
                    preview: serde_json::json!({"seededForTest": true}),
                    policy_snapshot: policy.0,
                    policy_revision: policy.1,
                    single_use: true,
                    idempotency_key: seed.plan_id.to_string(),
                    expires_at: Some(expires_at),
                },
                OperationPlanDisposition::Ready,
            )
            .await
            .unwrap();
    }
}

/// Keeps the read lease alive until Broker projection is complete.
pub(crate) struct AgentQueryPlanReceipt {
    plan: AgentQueryPlan,
    _lease: ConnectionLease,
}

impl AgentQueryPlanReceipt {
    pub(crate) fn plan(&self) -> &AgentQueryPlan {
        &self.plan
    }
}

impl TerminalQueryAdapter {
    async fn plan(
        &self,
        request: TerminalQueryPlanRequest,
    ) -> Result<AgentQueryPlanReceipt, AgentQueryPlanError> {
        let authority = request.authority;
        let context = self
            .connections
            .pin(request.connection_id.into(), ConnectionAccess::Read)
            .await
            .map_err(AgentQueryPlanError::Application)?;
        let profile = context.pin().profile.clone();
        if profile.engine.is_document() {
            return Err(AgentQueryPlanError::DocumentConnection);
        }
        let classification = safety::classify(&request.sql, profile.engine)
            .map_err(AgentQueryPlanError::Application)?;
        if !matches!(classification.kind, crate::model::QueryKind::Read)
            || classification.statement_count != 1
        {
            audit_best_effort(
                &self.store,
                profile.id,
                profile.engine,
                &request.sql,
                classification.kind,
                AgentQueryInvocationOrigin::Cli.plan_audit_action(),
                Some("query plan accepts exactly one read-only SELECT statement".into()),
            )
            .await;
            return Err(AgentQueryPlanError::NotSingleRead);
        }
        let settings = self
            .store
            .get_safety(profile.id)
            .await
            .map_err(AgentQueryPlanError::Application)?;
        let max_rows = bounded_max_rows(request.max_rows, settings.max_rows);
        let operation_pin = context.pin().clone();
        ensure_terminal_pin(&authority, &operation_pin)
            .map_err(AgentQueryPlanError::Application)?;
        let policy =
            capture_agent_read_policy(&operation_pin).map_err(AgentQueryPlanError::Application)?;
        let lease = context
            .connect()
            .await
            .map_err(AgentQueryPlanError::Application)?;
        let live = lease
            .live()
            .sql()
            .map_err(AgentQueryPlanError::Application)?;
        let preview = safety::preview(
            pool_ref(live.ro()),
            &request.sql,
            &classification,
            &settings,
        )
        .await
        .map_err(AgentQueryPlanError::Application)?;
        let health = monitoring::snapshot(live, profile.engine).await;
        let (decision, notices, suggestions) = planning_guidance(
            &profile,
            &health,
            preview.estimated_rows,
            settings.exec_preview_row_limit,
        );
        let plan_id = OperationId::from(Uuid::new_v4());
        audit_best_effort(
            &self.store,
            profile.id,
            profile.engine,
            &request.sql,
            crate::model::QueryKind::Read,
            AgentQueryInvocationOrigin::Cli.plan_audit_action(),
            None,
        )
        .await;
        let payload = serde_json::to_value(StoredAgentReadPayload {
            sql: request.sql,
            max_rows,
            decision: decision.clone(),
            origin: AgentQueryInvocationOrigin::Cli,
        })
        .map_err(AppError::from)
        .map_err(AgentQueryPlanError::Application)?;
        let expires_at = Utc::now()
            + ChronoDuration::from_std(QUERY_PLAN_TTL)
                .expect("query plan TTL is representable by chrono");
        let mut actor = agent_actor_for_pin(&operation_pin, "cli".into(), "cli".into());
        actor.provenance.client_protocol_version = Some(authority.client_protocol_version);
        self.operation
            .plan(
                NewOperation {
                    id: plan_id.into(),
                    workspace_id: operation_pin.scope.workspace_id,
                    account_scope: operation_pin.scope.account_scope.storage_key().into(),
                    connection_id: operation_pin.connection_id,
                    connection_revision: operation_pin.connection_revision,
                    terminal_session_id: Some(authority.terminal_session_id.into()),
                    actor,
                    kind: OperationKind::ReadQuery,
                    payload_schema_version: 1,
                    payload,
                    schema_fingerprint: None,
                    risk_level: operation_risk(&classification),
                    preview: serde_json::json!({
                        "decision": decision,
                        "estimatedRows": preview.estimated_rows,
                        "health": health,
                        "notices": notices,
                        "suggestions": suggestions,
                    }),
                    policy_snapshot: policy.0,
                    policy_revision: policy.1,
                    single_use: true,
                    idempotency_key: plan_id.to_string(),
                    expires_at: Some(expires_at),
                },
                OperationPlanDisposition::Ready,
            )
            .await
            .map_err(AgentQueryPlanError::Application)?;
        Ok(AgentQueryPlanReceipt {
            plan: AgentQueryPlan {
                connection_id: ConnectionId::from(profile.id),
                connection_name: profile.name,
                environment: profile.env,
                plan_id,
                decision,
                notices,
                suggestions,
                estimated_rows: preview.estimated_rows,
                health,
                expires_at,
            },
            _lease: lease,
        })
    }
}

fn operation_risk(classification: &crate::model::Classification) -> OperationRiskLevel {
    if classification.no_where && !matches!(classification.kind, crate::model::QueryKind::Read) {
        return OperationRiskLevel::Critical;
    }
    match classification.risk {
        crate::model::RiskLevel::Low => OperationRiskLevel::Low,
        crate::model::RiskLevel::Medium => OperationRiskLevel::Medium,
        crate::model::RiskLevel::High => OperationRiskLevel::High,
    }
}

impl TerminalQueryPort for TerminalQueryAdapter {
    type PlanReceipt = AgentQueryPlanReceipt;
    type PreparedRun = super::terminal_run::PreparedAgentQueryRun;
    type PlanError = AgentQueryPlanError;
    type PrepareError = AgentQueryRunPrepareError;

    async fn plan_terminal_read(
        &self,
        request: TerminalQueryPlanRequest,
    ) -> Result<Self::PlanReceipt, AgentQueryPlanError> {
        self.plan(request).await
    }

    async fn prepare_terminal_run(
        &self,
        plan_id: OperationId,
        authority: &crate::kernel::TerminalAuthority,
    ) -> Result<Self::PreparedRun, Self::PrepareError> {
        self.prepare(plan_id, authority).await
    }
}
