//! Tauri transport for catalog use cases.

use tauri::State;

use crate::error::AppResult;
use crate::kernel::identity::ConnectionId;
use crate::state::AppState;

use super::{CatalogOverview, CatalogReadPolicy, CatalogSnapshot, DatabaseSummary};

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
    state
        .services
        .catalog
        .load_snapshot(id, CatalogReadPolicy::CacheFirst)
        .await
}

/// Load the bounded relation tree without reading or overwriting the full catalog cache.
#[tauri::command]
pub async fn get_catalog_overview(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<CatalogOverview> {
    state.services.catalog.load_overview(id).await
}

#[tauri::command]
pub async fn list_connection_databases(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<Vec<DatabaseSummary>> {
    state.services.catalog.list_databases(id).await
}

#[tauri::command]
pub async fn get_database_schema(
    state: State<'_, AppState>,
    id: ConnectionId,
    database: String,
) -> AppResult<String> {
    let catalog = state.services.catalog.load_database(id, database).await?;
    Ok(serde_json::to_string(&catalog)?)
}

#[tauri::command]
pub async fn get_database_catalog_overview(
    state: State<'_, AppState>,
    id: ConnectionId,
    database: String,
) -> AppResult<CatalogOverview> {
    state
        .services
        .catalog
        .load_database_overview(id, database)
        .await
}

#[tauri::command]
pub async fn get_database_catalog_snapshot(
    state: State<'_, AppState>,
    id: ConnectionId,
    database: String,
) -> AppResult<CatalogSnapshot> {
    state
        .services
        .catalog
        .load_database_snapshot(id, database)
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

#[tauri::command]
pub async fn get_database_table_ddl(
    state: State<'_, AppState>,
    id: ConnectionId,
    database: String,
    schema: Option<String>,
    table: String,
) -> AppResult<String> {
    state
        .services
        .catalog
        .database_table_ddl(id, database, schema.as_deref(), &table)
        .await
}
