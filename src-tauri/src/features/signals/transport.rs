use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignalRunnerSettings {
    background_allowed: bool,
    launch_at_login: bool,
}

fn autostart_error(action: &str, error: impl std::fmt::Display) -> AppError {
    AppError::Config(format!("could not {action} background monitoring: {error}"))
}

#[tauri::command]
pub(crate) async fn signal_runner_settings(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<SignalRunnerSettings> {
    let background_allowed = state
        .knowledge_store()
        .signal_runner_background_allowed()
        .await?;
    let launch_at_login = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| autostart_error("read", error))?;
    Ok(SignalRunnerSettings {
        background_allowed,
        launch_at_login,
    })
}

#[tauri::command]
pub(crate) async fn set_signal_runner_background_allowed(
    app: AppHandle,
    state: State<'_, AppState>,
    allowed: bool,
) -> AppResult<SignalRunnerSettings> {
    let previous = state
        .knowledge_store()
        .signal_runner_background_allowed()
        .await?;
    state
        .knowledge_store()
        .set_signal_runner_background_allowed(allowed)
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
            .set_signal_runner_background_allowed(previous)
            .await?;
        return Err(error);
    }
    state.signal_runner.set_background_allowed(allowed);
    Ok(SignalRunnerSettings {
        background_allowed: allowed,
        launch_at_login: app
            .autolaunch()
            .is_enabled()
            .map_err(|error| autostart_error("verify", error))?,
    })
}
