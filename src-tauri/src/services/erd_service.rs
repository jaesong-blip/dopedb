//! Workspace-scoped ERD presentation persistence with optimistic revisions.
//!
//! Physical catalog objects remain authoritative and immutable here. Layouts store
//! only viewport/node presentation and explicitly virtual relationships, so opening
//! or sharing an ERD can never silently mutate the database schema.

use std::collections::HashSet;

use chrono::Utc;
use dopedb_protocol::ObjectRef;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::connection::{ConnectionAccess, ConnectionManager};
use crate::error::{AppError, AppResult};
use crate::store::{PinnedConnection, Store};

const MAX_LAYOUTS_PER_CONNECTION: i64 = 100;
const MAX_LAYOUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_NODES: usize = 50_000;
const MAX_VIRTUAL_RELATIONS: usize = 50_000;
const MAX_NAME_CHARS: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ErdLayoutMode {
    Physical,
    Logical,
    Uml,
}

impl ErdLayoutMode {
    fn storage_key(self) -> &'static str {
        match self {
            Self::Physical => "physical",
            Self::Logical => "logical",
            Self::Uml => "uml",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "physical" => Ok(Self::Physical),
            "logical" => Ok(Self::Logical),
            "uml" => Ok(Self::Uml),
            _ => Err(AppError::Config("stored ERD layout mode is invalid".into())),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ErdNodePosition {
    pub(crate) relation_key: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ErdViewport {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) zoom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ErdCanvasLayout {
    pub(crate) nodes: Vec<ErdNodePosition>,
    pub(crate) viewport: ErdViewport,
    #[serde(default)]
    pub(crate) compact: bool,
    #[serde(default)]
    pub(crate) hidden_relation_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ErdVirtualRelation {
    pub(crate) id: Uuid,
    pub(crate) from_relation: ObjectRef,
    pub(crate) from_columns: Vec<String>,
    pub(crate) to_relation: ObjectRef,
    pub(crate) to_columns: Vec<String>,
    pub(crate) label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErdLayout {
    pub(crate) id: Uuid,
    pub(crate) connection_id: Uuid,
    pub(crate) name: String,
    pub(crate) mode: ErdLayoutMode,
    pub(crate) catalog_fingerprint: String,
    pub(crate) layout: ErdCanvasLayout,
    pub(crate) virtual_relations: Vec<ErdVirtualRelation>,
    pub(crate) revision: i64,
    pub(crate) remote_id: Option<String>,
    pub(crate) remote_revision: Option<i64>,
    pub(crate) sync_status: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveErdLayoutRequest {
    pub(crate) id: Option<Uuid>,
    pub(crate) connection_id: Uuid,
    pub(crate) name: String,
    pub(crate) mode: ErdLayoutMode,
    pub(crate) catalog_fingerprint: String,
    pub(crate) layout: ErdCanvasLayout,
    #[serde(default)]
    pub(crate) virtual_relations: Vec<ErdVirtualRelation>,
    pub(crate) expected_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveErdLayoutOutcome {
    pub(crate) saved: bool,
    pub(crate) layout: ErdLayout,
}

#[derive(Clone)]
pub(crate) struct ErdService {
    store: Store,
    connections: ConnectionManager,
}

impl ErdService {
    pub(super) fn new(store: Store, connections: ConnectionManager) -> Self {
        Self { store, connections }
    }

    pub(crate) async fn list(&self, connection_id: Uuid) -> AppResult<Vec<ErdLayout>> {
        let context = self
            .connections
            .pin(connection_id, ConnectionAccess::Read)
            .await?;
        let pin = context.pin();
        let rows = sqlx::query(
            "SELECT id, connection_id, name, mode, catalog_fingerprint, layout_json,
                    virtual_relations_json, revision, remote_id, remote_revision,
                    sync_status, created_at, updated_at
             FROM erd_layouts
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3
               AND deleted_at IS NULL
             ORDER BY updated_at DESC, created_at DESC",
        )
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(connection_id.to_string())
        .fetch_all(self.store.pool())
        .await?;
        rows.iter().map(row_to_layout).collect()
    }

    pub(crate) async fn save(
        &self,
        request: SaveErdLayoutRequest,
    ) -> AppResult<SaveErdLayoutOutcome> {
        validate_request(&request)?;
        let context = self
            .connections
            .pin(request.connection_id, ConnectionAccess::Read)
            .await?;
        let pin = context.pin();
        let name = request.name.trim();
        let layout_json = serde_json::to_string(&request.layout)?;
        let virtual_relations_json = serde_json::to_string(&request.virtual_relations)?;
        if layout_json.len() + virtual_relations_json.len() > MAX_LAYOUT_BYTES {
            return Err(AppError::Config(format!(
                "ERD layout exceeds the {} MiB local limit",
                MAX_LAYOUT_BYTES / 1024 / 1024
            )));
        }
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.store.pool().begin().await?;

        if let Some(id) = request.id {
            let expected_revision = request.expected_revision.ok_or_else(|| {
                AppError::Config("existing ERD layouts require an expected revision".into())
            })?;
            if expected_revision < 1 {
                return Err(AppError::Config(
                    "ERD layout expected revision must be positive".into(),
                ));
            }
            let update = sqlx::query(
                "UPDATE erd_layouts
                 SET name = ?1, mode = ?2, catalog_fingerprint = ?3, layout_json = ?4,
                     virtual_relations_json = ?5, revision = revision + 1,
                     sync_status = CASE WHEN remote_id IS NULL THEN 'local' ELSE 'dirty' END,
                     updated_at = ?6
                 WHERE id = ?7 AND workspace_id = ?8 AND account_scope = ?9
                   AND connection_id = ?10 AND revision = ?11 AND deleted_at IS NULL",
            )
            .bind(name)
            .bind(request.mode.storage_key())
            .bind(&request.catalog_fingerprint)
            .bind(&layout_json)
            .bind(&virtual_relations_json)
            .bind(&now)
            .bind(id.to_string())
            .bind(pin.scope.workspace_id.to_string())
            .bind(pin.scope.account_scope.storage_key())
            .bind(request.connection_id.to_string())
            .bind(expected_revision)
            .execute(&mut *transaction)
            .await?;
            let current =
                load_scoped_layout(&mut transaction, pin, request.connection_id, id).await?;
            transaction.commit().await?;
            return Ok(SaveErdLayoutOutcome {
                saved: update.rows_affected() == 1,
                layout: current,
            });
        }

        if request.expected_revision.is_some() {
            return Err(AppError::Config(
                "new ERD layouts must not include an expected revision".into(),
            ));
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM erd_layouts
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3
               AND deleted_at IS NULL",
        )
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(request.connection_id.to_string())
        .fetch_one(&mut *transaction)
        .await?;
        if count >= MAX_LAYOUTS_PER_CONNECTION {
            return Err(AppError::Blocked {
                reason: format!(
                    "a connection can keep at most {MAX_LAYOUTS_PER_CONNECTION} ERD layouts"
                ),
            });
        }
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO erd_layouts
                (id, workspace_id, account_scope, connection_id, name, mode,
                 catalog_fingerprint, layout_json, virtual_relations_json, revision,
                 remote_id, remote_revision, sync_status, deleted_at, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,NULL,NULL,'local',NULL,?10,?10)",
        )
        .bind(id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(request.connection_id.to_string())
        .bind(name)
        .bind(request.mode.storage_key())
        .bind(&request.catalog_fingerprint)
        .bind(&layout_json)
        .bind(&virtual_relations_json)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
        let created = load_scoped_layout(&mut transaction, pin, request.connection_id, id).await?;
        transaction.commit().await?;
        Ok(SaveErdLayoutOutcome {
            saved: true,
            layout: created,
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
        let now = Utc::now().to_rfc3339();
        let update = sqlx::query(
            "UPDATE erd_layouts
             SET deleted_at = ?1, updated_at = ?1, revision = revision + 1,
                 sync_status = CASE WHEN remote_id IS NULL THEN 'local' ELSE 'dirty' END
             WHERE id = ?2 AND workspace_id = ?3 AND account_scope = ?4
               AND connection_id = ?5 AND revision = ?6 AND deleted_at IS NULL",
        )
        .bind(now)
        .bind(id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(connection_id.to_string())
        .bind(expected_revision)
        .execute(self.store.pool())
        .await?;
        if update.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "ERD layout changed before it could be deleted; reload it first".into(),
            });
        }
        Ok(())
    }
}

fn validate_request(request: &SaveErdLayoutRequest) -> AppResult<()> {
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::Config(format!(
            "ERD layout name must contain 1 to {MAX_NAME_CHARS} characters"
        )));
    }
    if request.catalog_fingerprint.len() != 64
        || !request
            .catalog_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(AppError::Config(
            "ERD layout catalog fingerprint must be lowercase SHA-256".into(),
        ));
    }
    if request.layout.nodes.len() > MAX_NODES
        || request.virtual_relations.len() > MAX_VIRTUAL_RELATIONS
    {
        return Err(AppError::Config("ERD layout item limit exceeded".into()));
    }
    if !request.layout.viewport.x.is_finite()
        || !request.layout.viewport.y.is_finite()
        || !request.layout.viewport.zoom.is_finite()
        || !(0.05..=8.0).contains(&request.layout.viewport.zoom)
    {
        return Err(AppError::Config("ERD viewport is invalid".into()));
    }
    let mut node_keys = HashSet::new();
    for node in &request.layout.nodes {
        if node.relation_key.is_empty()
            || node.relation_key.len() > 2_048
            || !node.x.is_finite()
            || !node.y.is_finite()
            || !node_keys.insert(&node.relation_key)
        {
            return Err(AppError::Config(
                "ERD node positions contain an invalid or duplicate relation".into(),
            ));
        }
    }
    let mut relation_ids = HashSet::new();
    for relation in &request.virtual_relations {
        if !relation_ids.insert(relation.id)
            || relation.from_columns.is_empty()
            || relation.from_columns.len() != relation.to_columns.len()
            || relation
                .from_columns
                .iter()
                .chain(&relation.to_columns)
                .any(|column| column.trim().is_empty())
            || relation.from_relation == relation.to_relation
        {
            return Err(AppError::Config(
                "ERD virtual relationship is invalid or duplicated".into(),
            ));
        }
    }
    Ok(())
}

async fn load_scoped_layout(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    pin: &PinnedConnection,
    connection_id: Uuid,
    id: Uuid,
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
    .bind(pin.scope.workspace_id.to_string())
    .bind(pin.scope.account_scope.storage_key())
    .bind(connection_id.to_string())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("ERD layout {id}")))?;
    row_to_layout(&row)
}

fn row_to_layout(row: &sqlx::sqlite::SqliteRow) -> AppResult<ErdLayout> {
    let layout_json: String = row.try_get("layout_json")?;
    let virtual_relations_json: String = row.try_get("virtual_relations_json")?;
    Ok(ErdLayout {
        id: parse_uuid(row.try_get("id")?)?,
        connection_id: parse_uuid(row.try_get("connection_id")?)?,
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

fn parse_uuid(value: String) -> AppResult<Uuid> {
    Uuid::parse_str(&value).map_err(|_| AppError::Config("stored ERD id is invalid".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dopedb_protocol::ObjectKind;

    fn request() -> SaveErdLayoutRequest {
        SaveErdLayoutRequest {
            id: None,
            connection_id: Uuid::nil(),
            name: "Main".into(),
            mode: ErdLayoutMode::Physical,
            catalog_fingerprint: "a".repeat(64),
            layout: ErdCanvasLayout {
                nodes: vec![ErdNodePosition {
                    relation_key: "public.users".into(),
                    x: 10.0,
                    y: 20.0,
                }],
                viewport: ErdViewport {
                    x: 0.0,
                    y: 0.0,
                    zoom: 1.0,
                },
                compact: false,
                hidden_relation_keys: Vec::new(),
            },
            virtual_relations: vec![ErdVirtualRelation {
                id: Uuid::new_v4(),
                from_relation: ObjectRef {
                    catalog: None,
                    namespace: Some("public".into()),
                    name: "users".into(),
                    kind: ObjectKind::Table,
                    native_id: None,
                },
                from_columns: vec!["team_id".into()],
                to_relation: ObjectRef {
                    catalog: None,
                    namespace: Some("public".into()),
                    name: "teams".into(),
                    kind: ObjectKind::Table,
                    native_id: None,
                },
                to_columns: vec!["id".into()],
                label: None,
            }],
            expected_revision: None,
        }
    }

    #[test]
    fn validates_bounded_layout_and_virtual_relations() {
        assert!(validate_request(&request()).is_ok());
        let mut invalid = request();
        invalid.layout.viewport.zoom = f64::NAN;
        assert!(validate_request(&invalid).is_err());
        let mut invalid = request();
        invalid.virtual_relations[0].to_columns.clear();
        assert!(validate_request(&invalid).is_err());
    }

    #[test]
    fn mode_storage_round_trip_is_stable() {
        for mode in [
            ErdLayoutMode::Physical,
            ErdLayoutMode::Logical,
            ErdLayoutMode::Uml,
        ] {
            assert_eq!(ErdLayoutMode::parse(mode.storage_key()).unwrap(), mode);
        }
    }
}
