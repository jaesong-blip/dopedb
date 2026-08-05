//! Secret-free hosted Agent report proposal exchange.

use super::*;
use crate::features::reports::{
    AgentReportProposal, HostedReportDraft, HostedReportEvidenceAppend, ReportClaimDraft,
    ReportEvidenceDraft,
};
use crate::kernel::identity::{ConnectionId, QueryRunId};
use chrono::{DateTime, Utc};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportEvidenceRequest<'a> {
    id: Uuid,
    query_run_id: Uuid,
    sql: &'a str,
    executed_at: DateTime<Utc>,
}

impl<'a> From<&'a ReportEvidenceDraft> for ReportEvidenceRequest<'a> {
    fn from(value: &'a ReportEvidenceDraft) -> Self {
        Self {
            id: value.id,
            query_run_id: value.query_run_id.into(),
            sql: &value.sql,
            executed_at: value.executed_at,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportClaimRequest<'a> {
    id: Uuid,
    statement: &'a str,
    evidence_ids: &'a [Uuid],
}

impl<'a> From<&'a ReportClaimDraft> for ReportClaimRequest<'a> {
    fn from(value: &'a ReportClaimDraft) -> Self {
        Self {
            id: value.id,
            statement: &value.statement,
            evidence_ids: &value.evidence_ids,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateReportRequest<'a> {
    id: Uuid,
    connection_id: Uuid,
    title: &'a str,
    question: &'a str,
    conclusion: &'a str,
    preflight_warnings: &'a [String],
    claims: Vec<ReportClaimRequest<'a>>,
    evidence: Vec<ReportEvidenceRequest<'a>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppendReportEvidenceRequest<'a> {
    connection_id: Uuid,
    claims: Vec<ReportClaimRequest<'a>>,
    evidence: Vec<ReportEvidenceRequest<'a>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteReportClaim {
    id: String,
    statement: String,
    evidence_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteReportEvidence {
    id: String,
    query_run_id: String,
    sql: String,
    executed_at: String,
    added_at_revision: u64,
    created_by_member_id: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteReportResponse {
    id: String,
    connection_id: String,
    title: String,
    question: String,
    conclusion: String,
    preflight_warnings: Vec<String>,
    claims: Vec<RemoteReportClaim>,
    state: String,
    source: String,
    owner_member_id: String,
    updated_by_member_id: String,
    revision: u64,
    evidence_count: usize,
    created_at: String,
    updated_at: String,
    evidence: Vec<RemoteReportEvidence>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatedReportResponse {
    report: RemoteReportResponse,
}

fn parse_timestamp(value: &str, label: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| AppError::Network(format!("Agent report returned an invalid {label}")))
}

fn parse_response(
    value: RemoteReportResponse,
    draft: &HostedReportDraft,
) -> AppResult<AgentReportProposal> {
    let id = Uuid::parse_str(&value.id)
        .map_err(|_| AppError::Network("Agent report returned an invalid id".into()))?;
    let connection_id = Uuid::parse_str(&value.connection_id)
        .map_err(|_| AppError::Network("Agent report returned an invalid connection id".into()))?;
    if id != draft.id
        || connection_id != Uuid::from(draft.connection_id)
        || value.title != draft.title
        || value.question != draft.question
        || value.conclusion != draft.conclusion
        || value.preflight_warnings != draft.preflight_warnings
        || value.state != "draft"
        || value.source != "agent_proposal"
        || value.revision != 1
        || value.evidence_count != draft.evidence.len()
        || value.claims.len() != draft.claims.len()
        || value.evidence.len() != draft.evidence.len()
        || value.owner_member_id.is_empty()
        || value.updated_by_member_id.is_empty()
    {
        return Err(AppError::Network(
            "Agent report proposal changed identity or definition".into(),
        ));
    }
    for (actual, expected) in value.claims.iter().zip(&draft.claims) {
        let actual_id = Uuid::parse_str(&actual.id)
            .map_err(|_| AppError::Network("Agent report returned an invalid claim id".into()))?;
        let evidence_ids = actual
            .evidence_ids
            .iter()
            .map(|id| Uuid::parse_str(id))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| {
                AppError::Network("Agent report returned invalid claim evidence".into())
            })?;
        if actual_id != expected.id
            || actual.statement != expected.statement
            || evidence_ids != expected.evidence_ids
        {
            return Err(AppError::Network(
                "Agent report proposal changed a claim".into(),
            ));
        }
    }
    for (actual, expected) in value.evidence.iter().zip(&draft.evidence) {
        let actual_id = Uuid::parse_str(&actual.id).map_err(|_| {
            AppError::Network("Agent report returned an invalid evidence id".into())
        })?;
        let actual_run = Uuid::parse_str(&actual.query_run_id).map_err(|_| {
            AppError::Network("Agent report returned an invalid query-run id".into())
        })?;
        if actual_id != expected.id
            || actual_run != Uuid::from(expected.query_run_id)
            || actual.sql != expected.sql
            || parse_timestamp(&actual.executed_at, "evidence timestamp")? != expected.executed_at
            || actual.added_at_revision != 1
            || actual.created_by_member_id.is_empty()
        {
            return Err(AppError::Network(
                "Agent report proposal changed immutable evidence".into(),
            ));
        }
        parse_timestamp(&actual.created_at, "evidence creation timestamp")?;
    }
    Ok(AgentReportProposal {
        id,
        connection_id: ConnectionId::from(connection_id),
        title: value.title,
        question: value.question,
        conclusion: value.conclusion,
        state: value.state,
        source: value.source,
        revision: value.revision,
        evidence_count: value.evidence_count,
        query_run_ids: Vec::<QueryRunId>::new(),
        created_at: parse_timestamp(&value.created_at, "creation timestamp")?,
        updated_at: parse_timestamp(&value.updated_at, "update timestamp")?,
    })
}

fn parse_append_response(
    value: RemoteReportResponse,
    draft: &HostedReportEvidenceAppend,
) -> AppResult<AgentReportProposal> {
    let id = Uuid::parse_str(&value.id)
        .map_err(|_| AppError::Network("Agent report returned an invalid id".into()))?;
    let connection_id = Uuid::parse_str(&value.connection_id)
        .map_err(|_| AppError::Network("Agent report returned an invalid connection id".into()))?;
    let expected_revision = draft
        .expected_revision
        .checked_add(1)
        .ok_or_else(|| AppError::Config("Agent report revision overflowed".into()))?;
    if id != draft.report_id
        || connection_id != Uuid::from(draft.connection_id)
        || value.state != "draft"
        || !matches!(value.source.as_str(), "human" | "agent_proposal")
        || value.revision != expected_revision
        || value.evidence_count < draft.evidence.len()
        || value.evidence_count > 256
        || value.evidence.len() != draft.evidence.len()
        || value.owner_member_id.is_empty()
        || value.updated_by_member_id.is_empty()
    {
        return Err(AppError::Network(
            "Agent report evidence append changed identity or authority".into(),
        ));
    }
    for expected in &draft.claims {
        let actual = value
            .claims
            .iter()
            .find(|claim| claim.id == expected.id.to_string())
            .ok_or_else(|| AppError::Network("Agent report omitted an appended claim".into()))?;
        let evidence_ids = actual
            .evidence_ids
            .iter()
            .map(|id| Uuid::parse_str(id))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| {
                AppError::Network("Agent report returned invalid claim evidence".into())
            })?;
        if actual.statement != expected.statement || evidence_ids != expected.evidence_ids {
            return Err(AppError::Network(
                "Agent report changed an appended claim".into(),
            ));
        }
    }
    for (actual, expected) in value.evidence.iter().zip(&draft.evidence) {
        let actual_id = Uuid::parse_str(&actual.id).map_err(|_| {
            AppError::Network("Agent report returned an invalid evidence id".into())
        })?;
        let actual_run = Uuid::parse_str(&actual.query_run_id).map_err(|_| {
            AppError::Network("Agent report returned an invalid query-run id".into())
        })?;
        if actual_id != expected.id
            || actual_run != Uuid::from(expected.query_run_id)
            || actual.sql != expected.sql
            || parse_timestamp(&actual.executed_at, "evidence timestamp")? != expected.executed_at
            || actual.added_at_revision != expected_revision
            || actual.created_by_member_id.is_empty()
        {
            return Err(AppError::Network(
                "Agent report changed appended immutable evidence".into(),
            ));
        }
        parse_timestamp(&actual.created_at, "evidence creation timestamp")?;
    }
    Ok(AgentReportProposal {
        id,
        connection_id: ConnectionId::from(connection_id),
        title: value.title,
        question: value.question,
        conclusion: value.conclusion,
        state: value.state,
        source: value.source,
        revision: value.revision,
        evidence_count: value.evidence_count,
        query_run_ids: Vec::<QueryRunId>::new(),
        created_at: parse_timestamp(&value.created_at, "creation timestamp")?,
        updated_at: parse_timestamp(&value.updated_at, "update timestamp")?,
    })
}

pub(crate) async fn propose_report(
    user_id: &str,
    workspace_id: Uuid,
    draft: &HostedReportDraft,
) -> AppResult<AgentReportProposal> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("Agent report proposals require an authenticated session".into())
        })?;
    let origin = origin()?;
    let body = CreateReportRequest {
        id: draft.id,
        connection_id: draft.connection_id.into(),
        title: &draft.title,
        question: &draft.question,
        conclusion: &draft.conclusion,
        preflight_warnings: &draft.preflight_warnings,
        claims: draft.claims.iter().map(Into::into).collect(),
        evidence: draft.evidence.iter().map(Into::into).collect(),
    };
    let response = client()?
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/reports/proposals"
        ))
        .bearer_auth(token.as_str())
        .header("if-match", "\"0\"")
        .json(&body)
        .send()
        .await
        .map_err(|error| request_error("proposing Agent report", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let report = response
        .json::<CreatedReportResponse>()
        .await
        .map_err(|error| request_error("reading Agent report proposal", error))?
        .report;
    parse_response(report, draft)
}

pub(crate) async fn append_report_evidence(
    user_id: &str,
    workspace_id: Uuid,
    draft: &HostedReportEvidenceAppend,
) -> AppResult<AgentReportProposal> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("Agent report evidence requires an authenticated session".into())
        })?;
    let origin = origin()?;
    let body = AppendReportEvidenceRequest {
        connection_id: draft.connection_id.into(),
        claims: draft.claims.iter().map(Into::into).collect(),
        evidence: draft.evidence.iter().map(Into::into).collect(),
    };
    let response = client()?
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/reports/{}/proposals",
            draft.report_id,
        ))
        .bearer_auth(token.as_str())
        .header("if-match", format!("\"{}\"", draft.expected_revision))
        .json(&body)
        .send()
        .await
        .map_err(|error| request_error("appending Agent report evidence", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let report = response
        .json::<CreatedReportResponse>()
        .await
        .map_err(|error| request_error("reading appended Agent report evidence", error))?
        .report;
    parse_append_response(report, draft)
}
