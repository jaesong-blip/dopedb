use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRunnerSettings {
    background_allowed: bool,
    launch_at_login: bool,
}

fn autostart_error(action: &str, error: impl std::fmt::Display) -> AppError {
    AppError::Config(format!("could not {action} background automation: {error}"))
}

#[tauri::command]
pub(crate) async fn automation_runner_settings(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<AutomationRunnerSettings> {
    let background_allowed = state
        .knowledge_store()
        .automation_runner_background_allowed()
        .await?;
    let launch_at_login = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| autostart_error("read", error))?;
    Ok(AutomationRunnerSettings {
        background_allowed,
        launch_at_login,
    })
}

#[tauri::command]
pub(crate) async fn set_automation_runner_background_allowed(
    app: AppHandle,
    state: State<'_, AppState>,
    allowed: bool,
) -> AppResult<AutomationRunnerSettings> {
    let previous = state
        .knowledge_store()
        .automation_runner_background_allowed()
        .await?;
    state
        .knowledge_store()
        .set_automation_runner_background_allowed(allowed)
        .await?;
    let registration = if allowed {
        app.autolaunch()
            .enable()
            .map_err(|error| autostart_error("enable", error))
    } else {
        app.autolaunch()
            .disable()
            .map_err(|error| autostart_error("disable", error))
    };
    if let Err(error) = registration {
        state
            .knowledge_store()
            .set_automation_runner_background_allowed(previous)
            .await?;
        return Err(error);
    }
    state.analysis_runner.set_background_allowed(allowed);
    Ok(AutomationRunnerSettings {
        background_allowed: allowed,
        launch_at_login: app
            .autolaunch()
            .is_enabled()
            .map_err(|error| autostart_error("verify", error))?,
    })
}
