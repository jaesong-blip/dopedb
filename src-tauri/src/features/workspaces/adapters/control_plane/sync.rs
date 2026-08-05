//! Payload-free ordered workspace change cursor exchange.

use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteWorkspacePullPage {
    workspace_id: String,
    previous_cursor: Option<i64>,
    next_cursor: i64,
    has_more: bool,
    reset: bool,
    refresh: RemoteWorkspaceRefresh,
    tombstones: RemoteWorkspaceTombstones,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteWorkspaceRefresh {
    connections: bool,
    dashboards: bool,
    reports: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteWorkspaceTombstones {
    connections: bool,
    dashboards: bool,
    reports: bool,
}

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
    let body = response
        .json::<RemoteWorkspacePullPage>()
        .await
        .map_err(|error| request_error("reading workspace changes", error))?;
    if body.workspace_id != workspace_id.to_string()
        || body.previous_cursor != cursor
        || body.next_cursor < 0
        || (!body.reset && cursor.is_some_and(|value| body.next_cursor < value))
        || (body.reset && (!cursor.is_some_and(|value| body.next_cursor != value) || body.has_more))
        || (cursor.is_none() && (body.reset || body.has_more))
        || ((cursor.is_none() || body.reset)
            && (!body.refresh.connections || !body.refresh.dashboards || !body.refresh.reports))
        || (body.has_more && cursor.is_some_and(|value| body.next_cursor <= value))
        || (body.tombstones.connections && !body.refresh.connections)
        || (body.tombstones.dashboards && !body.refresh.dashboards)
        || (body.tombstones.reports && !body.refresh.reports)
    {
        return Err(AppError::Network(
            "workspace sync page violated its ordered contract".into(),
        ));
    }
    Ok(Some(WorkspacePullPage {
        next_cursor: body.next_cursor,
        has_more: body.has_more,
        reset: body.reset,
        refresh_connections: body.refresh.connections,
        refresh_dashboards: body.refresh.dashboards,
        refresh_reports: body.refresh.reports,
        connection_tombstone: body.tombstones.connections,
        dashboard_tombstone: body.tombstones.dashboards,
        report_tombstone: body.tombstones.reports,
    }))
}
