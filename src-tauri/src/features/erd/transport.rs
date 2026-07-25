//! Tauri transport for ERD persistence use cases.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionErdLayoutId, ConnectionId, ErdLayoutId};
use crate::state::AppState;

use super::{ErdLayout, SaveErdLayoutOutcome, SaveErdLayoutRequest};

fn require_erd(state: &AppState) -> AppResult<()> {
    if state
        .features
        .is_enabled(crate::features::FeatureFlag::ErdV1)
    {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "persistent ERD layouts are disabled for this app runtime".into(),
        })
    }
}

#[tauri::command]
pub async fn list_erd_layouts(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<Vec<ErdLayout>> {
    require_erd(&state)?;
    state.services.erd.list(id).await
}

#[tauri::command]
pub async fn save_erd_layout(
    state: State<'_, AppState>,
    request: SaveErdLayoutRequest,
) -> AppResult<SaveErdLayoutOutcome> {
    require_erd(&state)?;
    state.services.erd.save(request).await
}

#[tauri::command]
pub async fn delete_erd_layout(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    id: ErdLayoutId,
    expected_revision: i64,
) -> AppResult<()> {
    require_erd(&state)?;
    state
        .services
        .erd
        .delete(
            ConnectionErdLayoutId {
                connection_id,
                layout_id: id,
            },
            expected_revision,
        )
        .await
}
