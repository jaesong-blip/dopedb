//! SQL document use cases.
//!
//! Every transport calls this one API. It validates commands, obtains one scope-pinned
//! authority guard, and asks the repository port to perform the durable change.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, SqlDocumentId};
use crate::kernel::sql_namespace::normalize_sql_namespace;

use super::domain::{
    content_hash, normalize_resolve_mode, normalize_title, validate_content, NewSqlDocument,
    SqlDocument, SqlDocumentRevision,
};
use super::ports::{
    SaveDocumentCommand, SaveRepositoryOutcome, SqlDocumentAuthorityGuard,
    SqlDocumentAuthorityPort, SqlDocumentGeneratorPort, SqlDocumentRepositoryPort,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateSqlDocumentRequest {
    pub(crate) connection_id: ConnectionId,
    pub(crate) title: Option<String>,
    pub(crate) selected_database: Option<String>,
    pub(crate) selected_schema: Option<String>,
    pub(crate) resolve_mode: Option<String>,
    pub(crate) content: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveSqlDocumentRequest {
    pub(crate) id: SqlDocumentId,
    pub(crate) connection_id: ConnectionId,
    pub(crate) title: String,
    pub(crate) selected_database: String,
    pub(crate) selected_schema: Option<String>,
    pub(crate) resolve_mode: String,
    pub(crate) content: String,
    pub(crate) expected_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveSqlDocumentOutcome {
    pub(crate) saved: bool,
    pub(crate) document: SqlDocument,
    pub(crate) expected_revision: i64,
    pub(crate) attempted_content_hash: String,
}

#[derive(Clone)]
pub(crate) struct SqlDocumentUseCases<R, A, G> {
    repository: R,
    authority: A,
    generator: G,
}

impl<R, A, G> SqlDocumentUseCases<R, A, G>
where
    R: SqlDocumentRepositoryPort,
    A: SqlDocumentAuthorityPort,
    G: SqlDocumentGeneratorPort,
{
    pub(crate) fn new(repository: R, authority: A, generator: G) -> Self {
        Self {
            repository,
            authority,
            generator,
        }
    }

    pub(crate) async fn list(&self, connection_id: ConnectionId) -> AppResult<Vec<SqlDocument>> {
        let guard = self.authority.authorize(connection_id).await?;
        self.repository.list(guard.authority()).await
    }

    pub(crate) async fn list_revisions(
        &self,
        connection_id: ConnectionId,
        id: SqlDocumentId,
    ) -> AppResult<Vec<SqlDocumentRevision>> {
        let guard = self.authority.authorize(connection_id).await?;
        self.repository.list_revisions(guard.authority(), id).await
    }

    pub(crate) async fn create(&self, request: CreateSqlDocumentRequest) -> AppResult<SqlDocument> {
        let title = normalize_title(request.title.as_deref().unwrap_or("Untitled query"))?;
        let resolve_mode = normalize_resolve_mode(request.resolve_mode)?;
        let content = request.content.unwrap_or_else(|| "SELECT 1;".into());
        validate_content(&content)?;

        let guard = self.authority.authorize(request.connection_id).await?;
        let selected_database =
            normalize_database(request.selected_database, &guard.authority().database)?;
        let selected_schema = normalize_sql_namespace(request.selected_schema)?;
        let document = SqlDocument::create(
            self.generator.next_id(),
            NewSqlDocument {
                connection_id: request.connection_id,
                dialect: guard.authority().dialect,
                title,
                selected_database,
                selected_schema,
                resolve_mode,
                content,
            },
            self.generator.now(),
        );
        self.repository.create(guard.authority(), &document).await?;
        Ok(document)
    }

    pub(crate) async fn save(
        &self,
        request: SaveSqlDocumentRequest,
    ) -> AppResult<SaveSqlDocumentOutcome> {
        if request.expected_revision < 1 {
            return Err(AppError::Config(
                "SQL document expected revision must be positive".into(),
            ));
        }
        let title = normalize_title(&request.title)?;
        let selected_schema = normalize_sql_namespace(request.selected_schema)?;
        let resolve_mode = normalize_resolve_mode(Some(request.resolve_mode))?;
        validate_content(&request.content)?;
        let attempted_content_hash = content_hash(&request.content);
        let expected_revision = request.expected_revision;
        let guard = self.authority.authorize(request.connection_id).await?;
        let selected_database =
            normalize_database(Some(request.selected_database), &guard.authority().database)?;
        let outcome = self
            .repository
            .save(
                guard.authority(),
                SaveDocumentCommand {
                    id: request.id,
                    title,
                    selected_database,
                    selected_schema,
                    resolve_mode,
                    content: request.content,
                    expected_revision,
                    updated_at: self.generator.now(),
                },
            )
            .await?;
        let (saved, document) = match outcome {
            SaveRepositoryOutcome::Saved(document) => (true, document),
            SaveRepositoryOutcome::Conflict(document) => (false, document),
        };
        Ok(SaveSqlDocumentOutcome {
            saved,
            document,
            expected_revision,
            attempted_content_hash,
        })
    }

    pub(crate) async fn delete(
        &self,
        connection_id: ConnectionId,
        id: SqlDocumentId,
        expected_revision: i64,
    ) -> AppResult<()> {
        if expected_revision < 1 {
            return Err(AppError::Config(
                "SQL document expected revision must be positive".into(),
            ));
        }
        let guard = self.authority.authorize(connection_id).await?;
        let deleted = self
            .repository
            .delete(
                guard.authority(),
                id,
                expected_revision,
                self.generator.now(),
            )
            .await?;
        if !deleted {
            return Err(AppError::Blocked {
                reason: "SQL document changed before it could be closed; reload it first".into(),
            });
        }
        Ok(())
    }
}

fn normalize_database(value: Option<String>, fallback: &str) -> AppResult<String> {
    let database = value.unwrap_or_else(|| fallback.to_owned());
    if database.is_empty() || database.len() > 255 || database.chars().any(char::is_control) {
        return Err(AppError::Config(
            "SQL document target database is empty or invalid".into(),
        ));
    }
    Ok(database)
}
