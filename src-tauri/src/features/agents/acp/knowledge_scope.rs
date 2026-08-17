//! Exact Project Knowledge resolution port for connection-pinned ACP sessions.

use std::collections::{BTreeSet, HashSet};
use std::future::Future;
use std::pin::Pin;

use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::knowledge::{domain::KnowledgeSessionScope, KnowledgeFeature};
use crate::kernel::access::PinnedConnection;

use super::super::domain::AcpSessionSummary;

type KnowledgeScopeFuture<'a, T> = Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'a>>;

pub(super) trait AcpKnowledgeScopePort: Send + Sync {
    fn resolve<'a>(
        &'a self,
        connection: &'a PinnedConnection,
        environment_id: Option<Uuid>,
    ) -> KnowledgeScopeFuture<'a, Option<KnowledgeSessionScope>>;

    fn verify<'a>(
        &'a self,
        scope: &'a KnowledgeSessionScope,
        workspace_id: Uuid,
        account_id: &'a str,
    ) -> KnowledgeScopeFuture<'a, ()>;
}

pub(super) struct FeatureKnowledgeScopePort {
    knowledge: KnowledgeFeature,
}

impl FeatureKnowledgeScopePort {
    pub(super) fn new(knowledge: KnowledgeFeature) -> Self {
        Self { knowledge }
    }
}

impl AcpKnowledgeScopePort for FeatureKnowledgeScopePort {
    fn resolve<'a>(
        &'a self,
        connection: &'a PinnedConnection,
        environment_id: Option<Uuid>,
    ) -> KnowledgeScopeFuture<'a, Option<KnowledgeSessionScope>> {
        Box::pin(async move {
            self.knowledge
                .knowledge_session_scope(connection, environment_id)
                .await
        })
    }

    fn verify<'a>(
        &'a self,
        scope: &'a KnowledgeSessionScope,
        workspace_id: Uuid,
        account_id: &'a str,
    ) -> KnowledgeScopeFuture<'a, ()> {
        Box::pin(async move {
            self.knowledge
                .exact_knowledge_session_graphs(scope, workspace_id, account_id)
                .await
                .map(|_| ())
        })
    }
}

pub(super) fn summary_scope(
    summary: &AcpSessionSummary,
) -> AppResult<Option<KnowledgeSessionScope>> {
    match (
        summary.knowledge_grant_id,
        summary.project_environment_id,
        summary.environment_revision,
        summary.knowledge_sources.is_empty(),
        summary.graph_revision_ids.is_empty(),
    ) {
        (None, None, None, true, true) => Ok(None),
        (
            knowledge_grant_id,
            Some(project_environment_id),
            Some(environment_revision),
            _,
            graph_ids_empty,
        ) if environment_revision > 0
            && !summary.environment_connections.is_empty()
            && summary.knowledge_sources.len() <= 100
            && summary
                .knowledge_sources
                .iter()
                .all(crate::features::knowledge::domain::KnowledgeSessionSource::validate)
            && summary
                .knowledge_sources
                .iter()
                .map(|source| source.source_id)
                .collect::<BTreeSet<_>>()
                .len()
                == summary.knowledge_sources.len()
            && ((graph_ids_empty && knowledge_grant_id.is_none())
                || (!graph_ids_empty && knowledge_grant_id.is_some()))
            && summary.graph_revision_ids.len() <= 100
            && summary
                .graph_revision_ids
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                == summary.graph_revision_ids.len() =>
        {
            Ok(Some(KnowledgeSessionScope {
                knowledge_grant_id,
                project_environment_id,
                environment_revision,
                sources: summary.knowledge_sources.clone(),
                graph_revision_ids: summary.graph_revision_ids.clone(),
                connections: summary.environment_connections.clone(),
            }))
        }
        _ => Err(AppError::Blocked {
            reason: "the persisted Agent Knowledge scope is incomplete".into(),
        }),
    }
}

pub(crate) fn narrow_knowledge_scope(
    scope: &mut Option<KnowledgeSessionScope>,
    current_connection_id: Uuid,
    requested_connection_ids: Option<Vec<Uuid>>,
) -> AppResult<()> {
    let Some(requested_connection_ids) = requested_connection_ids else {
        return Ok(());
    };
    let requested = requested_connection_ids
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    if requested.is_empty()
        || requested.len() != requested_connection_ids.len()
        || requested.len() > 32
        || !requested.contains(&current_connection_id)
    {
        return Err(AppError::Blocked {
            reason: "the selected Agent database subset is invalid".into(),
        });
    }
    let scope = scope.as_mut().ok_or_else(|| AppError::Blocked {
        reason: "a database subset requires one selected Project Environment".into(),
    })?;
    if requested.iter().any(|connection_id| {
        !scope
            .connections
            .iter()
            .any(|connection| connection.connection_id == *connection_id)
    }) {
        return Err(AppError::Blocked {
            reason: "the selected database is outside this member's exact Environment grant".into(),
        });
    }
    scope
        .connections
        .retain(|connection| requested.contains(&connection.connection_id));
    Ok(())
}
