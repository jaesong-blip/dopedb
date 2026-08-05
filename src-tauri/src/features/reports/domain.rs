//! Evidence-bound Agent report values. These types cannot represent result rows,
//! local artifact handles, credentials, or Agent transcripts.

use chrono::{DateTime, Utc};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReportEvidenceDraft {
    pub(crate) id: Uuid,
    pub(crate) query_run_id: QueryRunId,
    pub(crate) sql: String,
    pub(crate) executed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReportClaimDraft {
    pub(crate) id: Uuid,
    pub(crate) statement: String,
    pub(crate) evidence_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
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
