//! Explicit publication of secret-free Environment funnel analysis definitions.

use super::*;
use crate::features::knowledge::domain::EnvironmentConnectionBinding;
use dopedb_protocol::{
    DashboardRecord, FunnelAnalysisArtifactRecord, FunnelAnalysisFreshness,
    FunnelDashboardTileRecord, FunnelStepDefinition, FunnelTileAvailability, FunnelTileDefinition,
    FunnelTileKind,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteCollection {
    workspace_id: Uuid,
    analyses: Vec<RemoteAnalysis>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteAnalysis {
    id: Uuid,
    project_environment_id: Uuid,
    environment_revision: u64,
    source_knowledge_grant_id: Uuid,
    graph_revision_ids: Vec<Uuid>,
    connections: Vec<RemoteConnection>,
    definition: RemoteDefinition,
    state: String,
    owner_member_id: String,
    updated_by_member_id: String,
    revision: i64,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    dashboards: Vec<DashboardRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteConnection {
    connection_id: Uuid,
    connection_revision: i64,
    role: String,
    alias: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteDefinition {
    source_agent: dopedb_protocol::AcpPluginId,
    title: String,
    question: String,
    purpose: String,
    timezone: String,
    time_range: String,
    segment_filters: Vec<String>,
    conversion_window_seconds: u64,
    denominator_semantics: String,
    numerator_semantics: String,
    deduplication_policy: String,
    late_event_policy: String,
    steps: Vec<FunnelStepDefinition>,
    tiles: Vec<FunnelTileDefinition>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishConnection<'a> {
    connection_id: Uuid,
    connection_revision: i64,
    role: &'a str,
    alias: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishDefinition<'a> {
    source_agent: dopedb_protocol::AcpPluginId,
    title: &'a str,
    question: &'a str,
    purpose: &'a str,
    timezone: &'a str,
    time_range: &'a str,
    segment_filters: &'a [String],
    conversion_window_seconds: u64,
    denominator_semantics: &'a str,
    numerator_semantics: &'a str,
    deduplication_policy: &'a str,
    late_event_policy: &'a str,
    steps: &'a [dopedb_protocol::FunnelStepDefinition],
    tiles: Vec<&'a dopedb_protocol::FunnelTileDefinition>,
    warnings: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishRequest<'a> {
    id: Uuid,
    project_environment_id: Uuid,
    environment_revision: u64,
    source_knowledge_grant_id: Uuid,
    graph_revision_ids: &'a [Uuid],
    connections: Vec<PublishConnection<'a>>,
    definition: PublishDefinition<'a>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishedFunnelAnalysis {
    pub(crate) id: Uuid,
    pub(crate) revision: i64,
    pub(crate) state: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublishedResponse {
    analysis: PublishedFunnelAnalysis,
}

pub(crate) async fn publish_funnel_analysis(
    user_id: &str,
    workspace_id: Uuid,
    artifact: &FunnelAnalysisArtifactRecord,
    connections: &[EnvironmentConnectionBinding],
) -> AppResult<PublishedFunnelAnalysis> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| AppError::Config("publishing analysis requires sign-in".into()))?;
    if artifact.state != "draft"
        || artifact.revision != 1
        || connections.is_empty()
        || connections.iter().any(|connection| {
            Uuid::from(connection.workspace_id) != workspace_id
                || connection.project_environment_id != artifact.project_environment_id
                || connection.environment_revision != artifact.environment_revision
                || connection.connection_revision != connection.current_connection_revision
        })
    {
        return Err(AppError::Blocked {
            reason: "the funnel analysis authority changed before publication".into(),
        });
    }
    let request = PublishRequest {
        id: artifact.id,
        project_environment_id: artifact.project_environment_id,
        environment_revision: artifact.environment_revision,
        source_knowledge_grant_id: artifact.knowledge_grant_id,
        graph_revision_ids: &artifact.graph_revision_ids,
        connections: connections
            .iter()
            .map(|connection| PublishConnection {
                connection_id: connection.connection_id,
                connection_revision: connection.connection_revision,
                role: &connection.role,
                alias: &connection.alias,
            })
            .collect(),
        definition: PublishDefinition {
            source_agent: artifact.source_agent,
            title: &artifact.title,
            question: &artifact.question,
            purpose: &artifact.purpose,
            timezone: &artifact.timezone,
            time_range: &artifact.time_range,
            segment_filters: &artifact.segment_filters,
            conversion_window_seconds: artifact.conversion_window_seconds,
            denominator_semantics: &artifact.denominator_semantics,
            numerator_semantics: &artifact.numerator_semantics,
            deduplication_policy: &artifact.deduplication_policy,
            late_event_policy: &artifact.late_event_policy,
            steps: &artifact.steps,
            tiles: artifact.tiles.iter().map(|tile| &tile.definition).collect(),
            warnings: &artifact.warnings,
        },
    };
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/funnel-analyses",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header("if-match", "\"0\"")
        .json(&request)
        .send()
        .await
        .map_err(|error| request_error("publishing funnel analysis", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let body = response
        .json::<PublishedResponse>()
        .await
        .map_err(|error| request_error("reading published funnel analysis", error))?;
    if body.analysis.id != artifact.id
        || body.analysis.revision < 1
        || body.analysis.state != "published"
    {
        return Err(AppError::Network(
            "published funnel analysis returned an invalid identity".into(),
        ));
    }
    Ok(body.analysis)
}

pub(crate) async fn remote_funnel_analyses(
    user_id: &str,
    workspace_id: Uuid,
    current_knowledge_grant_id: Uuid,
) -> AppResult<Vec<FunnelAnalysisArtifactRecord>> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| AppError::Config("loading shared analyses requires sign-in".into()))?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/funnel-analyses",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading shared funnel analyses", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let body = response
        .json::<RemoteCollection>()
        .await
        .map_err(|error| request_error("reading shared funnel analyses", error))?;
    if body.workspace_id != workspace_id {
        return Err(AppError::Network(
            "shared funnel analyses changed workspace identity".into(),
        ));
    }
    body.analyses
        .into_iter()
        .map(|analysis| {
            if analysis.state != "published"
                || analysis.revision < 1
                || analysis.owner_member_id.is_empty()
                || analysis.updated_by_member_id.is_empty()
                || analysis.connections.is_empty()
                || analysis.graph_revision_ids.is_empty()
            {
                return Err(AppError::Network(
                    "shared funnel analysis returned invalid authority".into(),
                ));
            }
            let mut availability = FunnelAnalysisFreshness::Current;
            let mut tiles = analysis
                .definition
                .tiles
                .into_iter()
                .map(|definition| {
                    if definition.kind == FunnelTileKind::Markdown
                        || definition.composition.is_some()
                    {
                        return FunnelDashboardTileRecord {
                            definition,
                            dashboard: None,
                            connection_revision: None,
                            availability: FunnelTileAvailability::Ready,
                            unavailable_reason: None,
                        };
                    }
                    let dashboard = definition.dashboard_id.and_then(|id| {
                        analysis
                            .dashboards
                            .iter()
                            .find(|dashboard| dashboard.id == id)
                            .cloned()
                    });
                    let connection_revision = dashboard.as_ref().and_then(|dashboard| {
                        analysis
                            .connections
                            .iter()
                            .find(|connection| connection.connection_id == dashboard.connection_id)
                            .map(|connection| connection.connection_revision)
                    });
                    let (tile_availability, unavailable_reason) = match dashboard.as_ref() {
                        None => {
                            availability = FunnelAnalysisFreshness::Partial;
                            (
                                FunnelTileAvailability::MissingGrant,
                                Some(
                                    "This member has no usable grant for the tile connection."
                                        .into(),
                                ),
                            )
                        }
                        Some(dashboard)
                            if definition.expected_dashboard_revision
                                != Some(dashboard.revision) =>
                        {
                            availability = FunnelAnalysisFreshness::SchemaDrift;
                            (
                                FunnelTileAvailability::StaleDashboard,
                                Some(
                                    "The saved dashboard revision changed after publication."
                                        .into(),
                                ),
                            )
                        }
                        Some(_) if connection_revision.is_none() => {
                            availability = FunnelAnalysisFreshness::Partial;
                            (
                                FunnelTileAvailability::MissingGrant,
                                Some(
                                    "The Environment connection is unavailable to this member."
                                        .into(),
                                ),
                            )
                        }
                        Some(_) => (FunnelTileAvailability::Ready, None),
                    };
                    FunnelDashboardTileRecord {
                        definition,
                        dashboard,
                        connection_revision,
                        availability: tile_availability,
                        unavailable_reason,
                    }
                })
                .collect::<Vec<_>>();
            for index in 0..tiles.len() {
                let Some(composition) = tiles[index].definition.composition.as_ref() else {
                    continue;
                };
                let inputs = composition
                    .inputs
                    .iter()
                    .filter_map(|input| {
                        tiles
                            .iter()
                            .find(|tile| tile.definition.id == input.tile_id)
                            .map(|tile| tile.availability)
                    })
                    .collect::<Vec<_>>();
                let (tile_availability, reason) = if inputs.len() != composition.inputs.len()
                    || inputs
                        .iter()
                        .any(|input| *input == FunnelTileAvailability::Error)
                {
                    (
                        FunnelTileAvailability::Error,
                        Some("A composed metric input is unavailable.".into()),
                    )
                } else if inputs
                    .iter()
                    .any(|input| *input == FunnelTileAvailability::StaleDashboard)
                {
                    availability = FunnelAnalysisFreshness::SchemaDrift;
                    (
                        FunnelTileAvailability::StaleDashboard,
                        Some("A composed metric input changed after publication.".into()),
                    )
                } else if inputs
                    .iter()
                    .any(|input| *input == FunnelTileAvailability::MissingGrant)
                {
                    if availability == FunnelAnalysisFreshness::Current {
                        availability = FunnelAnalysisFreshness::Partial;
                    }
                    (
                        FunnelTileAvailability::MissingGrant,
                        Some("A composed metric input is outside this member's grant.".into()),
                    )
                } else {
                    (FunnelTileAvailability::Ready, None)
                };
                tiles[index].availability = tile_availability;
                tiles[index].unavailable_reason = reason;
            }
            Ok(FunnelAnalysisArtifactRecord {
                id: analysis.id,
                project_environment_id: analysis.project_environment_id,
                environment_revision: analysis.environment_revision,
                knowledge_grant_id: current_knowledge_grant_id,
                published_from_knowledge_grant_id: Some(analysis.source_knowledge_grant_id),
                graph_revision_ids: analysis.graph_revision_ids,
                source_agent: analysis.definition.source_agent,
                title: analysis.definition.title,
                question: analysis.definition.question,
                purpose: analysis.definition.purpose,
                timezone: analysis.definition.timezone,
                time_range: analysis.definition.time_range,
                segment_filters: analysis.definition.segment_filters,
                conversion_window_seconds: analysis.definition.conversion_window_seconds,
                denominator_semantics: analysis.definition.denominator_semantics,
                numerator_semantics: analysis.definition.numerator_semantics,
                deduplication_policy: analysis.definition.deduplication_policy,
                late_event_policy: analysis.definition.late_event_policy,
                steps: analysis.definition.steps,
                tiles,
                warnings: analysis.definition.warnings,
                freshness: availability,
                state: analysis.state,
                revision: analysis.revision,
                created_at: analysis.created_at,
                updated_at: analysis.updated_at,
            })
        })
        .collect()
}
