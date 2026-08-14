//! Payload-free ordered workspace change cursor exchange.

use super::*;

pub(super) async fn workspace_pull_page(
    user_id: &str,
    workspace_id: Uuid,
    cursor: Option<i64>,
) -> AppResult<Option<WorkspacePullPage>> {
    if cursor.is_some_and(|value| value < 0) {
        return Err(AppError::Config(
            "workspace pull cursor cannot be negative".into(),
        ));
    }
    if !valid_workspace_sync_cursor(cursor) {
        return Err(AppError::Config(
            "workspace pull cursor exceeds the exact Cloud range".into(),
        ));
    }
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("workspace sync requires an authenticated session".into())
        })?;
    let mut url = Url::parse(&format!(
        "{}/api/v1/workspaces/{workspace_id}/sync",
        origin()?
    ))
    .map_err(|_| AppError::Config("workspace sync URL is invalid".into()))?;
    if let Some(cursor) = cursor {
        url.query_pairs_mut()
            .append_pair("cursor", &cursor.to_string());
    }
    let response = client()?
        .get(url)
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading workspace changes", error))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let body: WorkspaceSyncPageResponse = crate::hosted_control_plane::bounded_json_response(
        response,
        "reading workspace changes",
        MAX_WORKSPACE_SYNC_RESPONSE_BYTES,
    )
    .await?;
    if !body.valid_for(workspace_id, cursor) {
        return Err(AppError::Network(
            "workspace sync page violated its ordered contract".into(),
        ));
    }
    Ok(Some(WorkspacePullPage {
        next_cursor: body.next_cursor,
        has_more: body.has_more,
        reset: body.reset,
        refresh_connections: body.refresh.connections,
        refresh_analyses: body.refresh.analyses,
        connection_tombstone: body.tombstones.connections,
        analysis_tombstone: body.tombstones.analyses,
    }))
}
