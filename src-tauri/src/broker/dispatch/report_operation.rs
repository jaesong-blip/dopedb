//! Agent report draft broker handlers. They can create a draft or append new
//! immutable evidence; replacement, publication, and archival stay human-only.

use super::*;
use crate::features::reports::AgentReportEvidenceAppend;

pub(super) async fn handle(
    dispatcher: &BrokerDispatcher,
    request: &RequestEnvelope,
) -> ResponseEnvelope {
    let request_id = request.request_id;
    let session = match dispatcher.authenticate(request, BrokerCapability::ReportPropose) {
        Ok(session) => session,
        Err(code) => return failure(request_id, code, false),
    };
    match request.command {
        CommandName::ReportPropose => {
            let arguments = match decode_arguments::<ReportProposeCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .report_propose(&session, arguments, request.protocol_version)
                    .await,
            )
        }
        CommandName::ReportAppendEvidence => {
            let arguments = match decode_arguments::<ReportAppendEvidenceCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .report_append_evidence(&session, arguments, request.protocol_version)
                    .await,
            )
        }
        _ => failure(request_id, ErrorCode::InvalidRequest, false),
    }
}

impl BrokerDispatcher {
    async fn report_propose(
        &self,
        session: &AuthenticatedSession,
        arguments: ReportProposeArguments,
        client_protocol_version: u16,
    ) -> Result<ReportProposeResult, ErrorCode> {
        let authority = terminal_authority(session, client_protocol_version);
        let proposal = self
            .services()?
            .report
            .propose_terminal(
                &authority,
                AgentReportPresentation {
                    title: arguments.title,
                    question: arguments.question,
                    conclusion: arguments.conclusion,
                    preflight_warnings: arguments.preflight_warnings,
                    claims: arguments.claims.into_iter().map(report_claim).collect(),
                },
            )
            .await
            .map_err(map_report_propose_error)?;
        Ok(ReportProposeResult {
            report: report_record(&proposal),
            query_run_ids: proposal
                .query_run_ids
                .iter()
                .copied()
                .map(Into::into)
                .collect(),
        })
    }

    async fn report_append_evidence(
        &self,
        session: &AuthenticatedSession,
        arguments: ReportAppendEvidenceArguments,
        client_protocol_version: u16,
    ) -> Result<ReportAppendEvidenceResult, ErrorCode> {
        let authority = terminal_authority(session, client_protocol_version);
        let proposal = self
            .services()?
            .report
            .append_terminal_evidence(
                &authority,
                AgentReportEvidenceAppend {
                    report_id: arguments.report_id,
                    expected_revision: arguments.expected_revision,
                    claims: arguments.claims.into_iter().map(report_claim).collect(),
                },
            )
            .await
            .map_err(map_report_propose_error)?;
        Ok(ReportAppendEvidenceResult {
            report: report_record(&proposal),
            query_run_ids: proposal
                .query_run_ids
                .iter()
                .copied()
                .map(Into::into)
                .collect(),
        })
    }
}

fn report_claim(value: ReportClaimInput) -> AgentReportClaim {
    AgentReportClaim {
        statement: value.statement,
        query_run_ids: value.query_run_ids.into_iter().map(Into::into).collect(),
    }
}
