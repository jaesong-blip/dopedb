//! Evidence-bound Agent report values. These types cannot represent result rows,
//! local artifact handles, credentials, or Agent transcripts.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::kernel::identity::{ConnectionId, QueryRunId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentReportClaim {
    pub(crate) statement: String,
    pub(crate) query_run_ids: Vec<QueryRunId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentReportPresentation {
    pub(crate) title: String,
    pub(crate) question: String,
    pub(crate) conclusion: String,
    pub(crate) preflight_warnings: Vec<String>,
    pub(crate) claims: Vec<AgentReportClaim>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReportEvidenceDraft {
    pub(crate) id: Uuid,
    pub(crate) query_run_id: QueryRunId,
    pub(crate) sql: String,
    pub(crate) executed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReportClaimDraft {
    pub(crate) id: Uuid,
    pub(crate) statement: String,
    pub(crate) evidence_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostedReportDraft {
    pub(crate) id: Uuid,
    pub(crate) connection_id: ConnectionId,
    pub(crate) title: String,
    pub(crate) question: String,
    pub(crate) conclusion: String,
    pub(crate) preflight_warnings: Vec<String>,
    pub(crate) claims: Vec<ReportClaimDraft>,
    pub(crate) evidence: Vec<ReportEvidenceDraft>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentReportEvidenceAppend {
    pub(crate) report_id: Uuid,
    pub(crate) expected_revision: u64,
    pub(crate) claims: Vec<AgentReportClaim>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostedReportEvidenceAppend {
    pub(crate) report_id: Uuid,
    pub(crate) expected_revision: u64,
    pub(crate) connection_id: ConnectionId,
    pub(crate) claims: Vec<ReportClaimDraft>,
    pub(crate) evidence: Vec<ReportEvidenceDraft>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentReportProposal {
    pub(crate) id: Uuid,
    pub(crate) connection_id: ConnectionId,
    pub(crate) title: String,
    pub(crate) question: String,
    pub(crate) conclusion: String,
    pub(crate) state: String,
    pub(crate) source: String,
    pub(crate) revision: u64,
    pub(crate) evidence_count: usize,
    pub(crate) query_run_ids: Vec<QueryRunId>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

pub(crate) const STORED_REPORT_MUTATION_SCHEMA_VERSION: u8 = 1;

/// The exact non-secret local authority retained with a queued report mutation.
/// A replay is allowed only while the same account, connection revision, and
/// member-local binding revision still authorize the active Team workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredReportMutationAuthority {
    pub(crate) account_user_id: String,
    pub(crate) connection_revision: i64,
    pub(crate) binding_revision: i64,
    pub(crate) binding_updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum StoredReportMutationKind {
    Propose {
        draft: HostedReportDraft,
        query_run_ids: Vec<QueryRunId>,
    },
    AppendEvidence {
        draft: HostedReportEvidenceAppend,
        query_run_ids: Vec<QueryRunId>,
    },
}

/// Versioned, bounded payload stored in SQLite's general workspace outbox. It can
/// represent report definition and immutable SQL evidence, but has no field for
/// result rows, credentials, local artifact handles, or Agent transcripts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredReportMutation {
    pub(crate) schema_version: u8,
    pub(crate) authority: StoredReportMutationAuthority,
    pub(crate) mutation: StoredReportMutationKind,
}

impl StoredReportMutation {
    pub(crate) fn report_id(&self) -> Uuid {
        match &self.mutation {
            StoredReportMutationKind::Propose { draft, .. } => draft.id,
            StoredReportMutationKind::AppendEvidence { draft, .. } => draft.report_id,
        }
    }

    pub(crate) fn connection_id(&self) -> ConnectionId {
        match &self.mutation {
            StoredReportMutationKind::Propose { draft, .. } => draft.connection_id,
            StoredReportMutationKind::AppendEvidence { draft, .. } => draft.connection_id,
        }
    }

    pub(crate) fn expected_revision(&self) -> u64 {
        match &self.mutation {
            StoredReportMutationKind::Propose { .. } => 0,
            StoredReportMutationKind::AppendEvidence { draft, .. } => draft.expected_revision,
        }
    }

    pub(crate) fn query_run_ids(&self) -> &[QueryRunId] {
        match &self.mutation {
            StoredReportMutationKind::Propose { query_run_ids, .. }
            | StoredReportMutationKind::AppendEvidence { query_run_ids, .. } => query_run_ids,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingReportMutation {
    pub(crate) outbox_id: Uuid,
    pub(crate) workspace_id: Uuid,
    pub(crate) stored: StoredReportMutation,
}

#[derive(Debug)]
pub(crate) enum AgentReportProposeError {
    QueryRunNotFound,
    QueryRunIneligible,
    MixedConnections,
    WorkspaceRequired,
    InvalidPresentation(AppError),
    Application(AppError),
}

fn safe_display(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max_chars
        && !value.chars().any(|character| {
            character.is_control() && !matches!(character, '\n' | '\r' | '\t')
                || matches!(
                    character,
                    '\u{202a}'
                        | '\u{202b}'
                        | '\u{202c}'
                        | '\u{202d}'
                        | '\u{202e}'
                        | '\u{2066}'
                        | '\u{2067}'
                        | '\u{2068}'
                        | '\u{2069}'
                )
        })
}

pub(crate) fn validate_presentation(
    presentation: &AgentReportPresentation,
) -> Result<(), AppError> {
    if !safe_display(&presentation.title, 120)
        || !safe_display(&presentation.question, 8_000)
        || !safe_display(&presentation.conclusion, 20_000)
        || presentation.preflight_warnings.len() > 32
        || presentation
            .preflight_warnings
            .iter()
            .any(|warning| !safe_display(warning, 2_000))
    {
        return Err(AppError::Config("invalid Agent report presentation".into()));
    }
    validate_claims(&presentation.claims)
}

pub(crate) fn validate_claims(claims: &[AgentReportClaim]) -> Result<(), AppError> {
    if claims.is_empty() || claims.len() > 32 {
        return Err(AppError::Config("invalid Agent report claims".into()));
    }
    let mut unique_runs = std::collections::BTreeSet::new();
    for claim in claims {
        if !safe_display(&claim.statement, 4_000)
            || claim.query_run_ids.is_empty()
            || claim.query_run_ids.len() > 8
        {
            return Err(AppError::Config("invalid Agent report claim".into()));
        }
        let claim_runs = claim
            .query_run_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        if claim_runs.len() != claim.query_run_ids.len() {
            return Err(AppError::Config(
                "Agent report claim repeats query-run evidence".into(),
            ));
        }
        unique_runs.extend(claim_runs);
    }
    if unique_runs.len() > 32 {
        return Err(AppError::Config(
            "Agent report references too many query runs".into(),
        ));
    }
    Ok(())
}

fn validate_hosted_claims_and_evidence(
    claims: &[ReportClaimDraft],
    evidence: &[ReportEvidenceDraft],
) -> Result<(), AppError> {
    if claims.is_empty() || claims.len() > 32 || evidence.is_empty() || evidence.len() > 32 {
        return Err(AppError::Config(
            "invalid stored Agent report evidence".into(),
        ));
    }
    let claim_ids = claims
        .iter()
        .map(|claim| claim.id)
        .collect::<std::collections::BTreeSet<_>>();
    let evidence_ids = evidence
        .iter()
        .map(|item| item.id)
        .collect::<std::collections::BTreeSet<_>>();
    let query_run_ids = evidence
        .iter()
        .map(|item| item.query_run_id)
        .collect::<std::collections::BTreeSet<_>>();
    if claim_ids.len() != claims.len()
        || evidence_ids.len() != evidence.len()
        || query_run_ids.len() != evidence.len()
        || evidence.iter().any(|item| {
            item.sql.trim().is_empty()
                || item.sql.len() > 20_000
                || item.sql.contains('\0')
                || item.executed_at > Utc::now() + chrono::Duration::minutes(5)
        })
    {
        return Err(AppError::Config(
            "invalid stored Agent report evidence".into(),
        ));
    }
    let mut referenced = std::collections::BTreeSet::new();
    for claim in claims {
        let claim_evidence = claim
            .evidence_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        if !safe_display(&claim.statement, 4_000)
            || claim.evidence_ids.is_empty()
            || claim.evidence_ids.len() > 8
            || claim_evidence.len() != claim.evidence_ids.len()
            || !claim_evidence.is_subset(&evidence_ids)
        {
            return Err(AppError::Config("invalid stored Agent report claim".into()));
        }
        referenced.extend(claim_evidence);
    }
    if referenced != evidence_ids {
        return Err(AppError::Config(
            "stored Agent report contains unreferenced evidence".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_hosted_draft(draft: &HostedReportDraft) -> Result<(), AppError> {
    if !safe_display(&draft.title, 120)
        || !safe_display(&draft.question, 8_000)
        || !safe_display(&draft.conclusion, 20_000)
        || draft.preflight_warnings.len() > 32
        || draft
            .preflight_warnings
            .iter()
            .any(|warning| !safe_display(warning, 2_000))
    {
        return Err(AppError::Config(
            "invalid stored Agent report definition".into(),
        ));
    }
    validate_hosted_claims_and_evidence(&draft.claims, &draft.evidence)
}

pub(crate) fn validate_hosted_append(draft: &HostedReportEvidenceAppend) -> Result<(), AppError> {
    if draft.expected_revision == 0 || draft.expected_revision > 9_007_199_254_740_991 {
        return Err(AppError::Config(
            "invalid stored Agent report revision".into(),
        ));
    }
    validate_hosted_claims_and_evidence(&draft.claims, &draft.evidence)
}

pub(crate) fn validate_stored_mutation(value: &StoredReportMutation) -> Result<(), AppError> {
    if value.schema_version != STORED_REPORT_MUTATION_SCHEMA_VERSION
        || crate::kernel::identity::AccountId::new(&value.authority.account_user_id).is_none()
        || value.authority.connection_revision < 1
        || value.authority.binding_revision < 0
        || value.authority.binding_updated_at.len() > 128
        || value
            .authority
            .binding_updated_at
            .chars()
            .any(char::is_control)
    {
        return Err(AppError::Config(
            "invalid stored Agent report authority".into(),
        ));
    }
    let evidence_runs = match &value.mutation {
        StoredReportMutationKind::Propose { draft, .. } => {
            validate_hosted_draft(draft)?;
            draft
                .evidence
                .iter()
                .map(|item| item.query_run_id)
                .collect::<std::collections::BTreeSet<_>>()
        }
        StoredReportMutationKind::AppendEvidence { draft, .. } => {
            validate_hosted_append(draft)?;
            draft
                .evidence
                .iter()
                .map(|item| item.query_run_id)
                .collect::<std::collections::BTreeSet<_>>()
        }
    };
    let retained_runs = value
        .query_run_ids()
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if retained_runs.len() != value.query_run_ids().len() || retained_runs != evidence_runs {
        return Err(AppError::Config(
            "stored Agent report provenance changed".into(),
        ));
    }
    Ok(())
}
