//! Tauri transport for structured schema-editor use cases.

use dopedb_protocol::{DdlPlan, SchemaChangeRequest};
use tauri::State;

use crate::error::AppResult;
use crate::features::scripts::DesktopScriptRunReceipt;
use crate::kernel::identity::{ConnectionId, OperationId};
use crate::state::AppState;

use super::{SchemaChangeCommand, SchemaChangeProposal};

#[tauri::command]
pub async fn preview_schema_change(
    state: State<'_, AppState>,
    id: ConnectionId,
    request: SchemaChangeRequest,
) -> AppResult<DdlPlan> {
    state
        .services
        .schema
        .preview(SchemaChangeCommand {
            connection_id: id,
            request,
        })
        .await
}

#[tauri::command]
pub async fn propose_schema_change(
    state: State<'_, AppState>,
    id: ConnectionId,
    request: SchemaChangeRequest,
) -> AppResult<SchemaChangeProposal> {
    state
        .services
        .schema
        .propose(SchemaChangeCommand {
            connection_id: id,
            request,
        })
        .await
}

#[tauri::command]
pub async fn run_schema_change(
    state: State<'_, AppState>,
    operation_id: OperationId,
) -> AppResult<DesktopScriptRunReceipt> {
    state.services.schema.run(operation_id).await
}
