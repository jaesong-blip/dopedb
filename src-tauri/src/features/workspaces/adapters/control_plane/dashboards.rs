//! Secret-free shared-dashboard HTTP exchanges. Definitions may cross the
//! workspace boundary; result rows, query-run history, parameters, and credentials
//! have no serializable field in these request/response types.

use super::*;
use crate::features::dashboards::{validate_visualization, DashboardVisualization};
use chrono::{DateTime, Utc};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct RemoteDashboardResponse {
    id: String,
    connection_id: String,
    title: String,
    description: String,
    sql: String,
    visualization: serde_json::Value,
    state: String,
    owner_member_id: String,
    updated_by_member_id: String,
    revision: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RemoteDashboardsResponse {
    workspace_id: String,
    dashboards: Vec<RemoteDashboardResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatedDashboardResponse {
    dashboard: RemoteDashboardResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateDashboardRequest<'a> {
    id: &'a str,
    connection_id: &'a str,
    title: &'a str,
    description: &'a str,
    sql: &'a str,
    visualization: &'a serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardDefinitionRequest<'a> {
    title: &'a str,
    description: &'a str,
    sql: &'a str,
    visualization: &'a serde_json::Value,
}

#[derive(Debug, Serialize)]
struct UpdateDashboardRequest<'a> {
    action: &'static str,
    definition: DashboardDefinitionRequest<'a>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeletedDashboardResponse {
    deleted: bool,
    revision: i64,
}

fn safe_display(value: &str, max_chars: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= max_chars
        && !value.chars().any(|character| {
            character.is_control()
                && !matches!(character, '\n' | '\r' | '\t')
                || matches!(
                    character,
                    '\u{202a}'
                        | '\u{202b}'
                        | '\u{202c}'
                        | '\u{202d}'
                        | '\u{202e}'
                        | '\u{2066}'
                        | '\u{2067}'
                        | '\u{2068}'
                        | '\u{2069}'
                )
        })
}

fn parse_remote_dashboard(value: RemoteDashboardResponse) -> AppResult<RemoteDashboard> {
    let id = Uuid::parse_str(&value.id)
        .map_err(|_| AppError::Network("shared dashboard returned an invalid id".into()))?;
    let connection_id = Uuid::parse_str(&value.connection_id).map_err(|_| {
        AppError::Network("shared dashboard returned an invalid connection id".into())
    })?;
    if !safe_display(&value.title, 120, false)
        || !safe_display(&value.description, 2_000, true)
        || value.sql.trim().is_empty()
        || value.sql.len() > 100_000
        || value.sql.contains('\0')
        || value.owner_member_id.is_empty()
        || value.updated_by_member_id.is_empty()
        || value.revision < 1
    {
        return Err(AppError::Network(
            "shared dashboard returned an unsafe definition".into(),
        ));
    }
    let visualization: DashboardVisualization =
        serde_json::from_value(value.visualization).map_err(|_| {
            AppError::Network("shared dashboard returned an invalid visualization".into())
        })?;
    validate_visualization(&visualization).map_err(|_| {
        AppError::Network("shared dashboard returned an invalid visualization".into())
    })?;
    let created_at = DateTime::parse_from_rfc3339(&value.created_at)
        .map_err(|_| AppError::Network("shared dashboard returned an invalid timestamp".into()))?
        .with_timezone(&Utc);
    let updated_at = DateTime::parse_from_rfc3339(&value.updated_at)
        .map_err(|_| AppError::Network("shared dashboard returned an invalid timestamp".into()))?
        .with_timezone(&Utc);
    Ok(RemoteDashboard {
        id,
        connection_id,
        title: value.title,
        description: value.description,
        sql: value.sql,
        visualization_json: serde_json::to_string(&visualization)?,
        state: WorkspaceDashboardState::parse(&value.state)?,
        owner_member_id: value.owner_member_id,
        updated_by_member_id: value.updated_by_member_id,
        revision: value.revision,
        created_at,
        updated_at,
    })
}

fn mutation_visualization(mutation: &PendingDashboardMutation) -> AppResult<serde_json::Value> {
    let visualization: DashboardVisualization =
        serde_json::from_str(&mutation.visualization_json)?;
    validate_visualization(&visualization)?;
    serde_json::to_value(visualization).map_err(Into::into)
}

pub(super) async fn remote_dashboards(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<Option<Vec<RemoteDashboard>>> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("shared dashboards require an authenticated session".into())
        })?;
    let origin = origin()?;
    let response = client()?
        .get(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/dashboards"
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading shared dashboards", error))?;
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
        .json::<RemoteDashboardsResponse>()
        .await
        .map_err(|error| request_error("reading shared dashboards", error))?;
    if body.workspace_id != workspace_id.to_string() {
        return Err(AppError::Network(
            "shared dashboard collection changed workspace identity".into(),
        ));
    }
    body
        .dashboards
        .into_iter()
        .map(parse_remote_dashboard)
        .collect::<AppResult<Vec<_>>>()
        .map(Some)
}

pub(super) async fn upsert_dashboard(
    user_id: &str,
    workspace_id: Uuid,
    mutation: &PendingDashboardMutation,
) -> AppResult<DashboardPushResult> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("sharing a dashboard requires an authenticated session".into())
        })?;
    let visualization = mutation_visualization(mutation)?;
    let origin = origin()?;
    let builder = if let (Some(remote_id), Some(remote_revision)) =
        (mutation.remote_id, mutation.remote_revision)
    {
        if remote_id != mutation.dashboard_id {
            return Err(AppError::Config(
                "shared dashboard identity does not match the local resource".into(),
            ));
        }
        client()?
            .patch(format!(
                "{origin}/api/v1/workspaces/{workspace_id}/dashboards/{remote_id}"
            ))
            .bearer_auth(token.as_str())
            .header("if-match", format!("\"{remote_revision}\""))
            .json(&UpdateDashboardRequest {
                action: "update",
                definition: DashboardDefinitionRequest {
                    title: &mutation.title,
                    description: &mutation.description,
                    sql: &mutation.sql,
                    visualization: &visualization,
                },
            })
    } else if mutation.remote_id.is_none() && mutation.remote_revision.is_none() {
        let dashboard_id = mutation.dashboard_id.to_string();
        let connection_id = mutation.connection_id.to_string();
        client()?
            .post(format!(
                "{origin}/api/v1/workspaces/{workspace_id}/dashboards"
            ))
            .bearer_auth(token.as_str())
            .header("if-match", "\"0\"")
            .json(&CreateDashboardRequest {
                id: &dashboard_id,
                connection_id: &connection_id,
                title: &mutation.title,
                description: &mutation.description,
                sql: &mutation.sql,
                visualization: &visualization,
            })
    } else {
        return Err(AppError::Config(
            "shared dashboard remote revision is incomplete".into(),
        ));
    };
    let response = builder
        .send()
        .await
        .map_err(|error| request_error("sharing dashboard", error))?;
    if response.status() == StatusCode::CONFLICT {
        return Ok(DashboardPushResult::Conflict);
    }
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let dashboard = response
        .json::<CreatedDashboardResponse>()
        .await
        .map_err(|error| request_error("reading shared dashboard", error))?
        .dashboard;
    let dashboard = parse_remote_dashboard(dashboard)?;
    let minimum_revision = mutation
        .remote_revision
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| AppError::Config("shared dashboard revision overflowed".into()))?;
    if dashboard.id != mutation.dashboard_id
        || dashboard.connection_id != mutation.connection_id
        || dashboard.revision < minimum_revision
    {
        return Err(AppError::Network(
            "shared dashboard mutation changed identity or revision".into(),
        ));
    }
    Ok(DashboardPushResult::Applied(dashboard))
}

pub(super) async fn delete_dashboard(
    user_id: &str,
    workspace_id: Uuid,
    mutation: &PendingDashboardMutation,
) -> AppResult<DashboardPushResult> {
    let (Some(remote_id), Some(remote_revision)) =
        (mutation.remote_id, mutation.remote_revision)
    else {
        return Ok(DashboardPushResult::Deleted(0));
    };
    if remote_id != mutation.dashboard_id {
        return Err(AppError::Config(
            "shared dashboard identity does not match the local resource".into(),
        ));
    }
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("deleting a shared dashboard requires an authenticated session".into())
        })?;
    let origin = origin()?;
    let response = client()?
        .delete(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/dashboards/{remote_id}"
        ))
        .bearer_auth(token.as_str())
        .header("if-match", format!("\"{remote_revision}\""))
        .send()
        .await
        .map_err(|error| request_error("deleting shared dashboard", error))?;
    if response.status() == StatusCode::CONFLICT {
        return Ok(DashboardPushResult::Conflict);
    }
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let deleted = response
        .json::<DeletedDashboardResponse>()
        .await
        .map_err(|error| request_error("reading deleted dashboard", error))?;
    if !deleted.deleted || deleted.revision <= remote_revision {
        return Err(AppError::Network(
            "shared dashboard deletion returned an invalid revision".into(),
        ));
    }
    Ok(DashboardPushResult::Deleted(deleted.revision))
}
