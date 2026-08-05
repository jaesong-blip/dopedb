//! Tauri transport for the durable Job Engine.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{
    ConnectionId, ConnectionJobId, JobArtifactId, JobFileCapabilityId, JobId,
};
use crate::state::AppState;

use super::{
    CreateJobRequest, Job, JobDetail, JobFileCapability, JobFormat, JobInputInspection, JobProposal,
};

/// Select an input file in the trusted native shell and expose only an opaque,
/// connection-scoped capability to the renderer.
#[tauri::command]
pub async fn pick_job_input(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: ConnectionId,
) -> AppResult<Option<JobFileCapability>> {
    use tauri_plugin_dialog::DialogExt;

    state.wait_for_post_paint_recovery().await?;

    let path = app
        .dialog()
        .file()
        .add_filter(
            "Data files",
            &["csv", "tsv", "json", "ndjson", "sql", "xlsx", "gz"],
        )
        .blocking_pick_file()
        .and_then(|path| path.into_path().ok());
    match path {
        Some(path) => state
            .services
            .job
            .register_input(connection_id, path)
            .await
            .map(Some),
        None => Ok(None),
    }
}

/// Select an output destination in the trusted native shell. Local paths never
/// cross the renderer boundary.
#[tauri::command]
pub async fn pick_job_output(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: ConnectionId,
    suggested_name: String,
) -> AppResult<Option<JobFileCapability>> {
    use tauri_plugin_dialog::DialogExt;

    state.wait_for_post_paint_recovery().await?;

    let path = app
        .dialog()
        .file()
        .set_file_name(suggested_name)
        .add_filter(
            "Data files",
            &["csv", "tsv", "json", "ndjson", "sql", "xlsx", "gz"],
        )
        .blocking_save_file()
        .and_then(|path| path.into_path().ok());
    match path {
        Some(path) => state
            .services
            .job
            .register_output(connection_id, path)
            .await
            .map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn inspect_job_input(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    capability_id: JobFileCapabilityId,
    format: JobFormat,
) -> AppResult<JobInputInspection> {
    state.wait_for_post_paint_recovery().await?;
    state
        .services
        .job
        .inspect_input(connection_id, capability_id, format)
        .await
}

#[tauri::command]
pub async fn create_job(
    state: State<'_, AppState>,
    request: CreateJobRequest,
) -> AppResult<JobProposal> {
    state.wait_for_post_paint_recovery().await?;
    state.services.job.create(request).await
}

#[tauri::command]
pub async fn list_jobs(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
) -> AppResult<Vec<Job>> {
    state.wait_for_post_paint_recovery().await?;
    state.services.job.list(connection_id).await
}

#[tauri::command]
pub async fn get_job(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    job_id: JobId,
) -> AppResult<JobDetail> {
    state.wait_for_post_paint_recovery().await?;
    state
        .services
        .job
        .detail(ConnectionJobId {
            connection_id,
            job_id,
        })
        .await
}

#[tauri::command]
pub async fn start_job(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    job_id: JobId,
) -> AppResult<Job> {
    state.wait_for_post_paint_recovery().await?;
    state
        .services
        .job
        .start(ConnectionJobId {
            connection_id,
            job_id,
        })
        .await
}

#[tauri::command]
pub async fn pause_job(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    job_id: JobId,
) -> AppResult<Job> {
    state.wait_for_post_paint_recovery().await?;
    state
        .services
        .job
        .pause(ConnectionJobId {
            connection_id,
            job_id,
        })
        .await
}

#[tauri::command]
pub async fn cancel_job(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    job_id: JobId,
) -> AppResult<Job> {
    state.wait_for_post_paint_recovery().await?;
    state
        .services
        .job
        .cancel(ConnectionJobId {
            connection_id,
            job_id,
        })
        .await
}

#[tauri::command]
pub async fn reveal_job_artifact(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: ConnectionId,
    artifact_id: JobArtifactId,
) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;

    state.wait_for_post_paint_recovery().await?;

    let path = state
        .services
        .job
        .artifact_path(connection_id, artifact_id)
        .await?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| AppError::Config(format!("could not reveal job artifact: {error}")))
}
