//! Broker envelope validation, authentication sequencing, and feature-handler routing.
mod connection_catalog;
mod dashboard_operation;
mod projection;
mod public_skill;
mod query_document;

use projection::*;

#[cfg(test)]
mod tests;

use super::session::{AuthenticatedSession, BrokerCapability, BrokerSessionRegistry};
use crate::error::AppError;
use crate::features::catalog::CatalogReadPolicy;
use crate::features::connections::{AgentConnectionSummary, CliConnectionResolutionError};
use crate::features::dashboards::{
    AgentDashboardCreateError, AgentDashboardPresentation, Dashboard, DashboardKind,
};
use crate::features::documents::{AgentDocumentReadError, TerminalDocumentReadRequest};
use crate::features::queries::TerminalSqlProposalRequest;
use crate::features::queries::{AgentQueryPlanError, TerminalQueryPlanRequest};
use crate::kernel::identity::{ConnectionId, QueryRunId, RuntimeId, TerminalSessionId};
use crate::kernel::TerminalAuthority;
use crate::model::{DocumentPage, DocumentQuery, Engine, QueryResult};
use crate::monitoring::HealthSnapshot;
use crate::services::ApplicationServices;
use crate::skills::SkillManager;
use dopedb_protocol::{
    decode_arguments, encode_frame, AppOpenCommand, AppOpenResult, CatalogArguments,
    CatalogShowCommand, CatalogSnapshot, CommandName, CommandSpec, ConnectionListCommand,
    ConnectionListResult, ConnectionSelector, ConnectionSelectorArguments, ConnectionShowCommand,
    ConnectionSummary, ConnectionTestCommand, ConnectionTestResult, DashboardCreateArguments,
    DashboardCreateCommand, DashboardCreateResult, DashboardKind as ProtocolDashboardKind,
    DashboardRecord, DashboardVisualization, DatabaseEngine, DocumentPage as ProtocolDocumentPage,
    DocumentQuery as ProtocolDocumentQuery, DocumentRunArguments, DocumentRunCommand,
    DocumentRunResult, EmptyArguments, ErrorCode, OperationCancelCommand, OperationShowCommand,
    OperationSummary, OperationWaitArguments, OperationWaitCommand, ProtocolError,
    QueryCancelCommand, QueryHealth, QueryPlanArguments, QueryPlanCommand, QueryPlanResult,
    QueryResultPage, QueryRunArguments, QueryRunCommand, QueryRunResult, RequestEnvelope,
    ResponseEnvelope, SchemaListCommand, SchemaListResult, SchemaSummary, SkillInstallCommand,
    SkillMutationArguments, SkillRemoveCommand, SkillRepairCommand, SkillStatusCommand,
    SkillsGetCommand, SkillsListCommand, SqlProposeArguments, SqlProposeCommand, StatusCommand,
    StatusResult, TableDescribeArguments, TableDescribeCommand, TableDescribeResult,
    VersionCommand, VersionResult, COMMAND_SCHEMA_VERSION, MAX_RESPONSE_BYTES, MAX_STRING_BYTES,
    PROTOCOL_MAX, PROTOCOL_MIN,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::{Emitter, Manager};
use uuid::Uuid;

const MAX_SQL_BYTES: usize = MAX_STRING_BYTES;
const MAX_TABLE_SELECTOR_BYTES: usize = 512;
const MAX_OPERATION_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationActivityEvent {
    request_id: Uuid,
    terminal_session_id: TerminalSessionId,
    connection_id: Option<ConnectionId>,
    command: &'static str,
    state: &'static str,
    error_code: Option<ErrorCode>,
}

#[derive(Clone)]
pub(crate) struct BrokerDispatcher {
    runtime_id: RuntimeId,
    app_version: &'static str,
    sessions: BrokerSessionRegistry,
    services: Option<ApplicationServices>,
    skills: Option<SkillManager>,
    app_handle: Option<tauri::AppHandle>,
}

impl BrokerDispatcher {
    pub(crate) fn new(
        runtime_id: RuntimeId,
        app_version: &'static str,
        sessions: BrokerSessionRegistry,
        services: Option<ApplicationServices>,
        skills: Option<SkillManager>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Self {
        Self {
            runtime_id,
            app_version,
            sessions,
            services,
            skills,
            app_handle,
        }
    }

    pub(crate) async fn dispatch(&self, request: RequestEnvelope) -> ResponseEnvelope {
        let requested_protocol = request.protocol_version;
        let activity = request.authentication.as_ref().and_then(|authentication| {
            self.sessions
                .authenticate(authentication)
                .ok()
                .map(|session| {
                    (
                        request.request_id,
                        session.terminal_session_id,
                        session.connection_id,
                        request.command,
                    )
                })
        });
        let response_protocol = if (PROTOCOL_MIN..=PROTOCOL_MAX).contains(&requested_protocol) {
            requested_protocol
        } else {
            PROTOCOL_MAX
        };
        let response = self.dispatch_current(request).await;
        let response = response_at_protocol(response, response_protocol);
        if let Some((request_id, terminal_session_id, connection_id, command)) = activity {
            self.emit_operation_activity(
                request_id,
                terminal_session_id,
                connection_id,
                command,
                &response,
            );
        }
        response
    }

    fn emit_operation_activity(
        &self,
        request_id: Uuid,
        terminal_session_id: TerminalSessionId,
        connection_id: ConnectionId,
        command: CommandName,
        response: &ResponseEnvelope,
    ) {
        let Some(app) = &self.app_handle else {
            return;
        };
        let payload = OperationActivityEvent {
            request_id,
            terminal_session_id,
            connection_id: Some(connection_id),
            command: command.as_str(),
            state: if response.is_ok() {
                "completed"
            } else {
                "failed"
            },
            error_code: response.error().map(ProtocolError::code),
        };
        if let Err(error) = app.emit("operation:changed", payload) {
            tracing::warn!(%error, "failed to emit broker operation activity");
        }
    }

    async fn dispatch_current(&self, request: RequestEnvelope) -> ResponseEnvelope {
        let request_id = request.request_id;
        if request.protocol_version < PROTOCOL_MIN
            || request.protocol_version > PROTOCOL_MAX
            || request.command_schema_version != COMMAND_SCHEMA_VERSION
        {
            return failure(request_id, ErrorCode::ProtocolMismatch, false);
        }

        match request.command {
            CommandName::Version
            | CommandName::Status
            | CommandName::AppOpen
            | CommandName::SkillsList
            | CommandName::SkillsGet
            | CommandName::SkillStatus
            | CommandName::SkillInstall
            | CommandName::SkillRepair
            | CommandName::SkillRemove => public_skill::handle(self, &request).await,
            CommandName::ConnectionList
            | CommandName::ConnectionShow
            | CommandName::ConnectionTest
            | CommandName::CatalogShow
            | CommandName::SchemaList
            | CommandName::TableDescribe => connection_catalog::handle(self, &request).await,
            CommandName::DocumentRun
            | CommandName::QueryPlan
            | CommandName::QueryRun
            | CommandName::QueryCancel => query_document::handle(self, &request).await,
            CommandName::DashboardCreate
            | CommandName::SqlPropose
            | CommandName::OperationShow
            | CommandName::OperationWait
            | CommandName::OperationCancel => dashboard_operation::handle(self, &request).await,
            CommandName::Unknown => failure(request_id, ErrorCode::InvalidRequest, false),
        }
    }

    pub(super) fn authenticate(
        &self,
        request: &RequestEnvelope,
        capability: BrokerCapability,
    ) -> Result<AuthenticatedSession, ErrorCode> {
        let authentication = request
            .authentication
            .as_ref()
            .ok_or(ErrorCode::AuthenticationDenied)?;
        let session = self
            .sessions
            .authenticate(authentication)
            .map_err(|_| ErrorCode::AuthenticationDenied)?;
        session
            .require(capability)
            .map_err(|_| ErrorCode::ScopeDenied)?;
        Ok(session)
    }

    pub(super) fn services(&self) -> Result<&ApplicationServices, ErrorCode> {
        self.services.as_ref().ok_or(ErrorCode::Internal)
    }
}
