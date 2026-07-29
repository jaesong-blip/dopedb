//! Query and document-read broker handlers.
use super::*;

pub(super) async fn handle(
    dispatcher: &BrokerDispatcher,
    request: &RequestEnvelope,
) -> ResponseEnvelope {
    let request_id = request.request_id;
    let client_protocol_version = request.protocol_version;
    let capability = match request.command {
        CommandName::DocumentRun => BrokerCapability::DocumentRead,
        CommandName::QueryPlan => BrokerCapability::QueryPlan,
        CommandName::QueryRun => BrokerCapability::QueryRun,
        CommandName::QueryCancel => BrokerCapability::OperationCancel,
        _ => return failure(request_id, ErrorCode::InvalidRequest, false),
    };
    let session = match dispatcher.authenticate(request, capability) {
        Ok(session) => session,
        Err(code) => return failure(request_id, code, false),
    };
    match request.command {
        CommandName::DocumentRun => {
            let arguments = match decode_arguments::<DocumentRunCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .document_run(&session, arguments, client_protocol_version)
                    .await,
            )
        }
        CommandName::QueryPlan => {
            let arguments = match decode_arguments::<QueryPlanCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .query_plan(&session, arguments, client_protocol_version)
                    .await,
            )
        }
        CommandName::QueryRun => {
            let arguments = match decode_arguments::<QueryRunCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .query_run(&session, arguments, client_protocol_version)
                    .await,
            )
        }
        CommandName::QueryCancel => {
            let arguments = match decode_arguments::<QueryCancelCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .cancel_operation(&session, arguments.operation_id, client_protocol_version)
                    .await,
            )
        }
        _ => unreachable!(),
    }
}

impl BrokerDispatcher {
    async fn document_run(
        &self,
        session: &AuthenticatedSession,
        arguments: DocumentRunArguments,
        client_protocol_version: u16,
    ) -> Result<DocumentRunResult, ErrorCode> {
        if arguments.max_rows == Some(0) {
            return Err(ErrorCode::InvalidRequest);
        }
        let connection = self
            .resolve_connection(session, &arguments.connection, client_protocol_version)
            .await?;
        let receipt = self
            .services()?
            .document
            .run_terminal_read(TerminalDocumentReadRequest {
                connection_id: connection.id,
                query: document_query_from_protocol(arguments.query),
                max_rows: arguments.max_rows,
                authority: terminal_authority(session, client_protocol_version),
            })
            .await
            .map_err(map_document_error)?;
        let result = receipt.result();
        Ok(DocumentRunResult {
            operation_id: result.operation_id,
            connection_id: result.context.connection_id,
            connection_name: result.context.connection_name.clone(),
            query: document_query_to_protocol(&result.query),
            result: document_page(&result.page),
        })
    }

    async fn query_plan(
        &self,
        session: &AuthenticatedSession,
        arguments: QueryPlanArguments,
        client_protocol_version: u16,
    ) -> Result<QueryPlanResult, ErrorCode> {
        validate_sql(&arguments.sql)?;
        if arguments.max_rows == Some(0) {
            return Err(ErrorCode::InvalidRequest);
        }
        let connection = self
            .resolve_connection(session, &arguments.connection, client_protocol_version)
            .await?;
        let receipt = self
            .services()?
            .queries
            .plan_terminal_read(TerminalQueryPlanRequest {
                connection_id: connection.id.into(),
                sql: arguments.sql,
                database: arguments.database,
                max_rows: arguments.max_rows,
                authority: terminal_authority(session, client_protocol_version),
            })
            .await;
        let receipt = match receipt {
            Ok(receipt) => receipt,
            Err(AgentQueryPlanError::DocumentConnection) => return Err(ErrorCode::InvalidRequest),
            Err(AgentQueryPlanError::NotSingleRead) => return Err(ErrorCode::PolicyBlocked),
            Err(AgentQueryPlanError::Application(error)) => {
                return Err(map_application_error(error))
            }
        };
        let plan = receipt.plan();
        Ok(QueryPlanResult {
            connection_id: plan.connection_id.into(),
            connection_name: plan.connection_name.clone(),
            database: plan.database.clone(),
            environment: plan.environment.clone(),
            plan_id: plan.plan_id.into(),
            decision: plan.decision.clone(),
            notices: plan.notices.clone(),
            suggestions: plan.suggestions.clone(),
            estimated_rows: plan.estimated_rows,
            health: query_health(&plan.health),
            expires_at: plan.expires_at,
        })
    }

    async fn query_run(
        &self,
        session: &AuthenticatedSession,
        arguments: QueryRunArguments,
        client_protocol_version: u16,
    ) -> Result<QueryRunResult, ErrorCode> {
        let authority = terminal_authority(session, client_protocol_version);
        let prepared = self
            .services()?
            .queries
            .prepare_terminal_run(arguments.plan_id.into(), &authority)
            .await
            .map_err(map_prepare_error)?;
        let receipt = prepared.execute().await.map_err(map_query_run_error)?;
        let run = receipt.run();
        Ok(QueryRunResult {
            connection_id: run.connection_id.into(),
            connection_name: run.connection_name.clone(),
            database: run.database.clone(),
            plan_id: run.plan_id.into(),
            query_run_id: run.query_run_id.into(),
            planning_decision: run.planning_decision.clone(),
            result: query_result(&run.result),
        })
    }
}
