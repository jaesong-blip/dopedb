//! Connection and catalog broker handlers.
use super::*;

pub(super) async fn handle(
    dispatcher: &BrokerDispatcher,
    request: &RequestEnvelope,
) -> ResponseEnvelope {
    let request_id = request.request_id;
    let client_protocol_version = request.protocol_version;
    let capability = match request.command {
        CommandName::ConnectionList | CommandName::ConnectionShow => {
            BrokerCapability::ConnectionRead
        }
        CommandName::ConnectionTest => BrokerCapability::ConnectionTest,
        CommandName::DatabaseList
        | CommandName::CatalogShow
        | CommandName::SchemaList
        | CommandName::TableDescribe => BrokerCapability::CatalogRead,
        _ => return failure(request_id, ErrorCode::InvalidRequest, false),
    };
    let session = match dispatcher.authenticate(request, capability) {
        Ok(session) => session,
        Err(code) => return failure(request_id, code, false),
    };
    match request.command {
        CommandName::ConnectionList => {
            if decode_arguments::<ConnectionListCommand>(request).is_err() {
                return failure(request_id, ErrorCode::InvalidRequest, false);
            }
            respond(
                request_id,
                dispatcher
                    .connection_list(&session, client_protocol_version)
                    .await,
            )
        }
        CommandName::ConnectionShow => {
            let arguments = match decode_arguments::<ConnectionShowCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .resolve_connection(&session, &arguments.connection, client_protocol_version)
                    .await,
            )
        }
        CommandName::ConnectionTest => {
            let arguments = match decode_arguments::<ConnectionTestCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .connection_test(&session, &arguments, client_protocol_version)
                    .await,
            )
        }
        CommandName::DatabaseList => {
            let arguments = match decode_arguments::<DatabaseListCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .database_list(&session, &arguments.connection, client_protocol_version)
                    .await,
            )
        }
        CommandName::CatalogShow => {
            let arguments = match decode_arguments::<CatalogShowCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .catalog(&session, &arguments, client_protocol_version)
                    .await,
            )
        }
        CommandName::SchemaList => {
            let arguments = match decode_arguments::<SchemaListCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .schema_list(&session, &arguments, client_protocol_version)
                    .await,
            )
        }
        CommandName::TableDescribe => {
            let arguments = match decode_arguments::<TableDescribeCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                dispatcher
                    .table_describe(&session, &arguments, client_protocol_version)
                    .await,
            )
        }
        _ => unreachable!(),
    }
}

impl BrokerDispatcher {
    async fn connection_list(
        &self,
        session: &AuthenticatedSession,
        client_protocol_version: u16,
    ) -> Result<ConnectionListResult, ErrorCode> {
        let services = self.services()?;
        let authority = terminal_authority(session, client_protocol_version);
        let connections = services
            .connections
            .list_terminal_summaries(&authority)
            .await
            .map_err(|_| ErrorCode::ScopeDenied)?
            .iter()
            .map(connection_summary)
            .collect();
        Ok(ConnectionListResult { connections })
    }

    pub(super) async fn resolve_connection(
        &self,
        session: &AuthenticatedSession,
        selector: &ConnectionSelector,
        client_protocol_version: u16,
    ) -> Result<ConnectionSummary, ErrorCode> {
        let services = self.services()?;
        let authority = terminal_authority(session, client_protocol_version);
        let current = services
            .connections
            .terminal_summary(&authority)
            .await
            .map_err(|_| ErrorCode::ScopeDenied)?;
        match selector {
            ConnectionSelector::Current => Ok(connection_summary(&current)),
            ConnectionSelector::Id(id) => {
                if *id == Uuid::from(current.id) {
                    Ok(connection_summary(&current))
                } else {
                    Err(ErrorCode::ScopeDenied)
                }
            }
            ConnectionSelector::Name(name) => {
                let resolved = services
                    .connections
                    .resolve_terminal_cli(&authority, name)
                    .await
                    .map_err(map_application_error)?;
                match resolved {
                    Ok(resolved) if resolved.id == current.id => Ok(connection_summary(&resolved)),
                    Ok(_) => Err(ErrorCode::ScopeDenied),
                    Err(CliConnectionResolutionError::NoMatch)
                    | Err(CliConnectionResolutionError::Ambiguous { .. }) => {
                        Err(ErrorCode::InvalidRequest)
                    }
                }
            }
        }
    }

    async fn connection_test(
        &self,
        session: &AuthenticatedSession,
        arguments: &ConnectionSelectorArguments,
        client_protocol_version: u16,
    ) -> Result<ConnectionTestResult, ErrorCode> {
        let connection = self
            .resolve_connection(session, &arguments.connection, client_protocol_version)
            .await?;
        let services = self.services()?;
        services
            .connections
            .test_terminal(&terminal_authority(session, client_protocol_version))
            .await
            .map_err(map_target_error)?;
        Ok(ConnectionTestResult {
            connection,
            reachable: true,
        })
    }

    async fn catalog(
        &self,
        session: &AuthenticatedSession,
        arguments: &CatalogArguments,
        client_protocol_version: u16,
    ) -> Result<CatalogSnapshot, ErrorCode> {
        self.resolve_connection(session, &arguments.connection, client_protocol_version)
            .await?;
        let authority = terminal_authority(session, client_protocol_version);
        if let Some(database) = &arguments.database {
            self.services()?
                .catalog
                .load_terminal_database_snapshot(&authority, database.clone())
                .await
                .map_err(map_application_error)
        } else {
            self.services()?
                .catalog
                .load_terminal_snapshot(&authority, CatalogReadPolicy::CacheFirst)
                .await
                .map_err(map_application_error)
        }
    }

    async fn database_list(
        &self,
        session: &AuthenticatedSession,
        connection_selector: &ConnectionSelector,
        client_protocol_version: u16,
    ) -> Result<DatabaseListResult, ErrorCode> {
        let connection = self
            .resolve_connection(session, connection_selector, client_protocol_version)
            .await?;
        let databases = self
            .services()?
            .catalog
            .list_terminal_databases(&terminal_authority(session, client_protocol_version))
            .await
            .map_err(map_application_error)?
            .into_iter()
            .map(|database| ProtocolDatabaseSummary {
                name: database.name,
                is_default: database.is_default,
            })
            .collect();
        Ok(DatabaseListResult {
            connection_id: connection.id,
            databases,
        })
    }

    async fn schema_list(
        &self,
        session: &AuthenticatedSession,
        arguments: &CatalogArguments,
        client_protocol_version: u16,
    ) -> Result<SchemaListResult, ErrorCode> {
        let catalog = self
            .catalog(session, arguments, client_protocol_version)
            .await?;
        let mut counts = BTreeMap::<String, [u64; 3]>::new();
        for namespace in catalog.namespaces() {
            counts.entry(namespace.name.clone()).or_default();
        }
        for relation in catalog.relations() {
            counts
                .entry(namespace_name(&relation.object.namespace))
                .or_default()[0] += 1;
        }
        for routine in catalog.routines() {
            counts
                .entry(namespace_name(&routine.object.namespace))
                .or_default()[1] += 1;
        }
        for object in catalog.other_objects() {
            counts
                .entry(namespace_name(&object.object.namespace))
                .or_default()[2] += 1;
        }
        Ok(SchemaListResult {
            connection_id: catalog.connection_id(),
            database: catalog.database().to_owned(),
            schemas: counts
                .into_iter()
                .map(|(name, counts)| SchemaSummary {
                    name,
                    relation_count: counts[0],
                    routine_count: counts[1],
                    object_count: counts[2],
                })
                .collect(),
        })
    }

    async fn table_describe(
        &self,
        session: &AuthenticatedSession,
        arguments: &TableDescribeArguments,
        client_protocol_version: u16,
    ) -> Result<TableDescribeResult, ErrorCode> {
        if arguments.table.is_empty()
            || arguments.table.len() > MAX_TABLE_SELECTOR_BYTES
            || arguments.table.chars().any(char::is_control)
        {
            return Err(ErrorCode::InvalidRequest);
        }
        let catalog = self
            .catalog(
                session,
                &CatalogArguments {
                    connection: arguments.connection.clone(),
                    database: arguments.database.clone(),
                },
                client_protocol_version,
            )
            .await?;
        let relation = if let Some((namespace, name)) = arguments.table.rsplit_once('.') {
            catalog
                .relations()
                .iter()
                .find(|relation| {
                    relation.object.namespace.as_deref() == Some(namespace)
                        && relation.object.name == name
                })
                .cloned()
                .ok_or(ErrorCode::InvalidRequest)?
        } else {
            let matches = catalog
                .relations()
                .iter()
                .filter(|relation| relation.object.name == arguments.table)
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [relation] => (*relation).clone(),
                _ => return Err(ErrorCode::InvalidRequest),
            }
        };
        Ok(TableDescribeResult {
            connection_id: catalog.connection_id(),
            database: catalog.database().to_owned(),
            relation,
        })
    }
}
