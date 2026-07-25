//! Concrete SQL document adapters for connection authority, time/identity, and SQLite.

use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use crate::connection::{ConnectionAccess, ConnectionContext, ConnectionManager};
use crate::error::{AppError, AppResult};
use crate::kernel::identity::{
    AccountScopeId, ConnectionId, SqlDocumentId, WorkspaceConnectionId, WorkspaceId,
};
use crate::model::Engine;
use crate::store::Store;

use super::domain::{content_hash, SqlDialect, SqlDocument, SqlDocumentSyncStatus};
use super::ports::{
    SaveDocumentCommand, SaveRepositoryOutcome, SqlDocumentAuthority, SqlDocumentAuthorityGuard,
    SqlDocumentAuthorityPort, SqlDocumentGeneratorPort, SqlDocumentRepositoryPort,
};

const REVISION_RETENTION: i64 = 50;

#[derive(Clone)]
pub(crate) struct ConnectionSqlDocumentAuthority {
    connections: ConnectionManager,
}

impl ConnectionSqlDocumentAuthority {
    pub(crate) fn new(connections: ConnectionManager) -> Self {
        Self { connections }
    }
}

pub(crate) struct ConnectionSqlDocumentGuard {
    authority: SqlDocumentAuthority,
    _context: ConnectionContext,
}

impl SqlDocumentAuthorityGuard for ConnectionSqlDocumentGuard {
    fn authority(&self) -> &SqlDocumentAuthority {
        &self.authority
    }
}

impl SqlDocumentAuthorityPort for ConnectionSqlDocumentAuthority {
    type Guard = ConnectionSqlDocumentGuard;

    async fn authorize(&self, connection_id: ConnectionId) -> AppResult<Self::Guard> {
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let pin = context.pin();
        let account_scope = AccountScopeId::new(pin.scope.account_scope.storage_key())
            .ok_or_else(|| AppError::Config("active account scope is invalid".into()))?;
        let authority = SqlDocumentAuthority {
            resource: WorkspaceConnectionId {
                workspace_id: WorkspaceId::from(pin.scope.workspace_id),
                connection_id,
            },
            account_scope,
            dialect: dialect(pin.profile.engine),
        };
        Ok(ConnectionSqlDocumentGuard {
            authority,
            _context: context,
        })
    }
}

#[derive(Clone, Copy)]
pub(crate) struct SystemSqlDocumentGenerator;

impl SqlDocumentGeneratorPort for SystemSqlDocumentGenerator {
    fn next_id(&self) -> SqlDocumentId {
        SqlDocumentId::from(Uuid::new_v4())
    }

    fn now(&self) -> String {
        Utc::now().to_rfc3339()
    }
}

#[derive(Clone)]
pub(crate) struct SqliteSqlDocumentRepository {
    store: Store,
}

impl SqliteSqlDocumentRepository {
    pub(crate) fn new(store: Store) -> Self {
        Self { store }
    }
}

impl SqlDocumentRepositoryPort for SqliteSqlDocumentRepository {
    async fn list(&self, authority: &SqlDocumentAuthority) -> AppResult<Vec<SqlDocument>> {
        let rows = sqlx::query(
            "SELECT id, connection_id, title, dialect, content, local_revision,
                    remote_id, remote_revision, dirty, sync_status, created_at, updated_at
             FROM sql_documents
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3
               AND deleted_at IS NULL
             ORDER BY updated_at DESC, created_at DESC",
        )
        .bind(authority.resource.workspace_id.to_string())
        .bind(authority.account_scope.as_str())
        .bind(authority.resource.connection_id.to_string())
        .fetch_all(self.store.pool())
        .await?;
        rows.iter().map(row_to_document).collect()
    }

    async fn create(
        &self,
        authority: &SqlDocumentAuthority,
        document: &SqlDocument,
    ) -> AppResult<()> {
        let mut transaction = self.store.pool().begin().await?;
        sqlx::query(
            "INSERT INTO sql_documents
                (id, workspace_id, account_scope, connection_id, title, dialect, content,
                 local_revision, remote_id, remote_revision, dirty, sync_status,
                 deleted_at, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,1,NULL,NULL,1,'local',NULL,?8,?9)",
        )
        .bind(document.id.to_string())
        .bind(authority.resource.workspace_id.to_string())
        .bind(authority.account_scope.as_str())
        .bind(authority.resource.connection_id.to_string())
        .bind(&document.title)
        .bind(&document.dialect)
        .bind(&document.content)
        .bind(&document.created_at)
        .bind(&document.updated_at)
        .execute(&mut *transaction)
        .await?;
        insert_revision(&mut transaction, document).await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn save(
        &self,
        authority: &SqlDocumentAuthority,
        command: SaveDocumentCommand,
    ) -> AppResult<SaveRepositoryOutcome> {
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
        .bind(&command.title)
        .bind(&command.content)
        .bind(&command.updated_at)
        .bind(command.id.to_string())
        .bind(authority.resource.workspace_id.to_string())
        .bind(authority.account_scope.as_str())
        .bind(authority.resource.connection_id.to_string())
        .bind(command.expected_revision)
        .execute(&mut *transaction)
        .await?;

        if update.rows_affected() == 0 {
            let current = load_scoped_document(&mut transaction, authority, command.id).await?;
            transaction.commit().await?;
            return Ok(SaveRepositoryOutcome::Conflict(current));
        }

        let saved = load_scoped_document(&mut transaction, authority, command.id).await?;
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
        .bind(command.id.to_string())
        .bind(REVISION_RETENTION)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(SaveRepositoryOutcome::Saved(saved))
    }

    async fn delete(
        &self,
        authority: &SqlDocumentAuthority,
        id: SqlDocumentId,
        expected_revision: i64,
        deleted_at: String,
    ) -> AppResult<bool> {
        let result = sqlx::query(
            "UPDATE sql_documents
             SET deleted_at = ?1, updated_at = ?1, local_revision = local_revision + 1
             WHERE id = ?2 AND workspace_id = ?3 AND account_scope = ?4
               AND connection_id = ?5 AND local_revision = ?6 AND deleted_at IS NULL",
        )
        .bind(deleted_at)
        .bind(id.to_string())
        .bind(authority.resource.workspace_id.to_string())
        .bind(authority.account_scope.as_str())
        .bind(authority.resource.connection_id.to_string())
        .bind(expected_revision)
        .execute(self.store.pool())
        .await?;
        Ok(result.rows_affected() == 1)
    }
}

fn dialect(engine: Engine) -> SqlDialect {
    match engine {
        Engine::Postgres => SqlDialect::PostgreSql,
        Engine::Mysql => SqlDialect::MySql,
        Engine::Sqlite => SqlDialect::Sqlite,
        Engine::Mongodb => SqlDialect::MongoDb,
    }
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
    authority: &SqlDocumentAuthority,
    id: SqlDocumentId,
) -> AppResult<SqlDocument> {
    let row = sqlx::query(
        "SELECT id, connection_id, title, dialect, content, local_revision,
                remote_id, remote_revision, dirty, sync_status, created_at, updated_at
         FROM sql_documents
         WHERE id = ?1 AND workspace_id = ?2 AND account_scope = ?3
           AND connection_id = ?4 AND deleted_at IS NULL",
    )
    .bind(id.to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(authority.resource.connection_id.to_string())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("SQL document {id}")))?;
    row_to_document(&row)
}

fn row_to_document(row: &sqlx::sqlite::SqliteRow) -> AppResult<SqlDocument> {
    Ok(SqlDocument {
        id: SqlDocumentId::from(parse_uuid(row.try_get("id")?)?),
        connection_id: ConnectionId::from(parse_uuid(row.try_get("connection_id")?)?),
        title: row.try_get("title")?,
        dialect: row.try_get("dialect")?,
        content: row.try_get("content")?,
        local_revision: row.try_get("local_revision")?,
        remote_id: row.try_get("remote_id")?,
        remote_revision: row.try_get("remote_revision")?,
        dirty: row.try_get::<i64, _>("dirty")? != 0,
        sync_status: SqlDocumentSyncStatus::parse(&row.try_get::<String, _>("sync_status")?)?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn parse_uuid(value: String) -> AppResult<Uuid> {
    Uuid::parse_str(&value)
        .map_err(|_| AppError::Config("stored SQL document id is invalid".into()))
}
