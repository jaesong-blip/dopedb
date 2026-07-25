//! Tauri transport for catalog use cases.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::ConnectionId;
use crate::state::AppState;

use super::{CatalogReadPolicy, CatalogSnapshot};

#[tauri::command]
pub async fn get_schema(state: State<'_, AppState>, id: ConnectionId) -> AppResult<String> {
    let catalog = state
        .services
        .catalog
        .load(id, CatalogReadPolicy::CacheFirst)
        .await?;
    Ok(serde_json::to_string(&catalog)?)
}

#[tauri::command]
pub async fn refresh_schema(state: State<'_, AppState>, id: ConnectionId) -> AppResult<String> {
    let catalog = state
        .services
        .catalog
        .load(id, CatalogReadPolicy::Refresh)
        .await?;
    Ok(serde_json::to_string(&catalog)?)
}

#[tauri::command]
pub async fn get_catalog_snapshot(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<CatalogSnapshot> {
    if !state
        .features
        .is_enabled(crate::features::FeatureFlag::CatalogV2)
    {
        return Err(AppError::Blocked {
            reason: "Catalog V2 is disabled for this app runtime".into(),
        });
    }
    state
        .services
        .catalog
        .load_snapshot(id, CatalogReadPolicy::CacheFirst)
        .await
}

#[tauri::command]
pub async fn get_table_ddl(
    state: State<'_, AppState>,
    id: ConnectionId,
    schema: Option<String>,
    table: String,
) -> AppResult<String> {
    state
        .services
        .catalog
        .table_ddl(id, schema.as_deref(), &table)
        .await
}
