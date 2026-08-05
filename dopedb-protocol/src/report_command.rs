//! Provenance-bound Agent report proposal contracts for the local broker.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AuthenticationRequirement, CommandName, CommandSpec};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportClaimInput {
    pub statement: String,
    pub query_run_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportProposeArguments {
    pub title: String,
    pub question: String,
    pub conclusion: String,
    #[serde(default)]
    pub preflight_warnings: Vec<String>,
    pub claims: Vec<ReportClaimInput>,
}

pub struct ReportProposeCommand;

impl CommandSpec for ReportProposeCommand {
    type Arguments = ReportProposeArguments;
    type Result = ReportProposeResult;

    const NAME: CommandName = CommandName::ReportPropose;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::TerminalSession;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportAppendEvidenceArguments {
    pub report_id: Uuid,
    pub expected_revision: u64,
    pub claims: Vec<ReportClaimInput>,
}

pub struct ReportAppendEvidenceCommand;

impl CommandSpec for ReportAppendEvidenceCommand {
    type Arguments = ReportAppendEvidenceArguments;
    type Result = ReportAppendEvidenceResult;

    const NAME: CommandName = CommandName::ReportAppendEvidence;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::TerminalSession;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportRecord {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub title: String,
    pub question: String,
    pub conclusion: String,
    pub state: String,
    pub source: String,
    pub revision: u64,
    pub evidence_count: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportProposeResult {
    pub report: ReportRecord,
    pub query_run_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportAppendEvidenceResult {
    pub report: ReportRecord,
    pub query_run_ids: Vec<Uuid>,
}
