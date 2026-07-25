//! SQL document use cases.
//!
//! Every transport calls this one API. It validates commands, obtains one scope-pinned
//! authority guard, and asks the repository port to perform the durable change.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, SqlDocumentId};

use super::domain::{content_hash, normalize_title, validate_content, SqlDocument};
use super::ports::{
    SaveDocumentCommand, SaveRepositoryOutcome, SqlDocumentAuthorityGuard,
    SqlDocumentAuthorityPort, SqlDocumentGeneratorPort, SqlDocumentRepositoryPort,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateSqlDocumentRequest {
    pub(crate) connection_id: ConnectionId,
    pub(crate) title: Option<String>,
    pub(crate) content: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveSqlDocumentRequest {
    pub(crate) id: SqlDocumentId,
    pub(crate) connection_id: ConnectionId,
    pub(crate) title: String,
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

    pub(crate) async fn create(&self, request: CreateSqlDocumentRequest) -> AppResult<SqlDocument> {
        let title = normalize_title(request.title.as_deref().unwrap_or("Untitled query"))?;
        let content = request.content.unwrap_or_else(|| "SELECT 1;".into());
        validate_content(&content)?;

        let guard = self.authority.authorize(request.connection_id).await?;
        let document = SqlDocument::create(
            self.generator.next_id(),
            request.connection_id,
            guard.authority().dialect,
            title,
            content,
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
        validate_content(&request.content)?;
        let attempted_content_hash = content_hash(&request.content);
        let expected_revision = request.expected_revision;
        let guard = self.authority.authorize(request.connection_id).await?;
        let outcome = self
            .repository
            .save(
                guard.authority(),
                SaveDocumentCommand {
                    id: request.id,
                    title,
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use uuid::Uuid;

    use crate::kernel::identity::{AccountScopeId, WorkspaceConnectionId, WorkspaceId};

    use super::super::domain::SqlDialect;
    use super::super::ports::{SqlDocumentAuthority, SqlDocumentAuthorityGuard};
    use super::*;

    #[derive(Clone)]
    struct FakeAuthority {
        authority: SqlDocumentAuthority,
        calls: Arc<AtomicUsize>,
    }

    struct FakeGuard {
        authority: SqlDocumentAuthority,
    }

    impl SqlDocumentAuthorityGuard for FakeGuard {
        fn authority(&self) -> &SqlDocumentAuthority {
            &self.authority
        }
    }

    impl SqlDocumentAuthorityPort for FakeAuthority {
        type Guard = FakeGuard;

        async fn authorize(&self, connection_id: ConnectionId) -> AppResult<Self::Guard> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(self.authority.resource.connection_id, connection_id);
            Ok(FakeGuard {
                authority: self.authority.clone(),
            })
        }
    }

    #[derive(Default)]
    struct FakeRepositoryState {
        documents: Vec<SqlDocument>,
        save_outcome: Option<SaveRepositoryOutcome>,
        delete_result: bool,
    }

    #[derive(Clone, Default)]
    struct FakeRepository {
        state: Arc<Mutex<FakeRepositoryState>>,
    }

    impl SqlDocumentRepositoryPort for FakeRepository {
        async fn list(&self, _authority: &SqlDocumentAuthority) -> AppResult<Vec<SqlDocument>> {
            Ok(self.state.lock().unwrap().documents.clone())
        }

        async fn create(
            &self,
            _authority: &SqlDocumentAuthority,
            document: &SqlDocument,
        ) -> AppResult<()> {
            self.state.lock().unwrap().documents.push(document.clone());
            Ok(())
        }

        async fn save(
            &self,
            _authority: &SqlDocumentAuthority,
            _command: SaveDocumentCommand,
        ) -> AppResult<SaveRepositoryOutcome> {
            Ok(self
                .state
                .lock()
                .unwrap()
                .save_outcome
                .clone()
                .expect("test must configure a save outcome"))
        }

        async fn delete(
            &self,
            _authority: &SqlDocumentAuthority,
            _id: SqlDocumentId,
            _expected_revision: i64,
            _deleted_at: String,
        ) -> AppResult<bool> {
            Ok(self.state.lock().unwrap().delete_result)
        }
    }

    #[derive(Clone, Copy)]
    struct FixedGenerator {
        id: SqlDocumentId,
    }

    impl SqlDocumentGeneratorPort for FixedGenerator {
        fn next_id(&self) -> SqlDocumentId {
            self.id
        }

        fn now(&self) -> String {
            "2026-07-25T00:00:00Z".into()
        }
    }

    fn harness() -> (
        SqlDocumentUseCases<FakeRepository, FakeAuthority, FixedGenerator>,
        FakeRepository,
        Arc<AtomicUsize>,
        ConnectionId,
        SqlDocumentId,
    ) {
        let connection_id = ConnectionId::from(Uuid::new_v4());
        let document_id = SqlDocumentId::from(Uuid::new_v4());
        let calls = Arc::new(AtomicUsize::new(0));
        let authority = FakeAuthority {
            authority: SqlDocumentAuthority {
                resource: WorkspaceConnectionId {
                    workspace_id: WorkspaceId::from(Uuid::new_v4()),
                    connection_id,
                },
                account_scope: AccountScopeId::new("personal").unwrap(),
                dialect: SqlDialect::PostgreSql,
            },
            calls: Arc::clone(&calls),
        };
        let repository = FakeRepository::default();
        (
            SqlDocumentUseCases::new(
                repository.clone(),
                authority,
                FixedGenerator { id: document_id },
            ),
            repository,
            calls,
            connection_id,
            document_id,
        )
    }

    #[tokio::test]
    async fn create_validates_then_writes_through_one_authorized_use_case() {
        let (use_cases, repository, calls, connection_id, document_id) = harness();
        let document = use_cases
            .create(CreateSqlDocumentRequest {
                connection_id,
                title: Some("  Daily report  ".into()),
                content: Some("SELECT 1;".into()),
            })
            .await
            .unwrap();

        assert_eq!(document.id, document_id);
        assert_eq!(document.title, "Daily report");
        assert_eq!(document.dialect, "postgresql");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(repository.state.lock().unwrap().documents, [document]);
    }

    #[tokio::test]
    async fn invalid_create_never_reaches_authority_or_repository() {
        let (use_cases, repository, calls, connection_id, _) = harness();
        let error = use_cases
            .create(CreateSqlDocumentRequest {
                connection_id,
                title: Some(" ".into()),
                content: None,
            })
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::Config(_)));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(repository.state.lock().unwrap().documents.is_empty());
    }

    #[tokio::test]
    async fn optimistic_conflict_returns_the_current_document_and_attempt_hash() {
        let (use_cases, repository, _, connection_id, document_id) = harness();
        let current = SqlDocument::create(
            document_id,
            connection_id,
            SqlDialect::PostgreSql,
            "Remote".into(),
            "SELECT 2;".into(),
            "2026-07-25T00:00:00Z".into(),
        );
        repository.state.lock().unwrap().save_outcome =
            Some(SaveRepositoryOutcome::Conflict(current.clone()));

        let outcome = use_cases
            .save(SaveSqlDocumentRequest {
                id: document_id,
                connection_id,
                title: "Local".into(),
                content: "SELECT 3;".into(),
                expected_revision: 1,
            })
            .await
            .unwrap();

        assert!(!outcome.saved);
        assert_eq!(outcome.document, current);
        assert_eq!(outcome.expected_revision, 1);
        assert_eq!(outcome.attempted_content_hash, content_hash("SELECT 3;"));
    }

    #[tokio::test]
    async fn stale_delete_is_blocked_in_the_application_layer() {
        let (use_cases, _, _, connection_id, document_id) = harness();
        let error = use_cases
            .delete(connection_id, document_id, 1)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::Blocked { .. }));
    }
}
