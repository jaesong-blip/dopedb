//! Persistent SQL workbench documents with optimistic autosave and revision recovery.
//!
//! Documents are local execution artifacts scoped to the exact workspace/account and
//! connection pin. The service never accepts scope identifiers from the renderer.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::connection::{ConnectionAccess, ConnectionManager};
use crate::error::{AppError, AppResult};
use crate::model::Engine;
#[cfg(test)]
use crate::store::AccountScope;
use crate::store::{PinnedConnection, Store};

const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 160;
const REVISION_RETENTION: i64 = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SqlDocument {
    pub(crate) id: Uuid,
    pub(crate) connection_id: Uuid,
    pub(crate) title: String,
    pub(crate) dialect: String,
    pub(crate) content: String,
    pub(crate) local_revision: i64,
    pub(crate) remote_id: Option<String>,
    pub(crate) remote_revision: Option<i64>,
    pub(crate) dirty: bool,
    pub(crate) sync_status: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateSqlDocumentRequest {
    pub(crate) connection_id: Uuid,
    pub(crate) title: Option<String>,
    pub(crate) content: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveSqlDocumentRequest {
    pub(crate) id: Uuid,
    pub(crate) connection_id: Uuid,
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
pub(crate) struct SqlDocumentService {
    store: Store,
    connections: ConnectionManager,
}

impl SqlDocumentService {
    pub(super) fn new(store: Store, connections: ConnectionManager) -> Self {
        Self { store, connections }
    }

    pub(crate) async fn list(&self, connection_id: Uuid) -> AppResult<Vec<SqlDocument>> {
        let context = self
            .connections
            .pin(connection_id, ConnectionAccess::Read)
            .await?;
        let pin = context.pin();
        let rows = sqlx::query(
            "SELECT id, connection_id, title, dialect, content, local_revision,
                    remote_id, remote_revision, dirty, sync_status, created_at, updated_at
             FROM sql_documents
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3
               AND deleted_at IS NULL
             ORDER BY updated_at DESC, created_at DESC",
        )
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(connection_id.to_string())
        .fetch_all(self.store.pool())
        .await?;
        rows.iter().map(row_to_document).collect()
    }

    pub(crate) async fn create(&self, request: CreateSqlDocumentRequest) -> AppResult<SqlDocument> {
        let context = self
            .connections
            .pin(request.connection_id, ConnectionAccess::Read)
            .await?;
        let pin = context.pin();
        let title = normalize_title(request.title.as_deref().unwrap_or("Untitled query"))?;
        let content = request.content.unwrap_or_else(|| "SELECT 1;".into());
        validate_content(&content)?;
        let document = SqlDocument {
            id: Uuid::new_v4(),
            connection_id: request.connection_id,
            title,
            dialect: dialect(pin.profile.engine).into(),
            content,
            local_revision: 1,
            remote_id: None,
            remote_revision: None,
            dirty: true,
            sync_status: "local".into(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let mut transaction = self.store.pool().begin().await?;
        sqlx::query(
            "INSERT INTO sql_documents
                (id, workspace_id, account_scope, connection_id, title, dialect, content,
                 local_revision, remote_id, remote_revision, dirty, sync_status,
                 deleted_at, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,1,NULL,NULL,1,'local',NULL,?8,?9)",
        )
        .bind(document.id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(document.connection_id.to_string())
        .bind(&document.title)
        .bind(&document.dialect)
        .bind(&document.content)
        .bind(&document.created_at)
        .bind(&document.updated_at)
        .execute(&mut *transaction)
        .await?;
        insert_revision(&mut transaction, &document).await?;
        transaction.commit().await?;
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
        let context = self
            .connections
            .pin(request.connection_id, ConnectionAccess::Read)
            .await?;
        let pin = context.pin();
        let updated_at = Utc::now().to_rfc3339();
        let mut transaction = self.store.pool().begin().await?;
        let update = sqlx::query(
            "UPDATE sql_documents
             SET title = ?1, content = ?2, local_revision = local_revision + 1,
                 dirty = 1,
                 sync_status = CASE WHEN remote_id IS NULL THEN 'local' ELSE 'dirty' END,
                 updated_at = ?3
             WHERE id = ?4 AND workspace_id = ?5 AND account_scope = ?6
               AND connection_id = ?7 AND local_revision = ?8 AND deleted_at IS NULL",
        )
        .bind(&title)
        .bind(&request.content)
        .bind(&updated_at)
        .bind(request.id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(request.connection_id.to_string())
        .bind(request.expected_revision)
        .execute(&mut *transaction)
        .await?;

        if update.rows_affected() == 0 {
            let current =
                load_scoped_document(&mut transaction, pin, request.connection_id, request.id)
                    .await?;
            transaction.commit().await?;
            return Ok(SaveSqlDocumentOutcome {
                saved: false,
                document: current,
                expected_revision: request.expected_revision,
                attempted_content_hash,
            });
        }

        let saved =
            load_scoped_document(&mut transaction, pin, request.connection_id, request.id).await?;
        insert_revision(&mut transaction, &saved).await?;
        sqlx::query(
            "DELETE FROM sql_document_revisions
             WHERE document_id = ?1
               AND local_revision NOT IN (
                 SELECT local_revision FROM sql_document_revisions
                 WHERE document_id = ?1
                 ORDER BY local_revision DESC LIMIT ?2
               )",
        )
        .bind(request.id.to_string())
        .bind(REVISION_RETENTION)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(SaveSqlDocumentOutcome {
            saved: true,
            document: saved,
            expected_revision: request.expected_revision,
            attempted_content_hash,
        })
    }

    pub(crate) async fn delete(
        &self,
        connection_id: Uuid,
        id: Uuid,
        expected_revision: i64,
    ) -> AppResult<()> {
        let context = self
            .connections
            .pin(connection_id, ConnectionAccess::Read)
            .await?;
        let pin = context.pin();
        let result = sqlx::query(
            "UPDATE sql_documents
             SET deleted_at = ?1, updated_at = ?1, local_revision = local_revision + 1
             WHERE id = ?2 AND workspace_id = ?3 AND account_scope = ?4
               AND connection_id = ?5 AND local_revision = ?6 AND deleted_at IS NULL",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(connection_id.to_string())
        .bind(expected_revision)
        .execute(self.store.pool())
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::Blocked {
                reason: "SQL document changed before it could be closed; reload it first".into(),
            });
        }
        Ok(())
    }
}

fn normalize_title(title: &str) -> AppResult<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Config(
            "SQL document title must not be empty".into(),
        ));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::Config(format!(
            "SQL document title exceeds {MAX_TITLE_CHARS} characters"
        )));
    }
    Ok(title.to_owned())
}

fn validate_content(content: &str) -> AppResult<()> {
    if content.len() > MAX_DOCUMENT_BYTES {
        return Err(AppError::Config(format!(
            "SQL document exceeds the {} MiB local limit",
            MAX_DOCUMENT_BYTES / 1024 / 1024
        )));
    }
    Ok(())
}

fn dialect(engine: Engine) -> &'static str {
    match engine {
        Engine::Postgres => "postgresql",
        Engine::Mysql => "mysql",
        Engine::Sqlite => "sqlite",
        Engine::Mongodb => "mongodb",
    }
}

fn content_hash(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

async fn insert_revision(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    document: &SqlDocument,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO sql_document_revisions
            (document_id, local_revision, content_hash, content, created_at)
         VALUES (?1,?2,?3,?4,?5)",
    )
    .bind(document.id.to_string())
    .bind(document.local_revision)
    .bind(content_hash(&document.content))
    .bind(&document.content)
    .bind(&document.updated_at)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn load_scoped_document(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    pin: &PinnedConnection,
    connection_id: Uuid,
    id: Uuid,
) -> AppResult<SqlDocument> {
    let row = sqlx::query(
        "SELECT id, connection_id, title, dialect, content, local_revision,
                remote_id, remote_revision, dirty, sync_status, created_at, updated_at
         FROM sql_documents
         WHERE id = ?1 AND workspace_id = ?2 AND account_scope = ?3
           AND connection_id = ?4 AND deleted_at IS NULL",
    )
    .bind(id.to_string())
    .bind(pin.scope.workspace_id.to_string())
    .bind(pin.scope.account_scope.storage_key())
    .bind(connection_id.to_string())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("SQL document {id}")))?;
    row_to_document(&row)
}

fn row_to_document(row: &sqlx::sqlite::SqliteRow) -> AppResult<SqlDocument> {
    Ok(SqlDocument {
        id: parse_uuid(row.try_get("id")?)?,
        connection_id: parse_uuid(row.try_get("connection_id")?)?,
        title: row.try_get("title")?,
        dialect: row.try_get("dialect")?,
        content: row.try_get("content")?,
        local_revision: row.try_get("local_revision")?,
        remote_id: row.try_get("remote_id")?,
        remote_revision: row.try_get("remote_revision")?,
        dirty: row.try_get::<i64, _>("dirty")? != 0,
        sync_status: row.try_get("sync_status")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn parse_uuid(value: String) -> AppResult<Uuid> {
    Uuid::parse_str(&value)
        .map_err(|_| AppError::Config("stored SQL document id is invalid".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_is_stable_and_content_sensitive() {
        assert_eq!(content_hash("SELECT 1"), content_hash("SELECT 1"));
        assert_ne!(content_hash("SELECT 1"), content_hash("SELECT 2"));
        assert_eq!(content_hash("SELECT 1").len(), 64);
    }

    #[test]
    fn title_and_document_bounds_are_enforced() {
        assert!(normalize_title(" query ").is_ok());
        assert!(normalize_title(" ").is_err());
        assert!(normalize_title(&"x".repeat(MAX_TITLE_CHARS + 1)).is_err());
        assert!(validate_content(&"x".repeat(MAX_DOCUMENT_BYTES + 1)).is_err());
    }

    #[test]
    fn personal_and_workspace_scopes_have_distinct_storage_keys() {
        assert_eq!(AccountScope::Personal.storage_key(), "personal");
        assert_eq!(
            AccountScope::WorkspaceUser("user-1".into()).storage_key(),
            "user-1"
        );
    }
}
