//! ACP-only Analysis Article draft operations. The Agent supplies declarative
//! content; the authenticated session supplies every authority and revision pin.

use dopedb_protocol::{
    AnalysisArticleDraftRunArguments, AnalysisArticleDraftRunCommand, AnalysisArticleListCommand,
    AnalysisArticleListResult, AnalysisArticleProposeArguments, AnalysisArticleProposeCommand,
    AnalysisArticleRecordResult, AnalysisArticleSource, AnalysisArticleState,
    AnalysisArticleUpdateDraftArguments, AnalysisArticleUpdateDraftCommand, AnalysisRefreshMode,
    AnalysisRunReceipt, AnalysisRunState, SharedAnalysisArticleCreate,
};
use tauri::Emitter;

use crate::features::analysis_articles::AnalysisArticleMutation;
use crate::features::analysis_articles::AnalysisDefinitionRunRequest;

use super::*;

pub(super) async fn handle(
    dispatcher: &BrokerDispatcher,
    request: &RequestEnvelope,
) -> ResponseEnvelope {
    let request_id = request.request_id;
    let capability = match request.command {
        CommandName::AnalysisArticleList => BrokerCapability::AnalysisArticleRead,
        CommandName::AnalysisArticlePropose
        | CommandName::AnalysisArticleUpdateDraft
        | CommandName::AnalysisArticleDraftRun => BrokerCapability::AnalysisArticlePropose,
        _ => return failure(request_id, ErrorCode::InvalidRequest, false),
    };
    let session = match dispatcher.authenticate(request, capability) {
        Ok(session) => session,
        Err((code, retryable)) => return failure(request_id, code, retryable),
    };
    let Some(scope) = session.knowledge_scope.as_ref() else {
        return failure(request_id, ErrorCode::ScopeDenied, false);
    };
    let source = match session.agent_plugin_id {
        Some(dopedb_protocol::AcpPluginId::Claude) => AnalysisArticleSource::DopedbAcpClaude,
        Some(dopedb_protocol::AcpPluginId::Codex) => AnalysisArticleSource::DopedbAcpCodex,
        None => return failure(request_id, ErrorCode::ScopeDenied, false),
    };
    if session.account_scope.as_str() == "personal" {
        return failure(request_id, ErrorCode::ScopeDenied, false);
    }
    let services = match dispatcher.services() {
        Ok(services) => services,
        Err(code) => return failure(request_id, code, false),
    };
    if let Err(error) = services
        .knowledge
        .exact_knowledge_session_graphs(
            scope,
            Uuid::from(session.workspace_id),
            session.account_scope.as_str(),
        )
        .await
    {
        return failure(request_id, map_application_error(error), false);
    }

    let result = match request.command {
        CommandName::AnalysisArticleList => {
            if decode_arguments::<AnalysisArticleListCommand>(request).is_err() {
                Err(ErrorCode::InvalidRequest)
            } else {
                services
                    .analysis_article
                    .list_remote(
                        session.account_scope.as_str(),
                        Uuid::from(session.workspace_id),
                        Some(scope.project_environment_id),
                    )
                    .await
                    .map(|articles| serde_json::to_value(AnalysisArticleListResult { articles }))
                    .map_err(map_application_error)
                    .and_then(|value| value.map_err(|_| ErrorCode::Internal))
            }
        }
        CommandName::AnalysisArticlePropose => {
            let arguments = match decode_arguments::<AnalysisArticleProposeCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            propose(dispatcher, &session, source, arguments).await
        }
        CommandName::AnalysisArticleUpdateDraft => {
            let arguments = match decode_arguments::<AnalysisArticleUpdateDraftCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            update_draft(dispatcher, &session, source, arguments).await
        }
        CommandName::AnalysisArticleDraftRun => {
            let arguments = match decode_arguments::<AnalysisArticleDraftRunCommand>(request) {
                Ok(arguments) => arguments,
                Err(_) => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            run_draft(dispatcher, &session, source, arguments).await
        }
        _ => Err(ErrorCode::InvalidRequest),
    };

    respond(request_id, result)
}

fn article_create(
    session: &AuthenticatedSession,
    source: AnalysisArticleSource,
    definition: dopedb_protocol::AnalysisArticleDraftDefinition,
    article_id: Uuid,
) -> Result<SharedAnalysisArticleCreate, ErrorCode> {
    let scope = session
        .knowledge_scope
        .as_ref()
        .ok_or(ErrorCode::ScopeDenied)?;
    let environment_revision =
        i64::try_from(scope.environment_revision).map_err(|_| ErrorCode::InvalidRequest)?;
    let mut definition = definition.with_source(source);
    definition.refresh.mode = AnalysisRefreshMode::Manual;
    definition.refresh.cron = None;
    definition.refresh.runner_id = None;
    definition.refresh.share_reviewed_results = false;
    let query_role = definition
        .queries
        .first()
        .map(|query| query.connection_role.as_str())
        .ok_or(ErrorCode::InvalidRequest)?;
    let scoped_connection = scope
        .connections
        .iter()
        .find(|connection| connection.role == query_role)
        .ok_or(ErrorCode::ScopeDenied)?;
    let remote_connection_id = scoped_connection
        .remote_connection_id
        .ok_or(ErrorCode::ScopeDenied)?;
    let article = SharedAnalysisArticleCreate {
        id: article_id,
        project_environment_id: scope.project_environment_id,
        environment_revision,
        source_knowledge_grant_id: None,
        graph_revision_ids: Vec::new(),
        connections: vec![dopedb_protocol::AnalysisArticleConnection {
            connection_id: remote_connection_id,
            connection_revision: scoped_connection.connection_content_revision,
            role: scoped_connection.role.clone(),
            alias: scoped_connection.alias.clone(),
        }],
        definition,
    };
    article
        .validate()
        .then_some(article)
        .ok_or(ErrorCode::InvalidRequest)
}

async fn propose(
    dispatcher: &BrokerDispatcher,
    session: &AuthenticatedSession,
    source: AnalysisArticleSource,
    arguments: AnalysisArticleProposeArguments,
) -> Result<serde_json::Value, ErrorCode> {
    let article = article_create(session, source, arguments.definition, Uuid::new_v4())?;
    let created = dispatcher
        .services()?
        .analysis_article
        .create_remote(
            session.account_scope.as_str(),
            Uuid::from(session.workspace_id),
            &article,
        )
        .await
        .map_err(map_application_error)?;
    emit_changed(dispatcher, created.id, created.revision, "proposed");
    serde_json::to_value(AnalysisArticleRecordResult { article: created })
        .map_err(|_| ErrorCode::Internal)
}

async fn update_draft(
    dispatcher: &BrokerDispatcher,
    session: &AuthenticatedSession,
    source: AnalysisArticleSource,
    arguments: AnalysisArticleUpdateDraftArguments,
) -> Result<serde_json::Value, ErrorCode> {
    if arguments.expected_revision < 1 {
        return Err(ErrorCode::InvalidRequest);
    }
    let workspace_id = Uuid::from(session.workspace_id);
    let existing = dispatcher
        .services()?
        .analysis_article
        .get_remote(
            session.account_scope.as_str(),
            workspace_id,
            arguments.article_id,
        )
        .await
        .map_err(map_application_error)?;
    let scope = session
        .knowledge_scope
        .as_ref()
        .ok_or(ErrorCode::ScopeDenied)?;
    if existing.state != AnalysisArticleState::Draft
        || existing.revision != arguments.expected_revision
        || existing.project_environment_id != scope.project_environment_id
    {
        return Err(ErrorCode::OperationConflict);
    }
    let article = article_create(session, source, arguments.definition, arguments.article_id)?;
    let updated = dispatcher
        .services()?
        .analysis_article
        .mutate_remote(
            session.account_scope.as_str(),
            workspace_id,
            arguments.article_id,
            arguments.expected_revision,
            AnalysisArticleMutation::Update(Box::new(article)),
        )
        .await
        .map_err(map_application_error)?;
    emit_changed(dispatcher, updated.id, updated.revision, "updated");
    serde_json::to_value(AnalysisArticleRecordResult { article: updated })
        .map_err(|_| ErrorCode::Internal)
}

async fn run_draft(
    dispatcher: &BrokerDispatcher,
    session: &AuthenticatedSession,
    source: AnalysisArticleSource,
    arguments: AnalysisArticleDraftRunArguments,
) -> Result<serde_json::Value, ErrorCode> {
    let article_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let article = article_create(session, source, arguments.definition, article_id)?;
    let receipt = dispatcher
        .services()?
        .analysis_article
        .run_definition(AnalysisDefinitionRunRequest {
            workspace_id: Some(Uuid::from(session.workspace_id)),
            project_environment_id: Some(article.project_environment_id),
            article_id,
            article_revision: 1,
            definition: article.definition,
            connections: article.connections,
            parameter_values: arguments.parameter_values,
            run_id,
            persist_local_result: false,
        })
        .await
        .map_err(map_application_error)?;
    serde_json::to_value(AnalysisRunReceipt {
        id: receipt.run_id,
        article_id: receipt.article_id,
        article_revision: receipt.article_revision,
        state: AnalysisRunState::Succeeded,
        parameter_values: receipt.parameter_values,
        query_receipts: receipt.query_receipts,
        fragments: receipt.fragments,
        result_hash: Some(receipt.result_hash),
        error: None,
        started_at: receipt.started_at,
        finished_at: receipt.finished_at,
    })
    .map_err(|_| ErrorCode::Internal)
}

fn emit_changed(
    dispatcher: &BrokerDispatcher,
    article_id: Uuid,
    revision: i64,
    action: &'static str,
) {
    let Some(app) = &dispatcher.app_handle else {
        return;
    };
    if let Err(error) = app.emit(
        "analysis-article:changed",
        serde_json::json!({
            "articleId": article_id,
            "revision": revision,
            "action": action,
        }),
    ) {
        tracing::warn!(%error, "failed to emit Analysis Article mutation");
    }
}
