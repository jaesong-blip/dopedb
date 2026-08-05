//! Evidence-bound Agent report proposal feature.

mod domain;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use tokio::sync::Mutex;
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
use crate::store::{PinnedConnection, Store};

pub(crate) use domain::validate_stored_mutation;
pub(crate) use domain::{
    AgentReportClaim, AgentReportEvidenceAppend, AgentReportPresentation, AgentReportProposal,
    AgentReportProposeError, HostedReportDraft, HostedReportEvidenceAppend, PendingReportMutation,
    ReportClaimDraft, ReportEvidenceDraft, StoredReportMutation, StoredReportMutationAuthority,
    StoredReportMutationKind, STORED_REPORT_MUTATION_SCHEMA_VERSION,
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
    sync_lock: Arc<Mutex<()>>,
}

struct ResolvedAgentEvidence {
    user_id: String,
    connection_id: ConnectionId,
    claims: Vec<ReportClaimDraft>,
    evidence: Vec<ReportEvidenceDraft>,
    query_run_ids: Vec<QueryRunId>,
    connection: PinnedConnection,
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
        let stored = StoredReportMutation {
            schema_version: STORED_REPORT_MUTATION_SCHEMA_VERSION,
            authority: stored_authority(&resolved.connection, &resolved.user_id),
            mutation: StoredReportMutationKind::Propose {
                draft,
                query_run_ids: resolved.query_run_ids,
            },
        };
        self.enqueue_and_replay(&resolved.connection, stored).await
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
        let stored = StoredReportMutation {
            schema_version: STORED_REPORT_MUTATION_SCHEMA_VERSION,
            authority: stored_authority(&resolved.connection, &resolved.user_id),
            mutation: StoredReportMutationKind::AppendEvidence {
                draft,
                query_run_ids: resolved.query_run_ids,
            },
        };
        self.enqueue_and_replay(&resolved.connection, stored).await
    }

    async fn enqueue_and_replay(
        &self,
        connection: &PinnedConnection,
        stored: StoredReportMutation,
    ) -> Result<AgentReportProposal, AgentReportProposeError> {
        let _guard = self.sync_lock.lock().await;
        let stored_report_id = stored.report_id();
        let target = self
            .store
            .enqueue_report_mutation_if_current(connection, &stored)
            .await
            .map_err(AgentReportProposeError::Application)?;
        let replay = self.replay_pending_locked(Some(target)).await;
        match replay {
            Ok(Some(proposal)) => Ok(proposal),
            Ok(None) => Err(AgentReportProposeError::Application(AppError::NotFound(
                "queued Agent report mutation".into(),
            ))),
            Err(error) => {
                tracing::warn!(
                    error_kind = error.kind(),
                    report_id = %stored_report_id,
                    "Agent report mutation retained for replay"
                );
                Err(AgentReportProposeError::Application(
                    AppError::OutcomeUnknown(
                        "Agent report mutation is retained for authenticated replay".into(),
                    ),
                ))
            }
        }
    }

    /// Best-effort startup/workspace-switch recovery. Callers log the categorical
    /// error and keep the outbox row; a later authenticated activation retries it.
    pub(crate) async fn replay_pending_active(&self) -> Result<(), AppError> {
        let _guard = self.sync_lock.lock().await;
        self.replay_pending_locked(None).await.map(|_| ())
    }

    async fn replay_pending_locked(
        &self,
        target: Option<Uuid>,
    ) -> Result<Option<AgentReportProposal>, AppError> {
        let pending = self
            .store
            .pending_report_mutations_for_active_scope()
            .await?;
        let mut target_result = None;
        for mutation in pending {
            if !self
                .store
                .is_report_mutation_authority_current(&mutation)
                .await?
            {
                let error = AppError::Blocked {
                    reason: "queued Agent report authority is no longer current".into(),
                };
                self.store
                    .record_report_mutation_failure(&mutation, &error)
                    .await?;
                return Err(error);
            }
            let result = send_pending_report_mutation(&mutation).await;
            let mut proposal = match result {
                Ok(proposal) => proposal,
                Err(error) => {
                    self.store
                        .record_report_mutation_failure(&mutation, &error)
                        .await?;
                    return Err(error);
                }
            };
            // A workspace/account/connection change during the request cannot consume
            // the durable row. Server idempotency makes a later exact retry safe.
            if !self
                .store
                .is_report_mutation_authority_current(&mutation)
                .await?
            {
                let error = AppError::Blocked {
                    reason: "Agent report authority changed while replaying".into(),
                };
                self.store
                    .record_report_mutation_failure(&mutation, &error)
                    .await?;
                return Err(error);
            }
            proposal.query_run_ids = mutation.stored.query_run_ids().to_vec();
            self.store.acknowledge_report_mutation(&mutation).await?;
            if target == Some(mutation.outbox_id) {
                target_result = Some(proposal);
            }
        }
        Ok(target_result)
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
            user_id,
            connection_id: connection.connection_id.into(),
            claims,
            evidence,
            query_run_ids: unique_run_ids,
            connection,
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
        sync_lock: Arc::new(Mutex::new(())),
    }
}

fn stored_authority(
    connection: &PinnedConnection,
    account_user_id: &str,
) -> StoredReportMutationAuthority {
    StoredReportMutationAuthority {
        account_user_id: account_user_id.to_owned(),
        connection_revision: connection.connection_revision,
        binding_revision: connection.binding_revision,
        binding_updated_at: connection.binding_updated_at.clone(),
    }
}

async fn send_pending_report_mutation(
    pending: &PendingReportMutation,
) -> Result<AgentReportProposal, AppError> {
    let user_id = &pending.stored.authority.account_user_id;
    match &pending.stored.mutation {
        StoredReportMutationKind::Propose { draft, .. } => {
            propose_report(user_id, pending.workspace_id, draft).await
        }
        StoredReportMutationKind::AppendEvidence { draft, .. } => {
            append_report_evidence(user_id, pending.workspace_id, draft).await
        }
    }
}
