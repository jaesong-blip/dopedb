//! Tauri transport for structured schema-editor use cases.

use dopedb_protocol::{DdlPlan, SchemaChangeRequest};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, OperationId};
use crate::services::DesktopScriptRunReceipt;
use crate::state::AppState;

use super::{SchemaChangeCommand, SchemaChangeProposal};

fn require_schema_editor(state: &AppState) -> AppResult<()> {
    if state
        .features
        .is_enabled(crate::features::FeatureFlag::CatalogV2)
        && state
            .features
            .is_enabled(crate::features::FeatureFlag::DdlIrV1)
    {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "the structured schema editor is disabled for this app runtime".into(),
        })
    }
}

#[tauri::command]
pub async fn preview_schema_change(
    state: State<'_, AppState>,
    id: ConnectionId,
    request: SchemaChangeRequest,
) -> AppResult<DdlPlan> {
    require_schema_editor(&state)?;
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
    require_schema_editor(&state)?;
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
    require_schema_editor(&state)?;
    state.services.schema.run(operation_id).await
}
