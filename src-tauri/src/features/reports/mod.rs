//! Evidence-bound Agent report proposal feature.

mod domain;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use uuid::Uuid;

use crate::connection::{ensure_terminal_pin, ConnectionManager};
use crate::error::AppError;
use crate::features::queries::{QueryRunAuthorizationError, QueryRunAuthorizationPort};
use crate::features::workspaces::adapters::control_plane::{
    append_report_evidence, propose_report,
};
use crate::features::workspaces::WorkspaceKind;
use crate::kernel::identity::{ConnectionId, QueryRunId};
use crate::kernel::TerminalAuthority;
use crate::model::{HistoryEntry, QueryKind};
use crate::store::Store;

pub(crate) use domain::{
    AgentReportClaim, AgentReportEvidenceAppend, AgentReportPresentation, AgentReportProposal,
    AgentReportProposeError, HostedReportDraft, HostedReportEvidenceAppend, ReportClaimDraft,
    ReportEvidenceDraft,
};

fn eligible_run(source: &HistoryEntry) -> bool {
    source.origin == "agent"
        && source.status == "ok"
        && matches!(source.kind, QueryKind::Read)
        && !source.sql.trim().is_empty()
        && source.sql.len() <= 20_000
        && !source.sql.contains('\0')
}

#[derive(Clone)]
pub(crate) struct ReportsFeature {
    store: Store,
    connections: ConnectionManager,
    terminal_runs: Arc<dyn QueryRunAuthorizationPort>,
}

struct ResolvedAgentEvidence {
    workspace_id: Uuid,
    user_id: String,
    connection_id: ConnectionId,
    claims: Vec<ReportClaimDraft>,
    evidence: Vec<ReportEvidenceDraft>,
    query_run_ids: Vec<QueryRunId>,
}

impl ReportsFeature {
    pub(crate) async fn propose_terminal(
        &self,
        authority: &TerminalAuthority,
        presentation: AgentReportPresentation,
    ) -> Result<AgentReportProposal, AgentReportProposeError> {
        domain::validate_presentation(&presentation)
            .map_err(AgentReportProposeError::InvalidPresentation)?;
        let resolved = self
            .resolve_terminal_evidence(authority, &presentation.claims)
            .await?;
        let draft = HostedReportDraft {
            id: Uuid::new_v4(),
            connection_id: resolved.connection_id,
            title: presentation.title,
            question: presentation.question,
            conclusion: presentation.conclusion,
            preflight_warnings: presentation.preflight_warnings,
            claims: resolved.claims,
            evidence: resolved.evidence,
        };
        let mut proposal = propose_report(&resolved.user_id, resolved.workspace_id, &draft)
            .await
            .map_err(AgentReportProposeError::Application)?;
        proposal.query_run_ids = resolved.query_run_ids;
        Ok(proposal)
    }

    pub(crate) async fn append_terminal_evidence(
        &self,
        authority: &TerminalAuthority,
        append: AgentReportEvidenceAppend,
    ) -> Result<AgentReportProposal, AgentReportProposeError> {
        if append.expected_revision == 0 || append.expected_revision > 9_007_199_254_740_991 {
            return Err(AgentReportProposeError::InvalidPresentation(
                AppError::Config("invalid Agent report revision".into()),
            ));
        }
        domain::validate_claims(&append.claims)
            .map_err(AgentReportProposeError::InvalidPresentation)?;
        let resolved = self
            .resolve_terminal_evidence(authority, &append.claims)
            .await?;
        let draft = HostedReportEvidenceAppend {
            report_id: append.report_id,
            expected_revision: append.expected_revision,
            connection_id: resolved.connection_id,
            claims: resolved.claims,
            evidence: resolved.evidence,
        };
        let mut proposal = append_report_evidence(
            &resolved.user_id,
            resolved.workspace_id,
            &draft,
        )
        .await
        .map_err(AgentReportProposeError::Application)?;
        proposal.query_run_ids = resolved.query_run_ids;
        Ok(proposal)
    }

    async fn resolve_terminal_evidence(
        &self,
        authority: &TerminalAuthority,
        claims: &[AgentReportClaim],
    ) -> Result<ResolvedAgentEvidence, AgentReportProposeError> {
        let unique_run_ids = claims
            .iter()
            .flat_map(|claim| claim.query_run_ids.iter().copied())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        for query_run_id in &unique_run_ids {
            self.terminal_runs
                .authorize(*query_run_id, authority)
                .map_err(map_query_run_authorization_error)?;
        }
        let mut resolved = Vec::with_capacity(unique_run_ids.len());
        for query_run_id in &unique_run_ids {
            let source = match self
                .store
                .resolve_history_for_shared_artifact_prepare((*query_run_id).into())
                .await
            {
                Ok(source) => source,
                Err(AppError::NotFound(_)) => {
                    return Err(AgentReportProposeError::QueryRunNotFound)
                }
                Err(error) => return Err(AgentReportProposeError::Application(error)),
            };
            if !eligible_run(&source.history) {
                return Err(AgentReportProposeError::QueryRunIneligible);
            }
            resolved.push((*query_run_id, source));
        }
        let Some((_, first)) = resolved.first() else {
            return Err(AgentReportProposeError::InvalidPresentation(
                AppError::Config("Agent report requires query-run evidence".into()),
            ));
        };
        if resolved
            .iter()
            .any(|(_, source)| source.history.connection_id != first.history.connection_id)
        {
            return Err(AgentReportProposeError::MixedConnections);
        }
        let operation_scope = self.connections.begin_operation_scope().await;
        let connection = operation_scope
            .pin_shared_artifact_connection(first.history.connection_id)
            .await
            .map_err(AgentReportProposeError::Application)?;
        ensure_terminal_pin(authority, &connection)
            .map_err(AgentReportProposeError::Application)?;
        if connection.scope.workspace_kind != WorkspaceKind::Team
            || !connection.requires_remote_rbac
        {
            return Err(AgentReportProposeError::WorkspaceRequired);
        }
        let user_id = connection
            .scope
            .selected_account_id
            .as_deref()
            .ok_or(AgentReportProposeError::WorkspaceRequired)?
            .to_owned();
        let mut current_runs = BTreeMap::new();
        for (query_run_id, initial) in &resolved {
            let source = match self
                .store
                .get_history_if_current(&connection, initial)
                .await
            {
                Ok(source) => source,
                Err(AppError::NotFound(_)) => {
                    return Err(AgentReportProposeError::QueryRunNotFound)
                }
                Err(error) => return Err(AgentReportProposeError::Application(error)),
            };
            if !eligible_run(&source) {
                return Err(AgentReportProposeError::QueryRunIneligible);
            }
            if source.connection_id != connection.connection_id {
                return Err(AgentReportProposeError::MixedConnections);
            }
            current_runs.insert(*query_run_id, source);
        }
        let evidence_ids = unique_run_ids
            .iter()
            .copied()
            .map(|query_run_id| (query_run_id, Uuid::new_v4()))
            .collect::<BTreeMap<_, _>>();
        let evidence = unique_run_ids
            .iter()
            .map(|query_run_id| {
                let source = current_runs
                    .get(query_run_id)
                    .expect("validated report query run must remain present");
                ReportEvidenceDraft {
                    id: evidence_ids[query_run_id],
                    query_run_id: *query_run_id,
                    sql: source.sql.clone(),
                    executed_at: source.executed_at,
                }
            })
            .collect();
        let claims = claims
            .iter()
            .map(|claim| ReportClaimDraft {
                id: Uuid::new_v4(),
                statement: claim.statement.clone(),
                evidence_ids: claim
                    .query_run_ids
                    .iter()
                    .map(|query_run_id| evidence_ids[query_run_id])
                    .collect(),
            })
            .collect();
        Ok(ResolvedAgentEvidence {
            workspace_id: connection.scope.workspace_id,
            user_id,
            connection_id: connection.connection_id.into(),
            claims,
            evidence,
            query_run_ids: unique_run_ids,
        })
    }
}

fn map_query_run_authorization_error(error: QueryRunAuthorizationError) -> AgentReportProposeError {
    match error {
        QueryRunAuthorizationError::NotAuthorized => {
            AgentReportProposeError::Application(AppError::Blocked {
                reason: "query run does not belong to this live Terminal session".into(),
            })
        }
    }
}

pub(crate) fn compose(
    store: Store,
    connections: ConnectionManager,
    terminal_runs: Arc<dyn QueryRunAuthorizationPort>,
) -> ReportsFeature {
    ReportsFeature {
        store,
        connections,
        terminal_runs,
    }
}
