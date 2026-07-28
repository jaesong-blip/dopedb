//! Tauri transport adapter for connection use cases.

use tauri::State;
use zeroize::Zeroizing;

use crate::error::AppResult;
use crate::kernel::identity::ConnectionId;
use crate::model::ConnectionProfile;
use crate::state::AppState;

use super::{ConnectionProfileTestRequest, ConnectionUpsertRequest, DriverDescriptor};

#[tauri::command]
pub fn list_drivers(state: State<'_, AppState>) -> Vec<DriverDescriptor> {
    state.services.connections.list_drivers()
}

#[tauri::command]
pub fn install_driver(state: State<'_, AppState>, id: String) -> AppResult<DriverDescriptor> {
    state.services.connections.install_driver(&id)
}

#[tauri::command]
pub async fn create_demo_sqlite(app: tauri::AppHandle) -> AppResult<String> {
    super::demo::create(&app).await
}

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionProfile>> {
    state.services.connections.list_profiles().await
}

#[tauri::command]
pub async fn upsert_connection(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    profile: ConnectionProfile,
    password: Option<String>,
) -> AppResult<ConnectionProfile> {
    let saved = state
        .services
        .connections
        .upsert(ConnectionUpsertRequest {
            profile,
            password: password.map(Zeroizing::new),
        })
        .await?;
    state
        .terminals
        .stop_connection(ConnectionId::from(saved.id), &app);
    Ok(saved)
}

#[tauri::command]
pub async fn set_connections_schema_group(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    ids: Vec<ConnectionId>,
    schema_group: Option<String>,
) -> AppResult<Vec<ConnectionProfile>> {
    let profiles = state
        .services
        .connections
        .set_schema_group(ids.clone(), schema_group)
        .await?;
    for id in ids {
        state.terminals.stop_connection(id, &app);
    }
    Ok(profiles)
}

#[tauri::command]
pub async fn delete_connection(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: ConnectionId,
) -> AppResult<()> {
    let deleted = state.services.connections.delete(id).await?;
    state.terminals.stop_connection(id, &app);
    match state.services.connections.list_profiles().await {
        Ok(remaining) => {
            if let Err(error) =
                super::demo::remove_if_unreferenced(&app, &deleted, &remaining).await
            {
                tracing::warn!(
                    connection_id = %id,
                    %error,
                    "could not remove the unreferenced Demo SQLite file"
                );
            }
        }
        Err(error) => {
            tracing::warn!(
                connection_id = %id,
                %error,
                "skipped Demo SQLite cleanup because remaining connections were unavailable"
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>, id: ConnectionId) -> AppResult<()> {
    state.services.connections.test(id).await
}

#[tauri::command]
pub async fn test_connection_profile(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    password: Option<String>,
) -> AppResult<()> {
    state
        .services
        .connections
        .test_profile(ConnectionProfileTestRequest {
            profile,
            password: password.map(Zeroizing::new),
        })
        .await
}
