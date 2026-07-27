//! Tauri transport for ERD persistence use cases.

use tauri::State;

use crate::error::AppResult;
use crate::kernel::identity::{ConnectionErdLayoutId, ConnectionId, ErdLayoutId};
use crate::state::AppState;

use super::{ErdLayout, SaveErdLayoutOutcome, SaveErdLayoutRequest};

#[tauri::command]
pub async fn list_erd_layouts(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<Vec<ErdLayout>> {
    state.services.erd.list(id).await
}

#[tauri::command]
pub async fn save_erd_layout(
    state: State<'_, AppState>,
    request: SaveErdLayoutRequest,
) -> AppResult<SaveErdLayoutOutcome> {
    state.services.erd.save(request).await
}

#[tauri::command]
pub async fn delete_erd_layout(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    id: ErdLayoutId,
    expected_revision: i64,
) -> AppResult<()> {
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
