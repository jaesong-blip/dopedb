//! Single-writer SQLite repository for workspace-scoped ERD layouts.

use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, ErdLayoutId};
use crate::store::Store;

use super::super::domain::{ErdLayout, ErdLayoutMode};
use super::super::ports::{
    ErdAuthority, ErdGeneratorPort, ErdRepositoryPort, SaveErdLayoutCommand,
    SaveErdRepositoryOutcome,
};

const MAX_LAYOUTS_PER_CONNECTION: i64 = 100;

#[derive(Clone)]
pub(in crate::features::erd) struct SqliteErdRepository {
    store: Store,
}

impl SqliteErdRepository {
    pub(in crate::features::erd) fn new(store: Store) -> Self {
        Self { store }
    }
}

#[derive(Clone, Copy)]
pub(in crate::features::erd) struct SystemErdGenerator;

impl ErdGeneratorPort for SystemErdGenerator {
    fn next_id(&self) -> ErdLayoutId {
        ErdLayoutId::from(Uuid::new_v4())
    }

    fn now(&self) -> String {
        Utc::now().to_rfc3339()
    }
}

impl ErdRepositoryPort for SqliteErdRepository {
    async fn list(&self, authority: &ErdAuthority) -> AppResult<Vec<ErdLayout>> {
        let rows = sqlx::query(
            "SELECT id, connection_id, name, mode, catalog_fingerprint, layout_json,
                    virtual_relations_json, revision, remote_id, remote_revision,
                    sync_status, created_at, updated_at
             FROM erd_layouts
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3
               AND deleted_at IS NULL
             ORDER BY updated_at DESC, created_at DESC",
        )
        .bind(authority.resource.workspace_id.to_string())
        .bind(authority.account_scope.as_str())
        .bind(authority.resource.connection_id.to_string())
        .fetch_all(self.store.pool())
        .await?;
        rows.iter().map(row_to_layout).collect()
    }

    async fn save(
        &self,
        authority: &ErdAuthority,
        command: SaveErdLayoutCommand,
    ) -> AppResult<SaveErdRepositoryOutcome> {
        match command {
            SaveErdLayoutCommand::Create { id, payload, now } => {
                let mut transaction = self.store.pool().begin().await?;
                let count: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM erd_layouts
                     WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3
                       AND deleted_at IS NULL",
                )
                .bind(authority.resource.workspace_id.to_string())
                .bind(authority.account_scope.as_str())
                .bind(authority.resource.connection_id.to_string())
                .fetch_one(&mut *transaction)
                .await?;
                if count >= MAX_LAYOUTS_PER_CONNECTION {
                    return Err(AppError::Blocked {
                        reason: format!(
                            "a connection can keep at most {MAX_LAYOUTS_PER_CONNECTION} ERD layouts"
                        ),
                    });
                }
                sqlx::query(
                    "INSERT INTO erd_layouts
                        (id, workspace_id, account_scope, connection_id, name, mode,
                         catalog_fingerprint, layout_json, virtual_relations_json, revision,
                         remote_id, remote_revision, sync_status, deleted_at, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,NULL,NULL,'local',NULL,?10,?10)",
                )
                .bind(id.to_string())
                .bind(authority.resource.workspace_id.to_string())
                .bind(authority.account_scope.as_str())
                .bind(authority.resource.connection_id.to_string())
                .bind(&payload.name)
                .bind(payload.mode.storage_key())
                .bind(&payload.catalog_fingerprint)
                .bind(serde_json::to_string(&payload.layout)?)
                .bind(serde_json::to_string(&payload.virtual_relations)?)
                .bind(&now)
                .execute(&mut *transaction)
                .await?;
                let created = load_scoped_layout(&mut transaction, authority, id).await?;
                transaction.commit().await?;
                Ok(SaveErdRepositoryOutcome::Saved(created))
            }
            SaveErdLayoutCommand::Update {
                id,
                payload,
                expected_revision,
                updated_at,
            } => {
                let mut transaction = self.store.pool().begin().await?;
                let update = sqlx::query(
                    "UPDATE erd_layouts
                     SET name = ?1, mode = ?2, catalog_fingerprint = ?3, layout_json = ?4,
                         virtual_relations_json = ?5, revision = revision + 1,
                         sync_status = CASE WHEN remote_id IS NULL THEN 'local' ELSE 'dirty' END,
                         updated_at = ?6
                     WHERE id = ?7 AND workspace_id = ?8 AND account_scope = ?9
                       AND connection_id = ?10 AND revision = ?11 AND deleted_at IS NULL",
                )
                .bind(&payload.name)
                .bind(payload.mode.storage_key())
                .bind(&payload.catalog_fingerprint)
                .bind(serde_json::to_string(&payload.layout)?)
                .bind(serde_json::to_string(&payload.virtual_relations)?)
                .bind(&updated_at)
                .bind(id.to_string())
                .bind(authority.resource.workspace_id.to_string())
                .bind(authority.account_scope.as_str())
                .bind(authority.resource.connection_id.to_string())
                .bind(expected_revision)
                .execute(&mut *transaction)
                .await?;
                let current = load_scoped_layout(&mut transaction, authority, id).await?;
                transaction.commit().await?;
                if update.rows_affected() == 1 {
                    Ok(SaveErdRepositoryOutcome::Saved(current))
                } else {
                    Ok(SaveErdRepositoryOutcome::Conflict(current))
                }
            }
        }
    }
}

async fn load_scoped_layout(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    authority: &ErdAuthority,
    id: ErdLayoutId,
) -> AppResult<ErdLayout> {
    let row = sqlx::query(
        "SELECT id, connection_id, name, mode, catalog_fingerprint, layout_json,
                virtual_relations_json, revision, remote_id, remote_revision,
                sync_status, created_at, updated_at
         FROM erd_layouts
         WHERE id = ?1 AND workspace_id = ?2 AND account_scope = ?3
           AND connection_id = ?4 AND deleted_at IS NULL",
    )
    .bind(id.to_string())
    .bind(authority.resource.workspace_id.to_string())
    .bind(authority.account_scope.as_str())
    .bind(authority.resource.connection_id.to_string())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("ERD layout {id}")))?;
    row_to_layout(&row)
}

fn row_to_layout(row: &sqlx::sqlite::SqliteRow) -> AppResult<ErdLayout> {
    let layout_json: String = row.try_get("layout_json")?;
    let virtual_relations_json: String = row.try_get("virtual_relations_json")?;
    Ok(ErdLayout {
        id: parse_erd_id(row.try_get("id")?)?,
        connection_id: parse_connection_id(row.try_get("connection_id")?)?,
        name: row.try_get("name")?,
        mode: ErdLayoutMode::parse(&row.try_get::<String, _>("mode")?)?,
        catalog_fingerprint: row.try_get("catalog_fingerprint")?,
        layout: serde_json::from_str(&layout_json)?,
        virtual_relations: serde_json::from_str(&virtual_relations_json)?,
        revision: row.try_get("revision")?,
        remote_id: row.try_get("remote_id")?,
        remote_revision: row.try_get("remote_revision")?,
        sync_status: row.try_get("sync_status")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn parse_erd_id(value: String) -> AppResult<ErdLayoutId> {
    Uuid::parse_str(&value)
        .map(ErdLayoutId::from)
        .map_err(|_| AppError::Config("stored ERD layout id is invalid".into()))
}

fn parse_connection_id(value: String) -> AppResult<ConnectionId> {
    Uuid::parse_str(&value)
        .map(ConnectionId::from)
        .map_err(|_| AppError::Config("stored ERD connection id is invalid".into()))
}
