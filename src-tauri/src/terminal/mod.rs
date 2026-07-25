//! PTY-backed Terminal Dock command surface.

mod environment;
mod manager;
mod model;
mod output;
mod process_tree;

use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::broker::BrokerCapability;
use crate::error::{AppError, AppResult};
use crate::features::FeatureFlag;
use crate::state::AppState;

pub(crate) use manager::TerminalManager;
pub use model::{
    TerminalCreateRequest, TerminalFocusReceipt, TerminalOutputChunk, TerminalSessionSummary,
    TerminalSize,
};

use manager::CreateContext;

// Capabilities are memory-only and revoked as soon as the PTY leader exits. The
// seven-day ceiling is a leak backstop, not a user-visible reauthentication timer.
const TERMINAL_CAPABILITY_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[tauri::command]
pub async fn terminal_create(
    request: TerminalCreateRequest,
    on_output: Channel<TerminalOutputChunk>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<TerminalSessionSummary> {
    require_terminal(&state)?;
    let cli_directory = tokio::task::spawn_blocking(crate::cli_install::in_app_cli_directory)
        .await
        .map_err(|_| AppError::Config("the in-app CLI resolver stopped unexpectedly".into()))??;
    let connection = state
        .store
        .pin_connection_for_read(request.connection_id)
        .await?;
    let session_id = Uuid::new_v4();
    let issued = state.broker.sessions().issue(
        session_id,
        &connection,
        BrokerCapability::ALL,
        TERMINAL_CAPABILITY_TTL,
    )?;
    let token = Zeroizing::new(issued.token().to_owned());
    let runtime_file = state.broker.runtime_file();
    let manager = state.terminals.clone();
    let broker_sessions = state.broker.sessions().clone();
    let result = tokio::task::spawn_blocking(move || {
        manager.create(
            request,
            CreateContext {
                id: session_id,
                replacement_id: None,
                connection,
                session_token: token.as_str(),
                runtime_file: runtime_file.as_deref(),
                cli_directory: &cli_directory,
                output: on_output,
                app: &app,
            },
        )
    })
    .await
    .map_err(|_| AppError::Config("the Terminal creation worker stopped unexpectedly".into()))?;
    if result.is_err() {
        broker_sessions.revoke(session_id);
    }
    result
}

#[tauri::command]
pub fn terminal_list(state: State<'_, AppState>) -> AppResult<Vec<TerminalSessionSummary>> {
    require_terminal(&state)?;
    Ok(state.terminals.list())
}

#[tauri::command]
pub async fn terminal_focus(
    id: Uuid,
    after_sequence: Option<u64>,
    on_output: Channel<TerminalOutputChunk>,
    state: State<'_, AppState>,
) -> AppResult<TerminalFocusReceipt> {
    require_terminal(&state)?;
    let manager = state.terminals.clone();
    tokio::task::spawn_blocking(move || manager.focus(id, after_sequence, on_output))
        .await
        .map_err(|_| AppError::Config("the Terminal replay worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn terminal_write(id: Uuid, bytes: Vec<u8>, state: State<'_, AppState>) -> AppResult<()> {
    require_terminal(&state)?;
    let manager = state.terminals.clone();
    tokio::task::spawn_blocking(move || manager.write(id, bytes))
        .await
        .map_err(|_| AppError::Config("the Terminal input worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn terminal_resize(
    id: Uuid,
    size: TerminalSize,
    state: State<'_, AppState>,
) -> AppResult<()> {
    require_terminal(&state)?;
    let manager = state.terminals.clone();
    tokio::task::spawn_blocking(move || manager.resize(id, size))
        .await
        .map_err(|_| AppError::Config("the Terminal resize worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn terminal_kill(
    id: Uuid,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<TerminalSessionSummary> {
    require_terminal(&state)?;
    let manager = state.terminals.clone();
    tokio::task::spawn_blocking(move || manager.kill(id, &app))
        .await
        .map_err(|_| AppError::Config("the Terminal stop worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn terminal_restart(
    id: Uuid,
    on_output: Channel<TerminalOutputChunk>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<TerminalSessionSummary> {
    require_terminal(&state)?;
    let manager = state.terminals.clone();
    let seed = manager.restart_seed(id)?;
    let current = state
        .store
        .pin_connection_for_read(seed.connection.connection_id)
        .await?;
    if !seed.connection_pin.matches(&current) {
        return Err(AppError::Blocked {
            reason:
                "the pinned connection changed; create a new Terminal session instead of retargeting"
                    .into(),
        });
    }
    let cli_directory = tokio::task::spawn_blocking(crate::cli_install::in_app_cli_directory)
        .await
        .map_err(|_| AppError::Config("the in-app CLI resolver stopped unexpectedly".into()))??;
    let _ = manager.kill(id, &app)?;

    let next_id = Uuid::new_v4();
    let issued = state.broker.sessions().issue(
        next_id,
        &current,
        BrokerCapability::ALL,
        TERMINAL_CAPABILITY_TTL,
    )?;
    let token = Zeroizing::new(issued.token().to_owned());
    let runtime_file = state.broker.runtime_file();
    let broker_sessions = state.broker.sessions().clone();
    let create_manager = manager.clone();
    let request = TerminalCreateRequest {
        connection_id: current.connection_id,
        profile: seed.profile,
        size: seed.size,
        name: Some(seed.name),
    };
    let result = tokio::task::spawn_blocking(move || {
        create_manager.create(
            request,
            CreateContext {
                id: next_id,
                replacement_id: Some(id),
                connection: current,
                session_token: token.as_str(),
                runtime_file: runtime_file.as_deref(),
                cli_directory: &cli_directory,
                output: on_output,
                app: &app,
            },
        )
    })
    .await
    .map_err(|_| AppError::Config("the Terminal restart worker stopped unexpectedly".into()))?;
    if result.is_err() {
        broker_sessions.revoke(next_id);
    } else {
        manager.forget(id);
    }
    result
}

#[tauri::command]
pub async fn terminal_rename(
    id: Uuid,
    name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<TerminalSessionSummary> {
    require_terminal(&state)?;
    let manager = state.terminals.clone();
    tokio::task::spawn_blocking(move || manager.rename(id, &name, &app))
        .await
        .map_err(|_| AppError::Config("the Terminal rename worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn terminal_shutdown_all(state: State<'_, AppState>, app: AppHandle) -> AppResult<()> {
    require_terminal(&state)?;
    let manager = state.terminals.clone();
    tokio::task::spawn_blocking(move || manager.shutdown_all(&app, Duration::from_secs(2)))
        .await
        .map_err(|_| {
            AppError::Config("the Terminal shutdown worker stopped unexpectedly".into())
        })?;
    Ok(())
}

fn require_terminal(state: &AppState) -> AppResult<()> {
    if state.features.is_enabled(FeatureFlag::TerminalDockV1) {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "the Terminal Dock feature is disabled for this app runtime".into(),
        })
    }
}
