//! Dashboard and operation broker handlers.
use super::*;

pub(super) async fn handle(
    dispatcher: &BrokerDispatcher,
    request: &RequestEnvelope,
) -> ResponseEnvelope {
    let request_id = request.request_id;
    let client_protocol_version = request.protocol_version;
    let capability = match request.command {
        CommandName::DashboardCreate => BrokerCapability::DashboardCreate,
        CommandName::SqlPropose => BrokerCapability::SqlPropose,
        CommandName::OperationShow | CommandName::OperationWait => BrokerCapability::OperationRead,
        CommandName::OperationCancel => BrokerCapability::OperationCancel,
        _ => return failure(request_id, ErrorCode::InvalidRequest, false),
    };
    let session = match dispatcher.authenticate(request, capability) {
        Ok(session) => session,
        Err(code) => return failure(request_id, code, false),
    };
    match request.command {
        CommandName::DashboardCreate => {
            let arguments = match decode_arguments::<DashboardCreateCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .dashboard_create(&session, arguments, client_protocol_version)
                    .await,
            )
        }
        CommandName::SqlPropose => {
            let arguments = match decode_arguments::<SqlProposeCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .sql_propose(&session, arguments, client_protocol_version)
                    .await,
            )
        }
        CommandName::OperationShow => {
            let arguments = match decode_arguments::<OperationShowCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .show_operation(&session, arguments.operation_id, client_protocol_version)
                    .await,
            )
        }
        CommandName::OperationWait => {
            let arguments = match decode_arguments::<OperationWaitCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .wait_operation(&session, arguments, client_protocol_version)
                    .await,
            )
        }
        CommandName::OperationCancel => {
            let arguments = match decode_arguments::<OperationCancelCommand>(request) {
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
    async fn dashboard_create(
        &self,
        session: &AuthenticatedSession,
        arguments: DashboardCreateArguments,
        client_protocol_version: u16,
    ) -> Result<DashboardCreateResult, ErrorCode> {
        let authority = terminal_authority(session, client_protocol_version);
        let dashboard = self
            .services()?
            .dashboard
            .create_terminal(
                &authority,
                QueryRunId::from(arguments.query_run_id),
                AgentDashboardPresentation {
                    title: arguments.title,
                    description: arguments.description,
                    kind: dashboard_kind_from_protocol(arguments.kind),
                    x_column: arguments.x_column,
                    y_columns: arguments.y_columns,
                },
            )
            .await
            .map_err(map_dashboard_create_error)?;
        if let Some(app) = &self.app_handle {
            if let Err(error) = app.emit("dashboard:created", &dashboard) {
                tracing::warn!(%error, "failed to emit dashboard creation");
            }
        }
        Ok(DashboardCreateResult {
            query_run_id: arguments.query_run_id,
            dashboard: dashboard_record(&dashboard),
        })
    }

    async fn sql_propose(
        &self,
        session: &AuthenticatedSession,
        arguments: SqlProposeArguments,
        client_protocol_version: u16,
    ) -> Result<OperationSummary, ErrorCode> {
        validate_sql(&arguments.sql)?;
        let connection = self
            .resolve_connection(session, &arguments.connection, client_protocol_version)
            .await?;
        let authority = terminal_authority(session, client_protocol_version);
        let receipt = self
            .services()?
            .queries
            .propose_terminal_sql(TerminalSqlProposalRequest {
                connection_id: connection.id.into(),
                sql: arguments.sql,
                database: arguments.database,
                authority: authority.clone(),
            })
            .await
            .map_err(|error| map_application_error(error.into_error()))?;
        self.services()?
            .operation
            .show_terminal(&authority, receipt.operation_id.into())
            .await
            .map_err(map_operation_error)
    }

    async fn show_operation(
        &self,
        session: &AuthenticatedSession,
        operation_id: Uuid,
        client_protocol_version: u16,
    ) -> Result<OperationSummary, ErrorCode> {
        self.services()?
            .operation
            .show_terminal(
                &terminal_authority(session, client_protocol_version),
                operation_id,
            )
            .await
            .map_err(map_operation_error)
    }

    async fn wait_operation(
        &self,
        session: &AuthenticatedSession,
        arguments: OperationWaitArguments,
        client_protocol_version: u16,
    ) -> Result<OperationSummary, ErrorCode> {
        let timeout = Duration::from_millis(arguments.timeout_ms);
        if timeout.is_zero() || timeout > MAX_OPERATION_WAIT {
            return Err(ErrorCode::InvalidRequest);
        }
        self.services()?
            .operation
            .wait_terminal(
                &terminal_authority(session, client_protocol_version),
                arguments.operation_id,
                timeout,
            )
            .await
            .map_err(|error| {
                if matches!(error, AppError::Safety(_)) {
                    ErrorCode::Timeout
                } else {
                    map_operation_error(error)
                }
            })
    }

    pub(super) async fn cancel_operation(
        &self,
        session: &AuthenticatedSession,
        operation_id: Uuid,
        client_protocol_version: u16,
    ) -> Result<OperationSummary, ErrorCode> {
        self.services()?
            .operation
            .cancel_terminal(
                &terminal_authority(session, client_protocol_version),
                operation_id,
            )
            .await
            .map_err(map_operation_error)
    }
}
