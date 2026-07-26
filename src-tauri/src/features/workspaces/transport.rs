//! Tauri transport adapter for workspace use cases.

use tauri::State;
use zeroize::Zeroizing;

use crate::error::AppResult;
use crate::kernel::identity::{AccountId, ConnectionId, WorkspaceId};
use crate::model::ConnectionProfile;
use crate::state::AppState;

use super::{
    Workspace, WorkspaceAuthState, WorkspaceAuthorityFingerprint, WorkspaceConnectionCopyRequest,
    WorkspaceCredentialBindingRequest, WorkspaceDeviceAuthorization, WorkspaceFeatureState,
    WorkspaceLoginPoll, WorkspaceLoginPollStatus,
};

async fn revoke_if_authority_changed(
    state: &AppState,
    app: &tauri::AppHandle,
    before: &WorkspaceAuthorityFingerprint,
) {
    match state.services.workspace.authority_fingerprint().await {
        Ok(after) if &after == before => {}
        Ok(_) | Err(_) => state.terminals.stop_all(app),
    }
}

#[tauri::command]
pub fn workspace_feature_state(state: State<'_, AppState>) -> WorkspaceFeatureState {
    state.services.workspace.feature_state()
}

#[tauri::command]
pub async fn workspace_auth_state(state: State<'_, AppState>) -> AppResult<WorkspaceAuthState> {
    state.services.workspace.auth_state().await
}

#[tauri::command]
pub async fn refresh_workspace_auth_state(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<WorkspaceAuthState> {
    let before = state.services.workspace.authority_fingerprint().await?;
    let result = state.services.workspace.refresh_auth_state().await;
    revoke_if_authority_changed(&state, &app, &before).await;
    result
}

#[tauri::command]
pub async fn workspace_sign_out(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    user_id: Option<AccountId>,
) -> AppResult<WorkspaceAuthState> {
    state.terminals.stop_all(&app);
    state.services.workspace.sign_out(user_id).await
}

#[tauri::command]
pub async fn workspace_sign_out_all(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<WorkspaceAuthState> {
    state.terminals.stop_all(&app);
    state.services.workspace.sign_out_all().await
}

#[tauri::command]
pub async fn begin_workspace_login(
    state: State<'_, AppState>,
) -> AppResult<WorkspaceDeviceAuthorization> {
    state.services.workspace.begin_login().await
}

#[tauri::command]
pub async fn poll_workspace_login(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    device_code: String,
) -> AppResult<WorkspaceLoginPoll> {
    let result = state.services.workspace.poll_login(&device_code).await?;
    if result.status == WorkspaceLoginPollStatus::SignedIn {
        state.terminals.stop_all(&app);
    }
    Ok(result)
}

#[tauri::command]
pub fn workspace_console_url(
    state: State<'_, AppState>,
    workspace_id: Option<WorkspaceId>,
) -> AppResult<String> {
    state.services.workspace.console_url(workspace_id)
}

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> AppResult<Vec<Workspace>> {
    state.services.workspace.list().await
}

#[tauri::command]
pub async fn refresh_workspace_memberships(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<Vec<Workspace>> {
    let before = state.services.workspace.authority_fingerprint().await?;
    let result = state.services.workspace.refresh_memberships().await;
    revoke_if_authority_changed(&state, &app, &before).await;
    result
}

#[tauri::command]
pub async fn get_active_workspace(state: State<'_, AppState>) -> AppResult<Workspace> {
    state.services.workspace.active().await
}

#[tauri::command]
pub async fn set_active_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: WorkspaceId,
    account_user_id: Option<AccountId>,
) -> AppResult<Workspace> {
    let before = state.services.workspace.authority_fingerprint().await?;
    let result = state.services.workspace.activate(id, account_user_id).await;
    revoke_if_authority_changed(&state, &app, &before).await;
    result
}

#[tauri::command]
pub async fn set_active_workspace_account(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    user_id: AccountId,
) -> AppResult<Workspace> {
    let before = state.services.workspace.authority_fingerprint().await?;
    let result = state.services.workspace.activate_account(user_id).await;
    revoke_if_authority_changed(&state, &app, &before).await;
    result
}

#[tauri::command]
pub async fn copy_connection_to_workspace(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    workspace_id: WorkspaceId,
    account_user_id: AccountId,
) -> AppResult<ConnectionProfile> {
    state
        .services
        .workspace
        .copy_connection(WorkspaceConnectionCopyRequest {
            connection_id,
            workspace_id,
            account_user_id,
        })
        .await
}

#[tauri::command]
pub async fn bind_workspace_connection_credentials(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: ConnectionId,
    username: String,
    password: String,
) -> AppResult<ConnectionProfile> {
    let profile = state
        .services
        .workspace
        .bind_connection_credentials(WorkspaceCredentialBindingRequest {
            connection_id: id,
            username,
            password: Zeroizing::new(password),
        })
        .await?;
    state.terminals.stop_connection(id, &app);
    Ok(profile)
}
