//! Trusted Desktop transport for Project Knowledge source setup.
//!
//! The renderer receives source identity and revision evidence only. GitHub App
//! installation tokens remain in the control plane, and Local Folder paths stay
//! behind this native command boundary and the OS credential store.

use dopedb_protocol::{
    DashboardKind as ProtocolDashboardKind, FunnelAnalysisArtifactRecord, FunnelAnalysisFreshness,
    FunnelMetricComposition, FunnelMetricOperation, FunnelTileAvailability, FunnelTileKind,
    KnowledgeSourceProvider, KnowledgeSourceVisibility, SourceRevisionIdentity,
};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::connection::keychain::{
    delete_knowledge_source_root, fetch_knowledge_source_root, store_knowledge_source_root,
};
use crate::error::{AppError, AppResult};
use crate::features::workspaces::adapters::control_plane::{
    begin_knowledge_github_install,
    bind_environment_connection as bind_remote_environment_connection, create_knowledge_project,
    decide_remote_knowledge_mapping, delete_knowledge_source, download_knowledge_graph,
    list_current_knowledge_grants,
    list_environment_connections as list_remote_environment_connections,
    list_knowledge_github_repositories, list_knowledge_projects, list_remote_knowledge_mappings,
    publish_funnel_analysis, publish_knowledge_graph, remote_funnel_analyses,
    revoke_environment_connection as revoke_remote_environment_connection,
    CreateKnowledgeEnvironmentRequest, CreateKnowledgeProjectRequest, RemoteGithubRepository,
    RemoteKnowledgeProject,
};
use crate::kernel::identity::{AccountId, ConnectionId, QueryExecutionId, WorkspaceId};
use crate::model::QueryResult;
use crate::state::AppState;
use crate::store::ActiveResourceScope;

use super::adapters::github::GithubSourceAdapter;
use super::application::{graph_path, search_graphs, KnowledgePathResult, KnowledgeSearchResult};
use super::domain::{
    validate_graph_publish, EnvironmentRiskClass, KnowledgeMappingProposal, MappingProposalState,
    Project, ProjectEnvironment, SourceBindingDraft, SourceHealthState, SourceLocator,
    StoredKnowledgeScope,
};
use super::extractor::build_graph;
use super::ports::{
    KnowledgeGrantPort, KnowledgeGraphRepositoryPort, KnowledgeMappingRepositoryPort,
    KnowledgeScopeRepositoryPort, SourceProviderAdapter,
};

use crate::features::dashboards::{
    DashboardDefinitionRunRequest, DashboardDraft, DashboardKind, DashboardRunError,
    DashboardVisualization,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeSourceProjection {
    source_id: Uuid,
    project_id: Uuid,
    project_name: String,
    project_environment_id: Uuid,
    environment_name: String,
    environment_revision: u64,
    risk_class: EnvironmentRiskClass,
    provider: KnowledgeSourceProvider,
    display_name: String,
    visibility: KnowledgeSourceVisibility,
    revision: SourceRevisionIdentity,
    health: SourceHealthState,
    local_capability_available: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateProjectInput {
    name: String,
    environments: Vec<CreateKnowledgeEnvironmentRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GithubSourceInput {
    project_id: Uuid,
    project_environment_id: Uuid,
    installation_id: Uuid,
    repository_id: String,
    repository: String,
    ref_name: String,
    display_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalFolderSourceInput {
    project_id: Uuid,
    project_environment_id: Uuid,
    display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeSyncProjection {
    source_id: Uuid,
    graph_revision_id: Uuid,
    parsed_files: u64,
    skipped_files: u64,
    changed_files: Vec<String>,
    node_count: usize,
    edge_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnvironmentConnectionProjection {
    id: Uuid,
    project_environment_id: Uuid,
    environment_revision: u64,
    connection_id: Option<Uuid>,
    remote_connection_id: Option<Uuid>,
    connection_revision: i64,
    current_connection_revision: i64,
    connection_name: String,
    role: String,
    alias: String,
    stale: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BindEnvironmentConnectionInput {
    project_environment_id: Uuid,
    connection_id: Uuid,
    role: String,
    alias: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMappingTarget {
    connection_id: Uuid,
    connection_revision: i64,
    database: String,
    qualified_target: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeMappingProjection {
    id: Uuid,
    project_environment_id: Uuid,
    graph_revision_id: Uuid,
    connection_id: Uuid,
    connection_revision: i64,
    database: String,
    schema_fingerprint: String,
    from_node_id: String,
    from_node_name: String,
    target_kind: String,
    target_identity: String,
    state: MappingProposalState,
    proposed_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KnowledgeMappingDecision {
    Approved,
    Rejected,
}

fn mapping_projection(
    proposal: KnowledgeMappingProposal,
    graph: &dopedb_protocol::GraphBuildArtifactV1,
) -> AppResult<KnowledgeMappingProjection> {
    let target: StoredMappingTarget = serde_json::from_str(&proposal.target_identity)
        .map_err(|_| AppError::Config("the stored Knowledge mapping target is invalid".into()))?;
    let from_node_name = graph
        .nodes
        .iter()
        .find(|node| node.id == proposal.from_node_id)
        .map(|node| node.qualified_name.clone())
        .ok_or_else(|| AppError::Config("the stored Knowledge mapping node is invalid".into()))?;
    Ok(KnowledgeMappingProjection {
        id: proposal.id,
        project_environment_id: proposal.project_environment_id,
        graph_revision_id: proposal.graph_revision_id,
        connection_id: target.connection_id,
        connection_revision: target.connection_revision,
        database: target.database,
        schema_fingerprint: proposal.schema_fingerprint,
        from_node_id: proposal.from_node_id,
        from_node_name,
        target_kind: proposal.target_kind,
        target_identity: target.qualified_target,
        state: proposal.state,
        proposed_at: proposal.proposed_at,
    })
}

pub(super) fn selected_team_account(scope: &ActiveResourceScope) -> AppResult<AccountId> {
    let value = scope.selected_account_id.as_ref().ok_or_else(|| {
        AppError::Config("Project Knowledge requires a selected workspace account".into())
    })?;
    AccountId::new(value.clone())
        .ok_or_else(|| AppError::Config("the selected workspace account is invalid".into()))
}

async fn active_remote_scope(state: &AppState) -> AppResult<(ActiveResourceScope, AccountId)> {
    let scope = state.knowledge_store().active_resource_scope().await?;
    let account = selected_team_account(&scope)?;
    Ok((scope, account))
}

fn domain_scope(
    workspace_id: WorkspaceId,
    projects: &[RemoteKnowledgeProject],
    project_id: Uuid,
    environment_id: Uuid,
) -> AppResult<(Project, ProjectEnvironment)> {
    let remote_project = projects
        .iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| AppError::NotFound("the Project Knowledge project".into()))?;
    let remote_environment = remote_project
        .environments
        .iter()
        .find(|environment| environment.id == environment_id)
        .ok_or_else(|| AppError::NotFound("the Project Knowledge environment".into()))?;
    Ok((
        Project {
            id: remote_project.id,
            workspace_id,
            name: remote_project.name.clone(),
            revision: remote_project.revision,
        },
        ProjectEnvironment {
            id: remote_environment.id,
            project_id: remote_project.id,
            name: remote_environment.name.clone(),
            risk_class: remote_environment.risk_class,
            revision: remote_environment.revision,
        },
    ))
}

fn project_source(scope: StoredKnowledgeScope) -> KnowledgeSourceProjection {
    let local_capability_available = scope.binding.provider != KnowledgeSourceProvider::LocalFolder
        || fetch_knowledge_source_root(scope.binding.source_id)
            .ok()
            .flatten()
            .is_some();
    KnowledgeSourceProjection {
        source_id: scope.binding.source_id,
        project_id: scope.project.id,
        project_name: scope.project.name,
        project_environment_id: scope.environment.id,
        environment_name: scope.environment.name,
        environment_revision: scope.environment.revision,
        risk_class: scope.environment.risk_class,
        provider: scope.binding.provider,
        display_name: scope.binding.display_name,
        visibility: scope.binding.visibility,
        revision: scope.binding.revision,
        health: if local_capability_available
            || scope.binding.visibility == KnowledgeSourceVisibility::SharedGraph
        {
            SourceHealthState::Ready
        } else {
            SourceHealthState::Stale
        },
        local_capability_available,
    }
}

fn unchanged_graph(
    previous_snapshot: Option<&super::domain::SourceSnapshot>,
    snapshot: &super::domain::SourceSnapshot,
    previous_artifact: Option<&dopedb_protocol::GraphBuildArtifactV1>,
) -> Option<dopedb_protocol::GraphBuildArtifactV1> {
    previous_snapshot
        .filter(|previous| {
            previous.source_revision_sha256 == snapshot.source_revision_sha256
                && previous.binding.source_id == snapshot.binding.source_id
        })
        .and_then(|_| previous_artifact)
        .filter(|artifact| artifact.binding.source_id == snapshot.binding.source_id)
        .cloned()
}

#[tauri::command]
pub(crate) async fn list_knowledge_projects_command(
    state: State<'_, AppState>,
) -> AppResult<Vec<RemoteKnowledgeProject>> {
    let (scope, account) = active_remote_scope(&state).await?;
    let projects = list_knowledge_projects(account.as_str(), scope.workspace_id).await?;
    sync_current_knowledge_access_with_projects(&state, &scope, &account, &projects).await?;
    Ok(projects)
}

pub(crate) async fn sync_current_knowledge_access(state: &AppState) -> AppResult<()> {
    let (scope, account) = active_remote_scope(state).await?;
    let projects = list_knowledge_projects(account.as_str(), scope.workspace_id).await?;
    sync_current_knowledge_access_with_projects(state, &scope, &account, &projects).await
}

async fn sync_current_knowledge_access_with_projects(
    state: &AppState,
    scope: &ActiveResourceScope,
    account: &AccountId,
    projects: &[RemoteKnowledgeProject],
) -> AppResult<()> {
    let grants = list_current_knowledge_grants(account.as_str(), scope.workspace_id).await?;
    for grant in &grants {
        let remote_project = projects
            .iter()
            .find(|project| project.id == grant.project_id)
            .ok_or_else(|| AppError::Network("Knowledge grant project is missing".into()))?;
        let remote_environment = remote_project
            .environments
            .iter()
            .find(|environment| environment.id == grant.project_environment_id)
            .filter(|environment| environment.revision == grant.environment_revision)
            .ok_or_else(|| AppError::Network("Knowledge grant environment is stale".into()))?;
        let project = Project {
            id: remote_project.id,
            workspace_id: WorkspaceId::from(scope.workspace_id),
            name: remote_project.name.clone(),
            revision: remote_project.revision,
        };
        let environment = ProjectEnvironment {
            id: remote_environment.id,
            project_id: remote_project.id,
            name: remote_environment.name.clone(),
            risk_class: remote_environment.risk_class,
            revision: remote_environment.revision,
        };
        for graph_scope in &grant.graph_scopes {
            let artifact = match state
                .knowledge_store()
                .by_revision(graph_scope.graph_revision_id)
                .await?
            {
                Some(artifact) => artifact,
                None => {
                    download_knowledge_graph(
                        account.as_str(),
                        scope.workspace_id,
                        grant.id,
                        graph_scope.source_id,
                        graph_scope.graph_revision_id,
                    )
                    .await?
                }
            };
            if artifact.binding.project_id != project.id
                || artifact.binding.project_environment_id != environment.id
                || artifact.environment_revision != environment.revision
                || artifact.binding.source_id != graph_scope.source_id
            {
                return Err(AppError::Network(
                    "Knowledge grant graph crossed its Project Environment".into(),
                ));
            }
            state
                .knowledge_store()
                .save_scope(
                    &project,
                    &environment,
                    &artifact.binding,
                    artifact.environment_revision,
                )
                .await?;
            state
                .knowledge_store()
                .import_granted_active_graph(&artifact)
                .await?;
        }
        state
            .knowledge_store()
            .retain_granted_environment_heads(environment.id, &grant.graph_revision_ids)
            .await?;
    }
    state
        .knowledge_store()
        .revoke_knowledge_grants_for_account(scope.workspace_id, account.as_str())
        .await?;
    for grant in grants {
        state
            .knowledge_store()
            .save_grant(&super::domain::KnowledgeGrant {
                id: grant.id,
                workspace_id: WorkspaceId::from(scope.workspace_id),
                account_id: account.clone(),
                project_id: grant.project_id,
                project_environment_id: grant.project_environment_id,
                environment_revision: grant.environment_revision,
                graph_revision_ids: grant.graph_revision_ids,
                expires_at: grant.expires_at,
            })
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn create_knowledge_project_command(
    state: State<'_, AppState>,
    input: CreateProjectInput,
) -> AppResult<RemoteKnowledgeProject> {
    let (scope, account) = active_remote_scope(&state).await?;
    create_knowledge_project(
        account.as_str(),
        scope.workspace_id,
        &CreateKnowledgeProjectRequest {
            name: input.name,
            environments: input.environments,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn begin_knowledge_github_install_command(
    state: State<'_, AppState>,
) -> AppResult<String> {
    let (scope, account) = active_remote_scope(&state).await?;
    begin_knowledge_github_install(account.as_str(), scope.workspace_id).await
}

#[tauri::command]
pub(crate) async fn list_knowledge_github_repositories_command(
    state: State<'_, AppState>,
) -> AppResult<Vec<RemoteGithubRepository>> {
    let (scope, account) = active_remote_scope(&state).await?;
    list_knowledge_github_repositories(account.as_str(), scope.workspace_id).await
}

#[tauri::command]
pub(crate) async fn connect_knowledge_github_source(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    input: GithubSourceInput,
) -> AppResult<KnowledgeSourceProjection> {
    let (scope, account) = active_remote_scope(&state).await?;
    let projects = list_knowledge_projects(account.as_str(), scope.workspace_id).await?;
    let (project, environment) = domain_scope(
        WorkspaceId::from(scope.workspace_id),
        &projects,
        input.project_id,
        input.project_environment_id,
    )?;
    let adapter = GithubSourceAdapter::new(account, project.workspace_id, environment.clone());
    let draft = SourceBindingDraft {
        source_id: Uuid::new_v4(),
        project_id: project.id,
        project_environment_id: environment.id,
        environment_revision: environment.revision,
        display_name: input.display_name,
        visibility: KnowledgeSourceVisibility::SharedGraph,
        locator: SourceLocator::Github {
            installation_id: input.installation_id,
            repository_id: input.repository_id,
            repository: input.repository,
            ref_name: input.ref_name,
        },
    };
    let binding = adapter.bind(&draft).await?;
    let snapshot = adapter.snapshot(&binding, None).await?;
    state
        .knowledge_store()
        .save_scope(
            &project,
            &environment,
            &snapshot.binding,
            snapshot.environment_revision,
        )
        .await?;
    state.knowledge_store().save_snapshot(&snapshot).await?;
    let projection = project_source(StoredKnowledgeScope {
        project,
        environment,
        binding: snapshot.binding,
    });
    let sync = sync_knowledge_source_inner(&state, projection.source_id).await;
    state.knowledge_watches.start(app, projection.source_id);
    sync?;
    Ok(projection)
}

#[tauri::command]
pub(crate) async fn connect_knowledge_local_folder(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    input: LocalFolderSourceInput,
) -> AppResult<Option<KnowledgeSourceProjection>> {
    use tauri_plugin_dialog::DialogExt;

    let (scope, account) = active_remote_scope(&state).await?;
    let projects = list_knowledge_projects(account.as_str(), scope.workspace_id).await?;
    let (project, environment) = domain_scope(
        WorkspaceId::from(scope.workspace_id),
        &projects,
        input.project_id,
        input.project_environment_id,
    )?;
    let Some(root) = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
    else {
        return Ok(None);
    };
    let source_id = Uuid::new_v4();
    let draft = SourceBindingDraft {
        source_id,
        project_id: project.id,
        project_environment_id: environment.id,
        environment_revision: environment.revision,
        display_name: input.display_name,
        visibility: KnowledgeSourceVisibility::LocalOnly,
        locator: SourceLocator::LocalFolder { root: root.clone() },
    };
    let binding = state
        .local_knowledge_sources
        .bind_for_environment(&draft, &environment)
        .await?;
    let snapshot = state
        .local_knowledge_sources
        .snapshot(&binding, None)
        .await?;
    if let Err(error) = store_knowledge_source_root(source_id, &root) {
        let _ = state.local_knowledge_sources.revoke(&binding).await;
        return Err(error);
    }
    if let Err(error) = state
        .knowledge_store()
        .save_scope(
            &project,
            &environment,
            &snapshot.binding,
            snapshot.environment_revision,
        )
        .await
    {
        let _ = delete_knowledge_source_root(source_id);
        let _ = state.local_knowledge_sources.revoke(&binding).await;
        return Err(error);
    }
    if let Err(error) = state.knowledge_store().save_snapshot(&snapshot).await {
        let _ = state.knowledge_store().remove_scope(source_id).await;
        let _ = delete_knowledge_source_root(source_id);
        let _ = state.local_knowledge_sources.revoke(&binding).await;
        return Err(error);
    }
    let projection = project_source(StoredKnowledgeScope {
        project,
        environment,
        binding: snapshot.binding,
    });
    let sync = sync_knowledge_source_inner(&state, projection.source_id).await;
    state
        .knowledge_watches
        .start(app.clone(), projection.source_id);
    sync?;
    Ok(Some(projection))
}

#[tauri::command]
pub(crate) async fn list_knowledge_sources(
    state: State<'_, AppState>,
) -> AppResult<Vec<KnowledgeSourceProjection>> {
    let scope = state.knowledge_store().active_resource_scope().await?;
    let sources = state.knowledge_store().scopes(scope.workspace_id).await?;
    Ok(sources.into_iter().map(project_source).collect())
}

#[tauri::command]
pub(crate) async fn revoke_knowledge_source(
    state: State<'_, AppState>,
    source_id: Uuid,
) -> AppResult<()> {
    state.knowledge_watches.stop(source_id);
    let scope = state.knowledge_store().active_resource_scope().await?;
    let source = state
        .knowledge_store()
        .scopes(scope.workspace_id)
        .await?
        .into_iter()
        .find(|candidate| candidate.binding.source_id == source_id)
        .ok_or_else(|| AppError::NotFound("the Project Knowledge source".into()))?;
    match source.binding.provider {
        KnowledgeSourceProvider::Github => {
            let account = selected_team_account(&scope)?;
            delete_knowledge_source(account.as_str(), scope.workspace_id, source_id).await?;
        }
        KnowledgeSourceProvider::LocalFolder => {
            let _ = state.local_knowledge_sources.revoke(&source.binding).await;
            delete_knowledge_source_root(source_id)?;
        }
    }
    state.knowledge_store().remove_scope(source_id).await
}

#[tauri::command]
pub(crate) async fn sync_knowledge_source(
    state: State<'_, AppState>,
    source_id: Uuid,
) -> AppResult<KnowledgeSyncProjection> {
    sync_knowledge_source_inner(&state, source_id).await
}

pub(super) async fn sync_knowledge_source_inner(
    state: &AppState,
    source_id: Uuid,
) -> AppResult<KnowledgeSyncProjection> {
    let active_scope = state.knowledge_store().active_resource_scope().await?;
    let stored = state
        .knowledge_store()
        .scopes(active_scope.workspace_id)
        .await?
        .into_iter()
        .find(|candidate| candidate.binding.source_id == source_id)
        .ok_or_else(|| AppError::NotFound("the Project Knowledge source".into()))?;
    let previous_artifact = state.knowledge_store().active_for_source(source_id).await?;
    let parent = previous_artifact
        .as_ref()
        .map(|artifact| artifact.graph_revision_id);
    let previous_snapshot = state.knowledge_store().source_snapshot(source_id).await?;
    let artifact = match stored.binding.provider {
        KnowledgeSourceProvider::Github => {
            let account = selected_team_account(&active_scope)?;
            let adapter = GithubSourceAdapter::new(
                account.clone(),
                stored.project.workspace_id,
                stored.environment.clone(),
            );
            adapter.restore(stored.binding.clone(), stored.environment.revision)?;
            let snapshot = adapter
                .snapshot(&stored.binding, previous_snapshot.as_ref())
                .await?;
            if let Some(artifact) = unchanged_graph(
                previous_snapshot.as_ref(),
                &snapshot,
                previous_artifact.as_ref(),
            ) {
                artifact
            } else {
                let artifact =
                    build_graph(&adapter, &snapshot, parent, previous_artifact.as_ref()).await?;
                validate_graph_publish(&artifact, &stored.environment)?;
                state.knowledge_store().stage(&artifact).await?;
                publish_knowledge_graph(account.as_str(), active_scope.workspace_id, &artifact)
                    .await?;
                state
                    .knowledge_store()
                    .save_scope(
                        &stored.project,
                        &stored.environment,
                        &snapshot.binding,
                        snapshot.environment_revision,
                    )
                    .await?;
                state.knowledge_store().save_snapshot(&snapshot).await?;
                artifact
            }
        }
        KnowledgeSourceProvider::LocalFolder => {
            let root = fetch_knowledge_source_root(source_id)?.ok_or_else(|| {
                AppError::NotFound("the Local Folder capability on this device".into())
            })?;
            state.local_knowledge_sources.restore(
                stored.binding.clone(),
                stored.environment.revision,
                root,
            )?;
            let snapshot = state
                .local_knowledge_sources
                .snapshot(&stored.binding, previous_snapshot.as_ref())
                .await?;
            if let Some(artifact) = unchanged_graph(
                previous_snapshot.as_ref(),
                &snapshot,
                previous_artifact.as_ref(),
            ) {
                artifact
            } else {
                let artifact = build_graph(
                    &state.local_knowledge_sources,
                    &snapshot,
                    parent,
                    previous_artifact.as_ref(),
                )
                .await?;
                validate_graph_publish(&artifact, &stored.environment)?;
                state.knowledge_store().stage(&artifact).await?;
                state
                    .knowledge_store()
                    .save_scope(
                        &stored.project,
                        &stored.environment,
                        &snapshot.binding,
                        snapshot.environment_revision,
                    )
                    .await?;
                state.knowledge_store().save_snapshot(&snapshot).await?;
                artifact
            }
        }
    };
    if parent != Some(artifact.graph_revision_id) {
        state.knowledge_store().activate(&artifact).await?;
    }
    Ok(KnowledgeSyncProjection {
        source_id,
        graph_revision_id: artifact.graph_revision_id,
        parsed_files: artifact.health.parsed_files,
        skipped_files: artifact.health.skipped_files,
        changed_files: artifact.changed_files,
        node_count: artifact.nodes.len(),
        edge_count: artifact.edges.len(),
    })
}

async fn active_workspace_graphs(
    state: &AppState,
    project_environment_id: Uuid,
) -> AppResult<Vec<dopedb_protocol::GraphBuildArtifactV1>> {
    sync_current_knowledge_access(state).await?;
    let active_scope = state.knowledge_store().active_resource_scope().await?;
    let allowed = state
        .knowledge_store()
        .scopes(active_scope.workspace_id)
        .await?
        .into_iter()
        .any(|scope| scope.environment.id == project_environment_id);
    if !allowed {
        return Err(AppError::NotFound(
            "the active workspace Project Environment".into(),
        ));
    }
    let account_id =
        active_scope
            .selected_account_id
            .as_deref()
            .ok_or_else(|| AppError::Blocked {
                reason: "Project Knowledge requires an exact member grant".into(),
            })?;
    let graphs = state
        .knowledge_store()
        .active_set(project_environment_id)
        .await?;
    let environment_revision = graphs
        .first()
        .map(|graph| graph.environment_revision)
        .ok_or_else(|| AppError::NotFound("an active Knowledge graph revision set".into()))?;
    let graph_revision_ids = graphs
        .iter()
        .map(|graph| graph.graph_revision_id)
        .collect::<Vec<_>>();
    if state
        .knowledge_store()
        .active_knowledge_grant(
            active_scope.workspace_id,
            account_id,
            project_environment_id,
            environment_revision,
            &graph_revision_ids,
        )
        .await?
        .is_none()
    {
        return Err(AppError::Blocked {
            reason: "this member has no current grant for the active Knowledge revision set".into(),
        });
    }
    Ok(graphs)
}

#[tauri::command]
pub(crate) async fn search_knowledge_graph(
    state: State<'_, AppState>,
    project_environment_id: Uuid,
    query: String,
    limit: Option<usize>,
) -> AppResult<KnowledgeSearchResult> {
    let graphs = active_workspace_graphs(&state, project_environment_id).await?;
    if graphs.is_empty() {
        return Err(AppError::NotFound(
            "an active Knowledge graph revision set".into(),
        ));
    }
    search_graphs(&graphs, &query, limit.unwrap_or(20))
}

#[tauri::command]
pub(crate) async fn list_funnel_analysis_artifacts(
    state: State<'_, AppState>,
    project_environment_id: Uuid,
) -> AppResult<Vec<FunnelAnalysisArtifactRecord>> {
    list_funnel_analysis_artifacts_inner(&state, project_environment_id).await
}

pub(crate) async fn list_funnel_analysis_artifacts_inner(
    state: &AppState,
    project_environment_id: Uuid,
) -> AppResult<Vec<FunnelAnalysisArtifactRecord>> {
    let graphs = active_workspace_graphs(state, project_environment_id).await?;
    let active_scope = state.knowledge_store().active_resource_scope().await?;
    let account_id =
        active_scope
            .selected_account_id
            .as_deref()
            .ok_or_else(|| AppError::Blocked {
                reason: "funnel analysis requires an exact member grant".into(),
            })?;
    let environment_revision = graphs
        .first()
        .map(|graph| graph.environment_revision)
        .ok_or_else(|| AppError::NotFound("an active Knowledge graph revision set".into()))?;
    let graph_revision_ids = graphs
        .iter()
        .map(|graph| graph.graph_revision_id)
        .collect::<Vec<_>>();
    let knowledge_grant_id = state
        .knowledge_store()
        .active_knowledge_grant(
            active_scope.workspace_id,
            account_id,
            project_environment_id,
            environment_revision,
            &graph_revision_ids,
        )
        .await?
        .ok_or_else(|| AppError::Blocked {
            reason: "this member has no current funnel analysis grant".into(),
        })?;
    if let Ok(remote) =
        remote_funnel_analyses(account_id, active_scope.workspace_id, knowledge_grant_id).await
    {
        for mut artifact in remote
            .into_iter()
            .filter(|artifact| artifact.project_environment_id == project_environment_id)
        {
            if artifact.environment_revision != environment_revision
                || artifact.graph_revision_ids != graph_revision_ids
            {
                artifact.freshness = dopedb_protocol::FunnelAnalysisFreshness::GraphDrift;
            }
            state
                .knowledge_store()
                .sync_remote_funnel_analysis(active_scope.workspace_id, account_id, &artifact)
                .await?;
        }
    }
    let mut artifacts = state
        .knowledge_store()
        .list_funnel_analysis_for_scope(
            active_scope.workspace_id,
            account_id,
            project_environment_id,
            environment_revision,
            knowledge_grant_id,
            &graph_revision_ids,
        )
        .await?;
    for artifact in &mut artifacts {
        revalidate_funnel_artifact(state, project_environment_id, artifact).await?;
    }
    Ok(artifacts)
}

async fn revalidate_funnel_artifact(
    state: &AppState,
    project_environment_id: Uuid,
    artifact: &mut FunnelAnalysisArtifactRecord,
) -> AppResult<()> {
    if artifact.freshness == FunnelAnalysisFreshness::GraphDrift {
        return Ok(());
    }
    let bindings = state
        .knowledge_store()
        .environment_connections(
            state
                .knowledge_store()
                .active_resource_scope()
                .await?
                .workspace_id,
            project_environment_id,
        )
        .await?;
    let mut freshness = FunnelAnalysisFreshness::Current;
    for tile in &mut artifact.tiles {
        if tile.definition.kind == FunnelTileKind::Markdown || tile.definition.composition.is_some()
        {
            continue;
        }
        let Some(dashboard) = tile.dashboard.as_ref() else {
            tile.availability = FunnelTileAvailability::MissingGrant;
            tile.unavailable_reason.get_or_insert_with(|| {
                "This member has no usable grant for the tile connection.".into()
            });
            if freshness == FunnelAnalysisFreshness::Current {
                freshness = FunnelAnalysisFreshness::Partial;
            }
            continue;
        };
        let binding = bindings
            .iter()
            .find(|binding| binding.connection_id == dashboard.connection_id);
        let Some(binding) = binding else {
            tile.availability = FunnelTileAvailability::MissingGrant;
            tile.unavailable_reason =
                Some("This device has no local binding for the tile connection.".into());
            if freshness == FunnelAnalysisFreshness::Current {
                freshness = FunnelAnalysisFreshness::Partial;
            }
            continue;
        };
        if tile.connection_revision != Some(binding.connection_revision)
            || binding.connection_revision != binding.current_connection_revision
        {
            tile.availability = FunnelTileAvailability::StaleDashboard;
            tile.unavailable_reason =
                Some("The Environment connection revision changed after publication.".into());
            freshness = FunnelAnalysisFreshness::SchemaDrift;
            continue;
        }
        if let Ok(current_dashboard) = state
            .knowledge_store()
            .get_dashboard(dashboard.id.into())
            .await
        {
            if tile.definition.expected_dashboard_revision != Some(current_dashboard.revision) {
                tile.availability = FunnelTileAvailability::StaleDashboard;
                tile.unavailable_reason =
                    Some("The saved dashboard revision changed after publication.".into());
                freshness = FunnelAnalysisFreshness::SchemaDrift;
                continue;
            }
        }
        tile.availability = FunnelTileAvailability::Ready;
        tile.unavailable_reason = None;
    }
    for index in 0..artifact.tiles.len() {
        let Some(composition) = artifact.tiles[index].definition.composition.as_ref() else {
            continue;
        };
        let inputs = composition
            .inputs
            .iter()
            .filter_map(|input| {
                artifact
                    .tiles
                    .iter()
                    .find(|tile| tile.definition.id == input.tile_id)
                    .map(|tile| tile.availability)
            })
            .collect::<Vec<_>>();
        let (availability, reason) = if inputs.len() != composition.inputs.len()
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
            freshness = FunnelAnalysisFreshness::SchemaDrift;
            (
                FunnelTileAvailability::StaleDashboard,
                Some("A composed metric input changed after publication.".into()),
            )
        } else if inputs
            .iter()
            .any(|input| *input == FunnelTileAvailability::MissingGrant)
        {
            if freshness == FunnelAnalysisFreshness::Current {
                freshness = FunnelAnalysisFreshness::Partial;
            }
            (
                FunnelTileAvailability::MissingGrant,
                Some("A composed metric input is outside this member's grant.".into()),
            )
        } else {
            (FunnelTileAvailability::Ready, None)
        };
        artifact.tiles[index].availability = availability;
        artifact.tiles[index].unavailable_reason = reason;
    }
    artifact.freshness = freshness;
    Ok(())
}

#[tauri::command]
pub(crate) async fn publish_funnel_analysis_artifact(
    state: State<'_, AppState>,
    project_environment_id: Uuid,
    artifact_id: Uuid,
    production_confirmed: bool,
) -> AppResult<FunnelAnalysisArtifactRecord> {
    state.services.workspace.refresh_dashboards().await?;
    let graphs = active_workspace_graphs(&state, project_environment_id).await?;
    let active_scope = state.knowledge_store().active_resource_scope().await?;
    let account_id =
        active_scope
            .selected_account_id
            .as_deref()
            .ok_or_else(|| AppError::Blocked {
                reason: "publishing funnel analysis requires an exact member account".into(),
            })?;
    let knowledge_scope = state
        .knowledge_store()
        .scopes(active_scope.workspace_id)
        .await?
        .into_iter()
        .find(|scope| scope.environment.id == project_environment_id)
        .ok_or_else(|| AppError::NotFound("the Project Environment".into()))?;
    if knowledge_scope.environment.risk_class == EnvironmentRiskClass::Production
        && !production_confirmed
    {
        return Err(AppError::Blocked {
            reason: "Production analysis publication requires explicit confirmation".into(),
        });
    }
    let environment_revision = knowledge_scope.environment.revision;
    let graph_revision_ids = graphs
        .iter()
        .map(|graph| graph.graph_revision_id)
        .collect::<Vec<_>>();
    let knowledge_grant_id = state
        .knowledge_store()
        .active_knowledge_grant(
            active_scope.workspace_id,
            account_id,
            project_environment_id,
            environment_revision,
            &graph_revision_ids,
        )
        .await?
        .ok_or_else(|| AppError::Blocked {
            reason: "the exact member Knowledge grant expired before publication".into(),
        })?;
    let artifact = state
        .knowledge_store()
        .list_funnel_analysis_for_scope(
            active_scope.workspace_id,
            account_id,
            project_environment_id,
            environment_revision,
            knowledge_grant_id,
            &graph_revision_ids,
        )
        .await?
        .into_iter()
        .find(|artifact| artifact.id == artifact_id)
        .ok_or_else(|| AppError::NotFound("the current funnel analysis draft".into()))?;
    let connections = state
        .knowledge_store()
        .environment_connections(active_scope.workspace_id, project_environment_id)
        .await?;
    let published = publish_funnel_analysis(
        account_id,
        active_scope.workspace_id,
        &artifact,
        &connections,
    )
    .await?;
    state
        .knowledge_store()
        .mark_funnel_analysis_published(
            active_scope.workspace_id,
            account_id,
            artifact.id,
            published.revision,
        )
        .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FunnelTileRunRequest {
    pub(crate) tile_id: String,
    pub(crate) query_id: QueryExecutionId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FunnelTileRunStatus {
    Ok,
    MissingGrant,
    Stale,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FunnelTileRunProjection {
    pub(crate) tile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) query_id: Option<QueryExecutionId>,
    pub(crate) status: FunnelTileRunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FunnelAnalysisRunProjection {
    pub(crate) artifact_id: Uuid,
    pub(crate) artifact_revision: i64,
    pub(crate) started_at: chrono::DateTime<chrono::Utc>,
    pub(crate) completed_at: chrono::DateTime<chrono::Utc>,
    pub(crate) tiles: Vec<FunnelTileRunProjection>,
}

fn dashboard_kind(kind: ProtocolDashboardKind) -> DashboardKind {
    match kind {
        ProtocolDashboardKind::Auto => DashboardKind::Auto,
        ProtocolDashboardKind::Metric => DashboardKind::Metric,
        ProtocolDashboardKind::Line => DashboardKind::Line,
        ProtocolDashboardKind::Bar => DashboardKind::Bar,
        ProtocolDashboardKind::Table => DashboardKind::Table,
    }
}

fn funnel_metric_value(
    results: &std::collections::HashMap<String, QueryResult>,
    tile_id: &str,
    column: &str,
) -> Result<f64, String> {
    let result = results
        .get(tile_id)
        .ok_or_else(|| format!("input tile {tile_id} did not produce a current result"))?;
    let column_index = result
        .columns
        .iter()
        .position(|candidate| candidate == column)
        .ok_or_else(|| format!("input tile {tile_id} has no column named {column}"))?;
    let value = result
        .rows
        .first()
        .and_then(|row| row.get(column_index))
        .ok_or_else(|| format!("input tile {tile_id} returned no scalar row"))?;
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.parse::<f64>().ok()))
        .filter(|value| value.is_finite())
        .ok_or_else(|| format!("input tile {tile_id} column {column} is not numeric"))
}

fn compose_funnel_metric(
    composition: &FunnelMetricComposition,
    results: &std::collections::HashMap<String, QueryResult>,
) -> Result<QueryResult, String> {
    let values = composition
        .inputs
        .iter()
        .map(|input| {
            funnel_metric_value(results, &input.tile_id, &input.column)
                .map(|value| (input.label.clone(), value))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (columns, rows) = match composition.operation {
        FunnelMetricOperation::Funnel => {
            let denominator = values.first().map(|(_, value)| *value).unwrap_or_default();
            let rows = values
                .into_iter()
                .map(|(label, value)| {
                    let conversion = if denominator == 0.0 {
                        serde_json::Value::Null
                    } else {
                        serde_json::json!(value / denominator)
                    };
                    vec![
                        serde_json::json!(label),
                        serde_json::json!(value),
                        conversion,
                    ]
                })
                .collect::<Vec<_>>();
            (
                vec!["step".into(), "value".into(), "conversion".into()],
                rows,
            )
        }
        FunnelMetricOperation::Ratio => {
            let denominator = values[0].1;
            if denominator == 0.0 {
                return Err("the ratio denominator is zero".into());
            }
            (
                vec!["ratio".into()],
                vec![vec![serde_json::json!(values[1].1 / denominator)]],
            )
        }
        FunnelMetricOperation::Sum => (
            vec!["sum".into()],
            vec![vec![serde_json::json!(values
                .iter()
                .map(|(_, value)| value)
                .sum::<f64>())]],
        ),
        FunnelMetricOperation::Difference => (
            vec!["difference".into()],
            vec![vec![serde_json::json!(values[0].1 - values[1].1)]],
        ),
    };
    Ok(QueryResult {
        row_count: rows.len(),
        columns,
        rows,
        truncated: false,
        duration_ms: 0,
    })
}

/// Re-runs a published definition with the current member's exact local grants.
/// Results remain process-local and are never added to the shared artifact.
#[tauri::command]
pub(crate) async fn run_funnel_analysis_artifact(
    state: State<'_, AppState>,
    project_environment_id: Uuid,
    artifact_id: Uuid,
    tile_requests: Vec<FunnelTileRunRequest>,
) -> AppResult<FunnelAnalysisRunProjection> {
    run_funnel_analysis_artifact_inner(&state, project_environment_id, artifact_id, tile_requests)
        .await
}

pub(crate) async fn run_funnel_analysis_artifact_inner(
    state: &AppState,
    project_environment_id: Uuid,
    artifact_id: Uuid,
    tile_requests: Vec<FunnelTileRunRequest>,
) -> AppResult<FunnelAnalysisRunProjection> {
    if tile_requests.is_empty() || tile_requests.len() > dopedb_protocol::MAX_FUNNEL_TILES {
        return Err(AppError::Config(
            "a funnel analysis run requires between 1 and 32 tile requests".into(),
        ));
    }
    let mut requested_tiles = std::collections::HashMap::with_capacity(tile_requests.len());
    let mut query_ids = std::collections::HashSet::with_capacity(tile_requests.len());
    for request in tile_requests {
        if request.tile_id.trim().is_empty()
            || requested_tiles
                .insert(request.tile_id.clone(), request.query_id)
                .is_some()
            || !query_ids.insert(request.query_id)
        {
            return Err(AppError::Config(
                "tile and query ids must be non-empty and unique for each run".into(),
            ));
        }
    }

    let graphs = active_workspace_graphs(&state, project_environment_id).await?;
    let active_scope = state.knowledge_store().active_resource_scope().await?;
    let account_id =
        active_scope
            .selected_account_id
            .as_deref()
            .ok_or_else(|| AppError::Blocked {
                reason: "running funnel analysis requires an exact member account".into(),
            })?;
    let environment_revision = graphs
        .first()
        .map(|graph| graph.environment_revision)
        .ok_or_else(|| AppError::NotFound("an active Knowledge graph revision set".into()))?;
    let graph_revision_ids = graphs
        .iter()
        .map(|graph| graph.graph_revision_id)
        .collect::<Vec<_>>();
    let knowledge_grant_id = state
        .knowledge_store()
        .active_knowledge_grant(
            active_scope.workspace_id,
            account_id,
            project_environment_id,
            environment_revision,
            &graph_revision_ids,
        )
        .await?
        .ok_or_else(|| AppError::Blocked {
            reason: "the current member has no exact grant for this analysis".into(),
        })?;
    let mut artifact = state
        .knowledge_store()
        .list_funnel_analysis_for_scope(
            active_scope.workspace_id,
            account_id,
            project_environment_id,
            environment_revision,
            knowledge_grant_id,
            &graph_revision_ids,
        )
        .await?
        .into_iter()
        .find(|artifact| artifact.id == artifact_id)
        .ok_or_else(|| AppError::NotFound("the current funnel analysis".into()))?;
    revalidate_funnel_artifact(&state, project_environment_id, &mut artifact).await?;
    if matches!(
        artifact.freshness,
        FunnelAnalysisFreshness::GraphDrift | FunnelAnalysisFreshness::SchemaDrift
    ) {
        return Err(AppError::Blocked {
            reason: "the analysis definition drifted; review and republish it before running"
                .into(),
        });
    }

    let expected_query_tiles = artifact
        .tiles
        .iter()
        .filter(|tile| tile.dashboard.is_some())
        .map(|tile| tile.definition.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    if requested_tiles.len() != expected_query_tiles.len()
        || requested_tiles
            .keys()
            .any(|tile_id| !expected_query_tiles.contains(tile_id.as_str()))
    {
        return Err(AppError::Config(
            "the run must identify every query tile in this analysis revision".into(),
        ));
    }
    let requested_count = requested_tiles.len();
    let selected_tiles = artifact
        .tiles
        .iter()
        .filter_map(|tile| {
            requested_tiles
                .remove(&tile.definition.id)
                .map(|query_id| (tile.clone(), query_id))
        })
        .collect::<Vec<_>>();
    if !requested_tiles.is_empty() || selected_tiles.len() != requested_count {
        return Err(AppError::Config(
            "the run contains a tile that is not part of this analysis revision".into(),
        ));
    }

    let dashboard_service = state.services.dashboard.clone();
    let started_at = chrono::Utc::now();
    let mut tiles = stream::iter(selected_tiles.into_iter().enumerate().map(
        |(index, (tile, query_id))| {
            let dashboard_service = dashboard_service.clone();
            async move {
                let unavailable = match tile.availability {
                    FunnelTileAvailability::MissingGrant => Some(FunnelTileRunStatus::MissingGrant),
                    FunnelTileAvailability::StaleDashboard => Some(FunnelTileRunStatus::Stale),
                    FunnelTileAvailability::Error => Some(FunnelTileRunStatus::Error),
                    FunnelTileAvailability::Ready => None,
                };
                if let Some(status) = unavailable {
                    return (
                        index,
                        FunnelTileRunProjection {
                            tile_id: tile.definition.id,
                            query_id: Some(query_id),
                            status,
                            result: None,
                            error: tile.unavailable_reason,
                        },
                    );
                }
                if tile.definition.kind == FunnelTileKind::Markdown {
                    return (
                        index,
                        FunnelTileRunProjection {
                            tile_id: tile.definition.id,
                            query_id: Some(query_id),
                            status: FunnelTileRunStatus::Error,
                            result: None,
                            error: Some("markdown tiles do not execute a database query".into()),
                        },
                    );
                }
                let Some(dashboard) = tile.dashboard else {
                    return (
                        index,
                        FunnelTileRunProjection {
                            tile_id: tile.definition.id,
                            query_id: Some(query_id),
                            status: FunnelTileRunStatus::Error,
                            result: None,
                            error: Some(
                                "the shared tile has no executable dashboard definition".into(),
                            ),
                        },
                    );
                };
                let Some(connection_revision) = tile.connection_revision else {
                    return (
                        index,
                        FunnelTileRunProjection {
                            tile_id: tile.definition.id,
                            query_id: Some(query_id),
                            status: FunnelTileRunStatus::Stale,
                            result: None,
                            error: Some("the shared tile has no pinned connection revision".into()),
                        },
                    );
                };
                let request = DashboardDefinitionRunRequest {
                    draft: DashboardDraft {
                        connection_id: ConnectionId::from(dashboard.connection_id),
                        title: dashboard.title,
                        description: dashboard.description,
                        sql: dashboard.sql,
                        visualization: DashboardVisualization {
                            version: dashboard.visualization.version,
                            kind: dashboard_kind(dashboard.visualization.kind),
                            x_column: dashboard.visualization.x_column,
                            y_columns: dashboard.visualization.y_columns,
                        },
                    },
                    expected_connection_revision: connection_revision,
                    query_id: Some(query_id),
                };
                match dashboard_service.run_definition(request).await {
                    Ok(receipt) => (
                        index,
                        FunnelTileRunProjection {
                            tile_id: tile.definition.id,
                            query_id: Some(query_id),
                            status: FunnelTileRunStatus::Ok,
                            result: serde_json::to_value(receipt).ok(),
                            error: None,
                        },
                    ),
                    Err(error) => (
                        index,
                        FunnelTileRunProjection {
                            tile_id: tile.definition.id,
                            query_id: Some(query_id),
                            status: FunnelTileRunStatus::Error,
                            result: None,
                            error: Some(DashboardRunError::into_error(error).to_string()),
                        },
                    ),
                }
            }
        },
    ))
    .buffer_unordered(3)
    .collect::<Vec<_>>()
    .await;
    tiles.sort_by_key(|(index, _)| *index);
    let mut projections = tiles.into_iter().map(|(_, tile)| tile).collect::<Vec<_>>();
    let current_results = projections
        .iter()
        .filter(|tile| matches!(tile.status, FunnelTileRunStatus::Ok))
        .filter_map(|tile| {
            tile.result
                .as_ref()
                .and_then(|result| serde_json::from_value::<QueryResult>(result.clone()).ok())
                .map(|result| (tile.tile_id.clone(), result))
        })
        .collect::<std::collections::HashMap<_, _>>();
    for tile in artifact.tiles.iter().filter(|tile| {
        tile.definition.kind != FunnelTileKind::Markdown
            && tile.dashboard.is_none()
            && tile.definition.composition.is_none()
    }) {
        let status = match tile.availability {
            FunnelTileAvailability::MissingGrant => FunnelTileRunStatus::MissingGrant,
            FunnelTileAvailability::StaleDashboard => FunnelTileRunStatus::Stale,
            FunnelTileAvailability::Ready | FunnelTileAvailability::Error => {
                FunnelTileRunStatus::Error
            }
        };
        projections.push(FunnelTileRunProjection {
            tile_id: tile.definition.id.clone(),
            query_id: None,
            status,
            result: None,
            error: tile
                .unavailable_reason
                .clone()
                .or_else(|| Some("the tile has no executable definition for this member".into())),
        });
    }
    for tile in artifact
        .tiles
        .iter()
        .filter(|tile| tile.definition.composition.is_some())
    {
        let unavailable = match tile.availability {
            FunnelTileAvailability::MissingGrant => Some(FunnelTileRunStatus::MissingGrant),
            FunnelTileAvailability::StaleDashboard => Some(FunnelTileRunStatus::Stale),
            FunnelTileAvailability::Error => Some(FunnelTileRunStatus::Error),
            FunnelTileAvailability::Ready => None,
        };
        if let Some(status) = unavailable {
            projections.push(FunnelTileRunProjection {
                tile_id: tile.definition.id.clone(),
                query_id: None,
                status,
                result: None,
                error: tile.unavailable_reason.clone(),
            });
            continue;
        }
        let composition = tile
            .definition
            .composition
            .as_ref()
            .expect("filtered composed tile");
        match compose_funnel_metric(composition, &current_results) {
            Ok(result) => projections.push(FunnelTileRunProjection {
                tile_id: tile.definition.id.clone(),
                query_id: None,
                status: FunnelTileRunStatus::Ok,
                result: serde_json::to_value(result).ok(),
                error: None,
            }),
            Err(error) => projections.push(FunnelTileRunProjection {
                tile_id: tile.definition.id.clone(),
                query_id: None,
                status: FunnelTileRunStatus::Error,
                result: None,
                error: Some(error),
            }),
        }
    }
    Ok(FunnelAnalysisRunProjection {
        artifact_id: artifact.id,
        artifact_revision: artifact.revision,
        started_at,
        completed_at: chrono::Utc::now(),
        tiles: projections,
    })
}

#[tauri::command]
pub(crate) async fn find_knowledge_graph_path(
    state: State<'_, AppState>,
    project_environment_id: Uuid,
    from_node_id: String,
    to_node_id: String,
) -> AppResult<KnowledgePathResult> {
    let graphs = active_workspace_graphs(&state, project_environment_id).await?;
    let graph = graphs
        .iter()
        .find(|graph| {
            graph.nodes.iter().any(|node| node.id == from_node_id)
                && graph.nodes.iter().any(|node| node.id == to_node_id)
        })
        .ok_or_else(|| AppError::NotFound("a Knowledge graph containing both endpoints".into()))?;
    graph_path(graph, &from_node_id, &to_node_id)
}

#[tauri::command]
pub(crate) async fn list_knowledge_mappings(
    state: State<'_, AppState>,
    project_environment_id: Uuid,
) -> AppResult<Vec<KnowledgeMappingProjection>> {
    let graphs = active_workspace_graphs(&state, project_environment_id).await?;
    let active_scope = state.knowledge_store().active_resource_scope().await?;
    if let Some(account_id) = active_scope.selected_account_id.as_deref() {
        for mapping in list_remote_knowledge_mappings(account_id, active_scope.workspace_id).await?
        {
            if mapping.project_environment_id == project_environment_id
                && graphs
                    .iter()
                    .any(|graph| graph.graph_revision_id == mapping.graph_revision_id)
            {
                state
                    .knowledge_store()
                    .sync_remote_knowledge_mapping(&mapping)
                    .await?;
            }
        }
    }
    let mut result = Vec::new();
    for graph in graphs {
        let proposals = state
            .knowledge_store()
            .mappings_for_revision(project_environment_id, graph.graph_revision_id)
            .await?;
        for proposal in proposals {
            result.push(mapping_projection(proposal, &graph)?);
        }
    }
    result.sort_by(|left, right| {
        right
            .proposed_at
            .cmp(&left.proposed_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(result)
}

#[tauri::command]
pub(crate) async fn decide_knowledge_mapping(
    state: State<'_, AppState>,
    project_environment_id: Uuid,
    proposal_id: Uuid,
    expected_graph_revision_id: Uuid,
    decision: KnowledgeMappingDecision,
) -> AppResult<()> {
    let graphs = active_workspace_graphs(&state, project_environment_id).await?;
    if !graphs
        .iter()
        .any(|graph| graph.graph_revision_id == expected_graph_revision_id)
    {
        return Err(AppError::Blocked {
            reason: "the Knowledge mapping proposal no longer belongs to the active graph".into(),
        });
    }
    let state_value = match decision {
        KnowledgeMappingDecision::Approved => MappingProposalState::Approved,
        KnowledgeMappingDecision::Rejected => MappingProposalState::Rejected,
    };
    let active_scope = state.knowledge_store().active_resource_scope().await?;
    if let Some(account_id) = active_scope.selected_account_id.as_deref() {
        decide_remote_knowledge_mapping(
            account_id,
            active_scope.workspace_id,
            proposal_id,
            expected_graph_revision_id,
            state_value,
        )
        .await?;
    }
    state
        .knowledge_store()
        .decide_mapping(proposal_id, expected_graph_revision_id, state_value)
        .await
}

#[tauri::command]
pub(crate) async fn list_knowledge_environment_connections(
    state: State<'_, AppState>,
    project_environment_id: Uuid,
) -> AppResult<Vec<EnvironmentConnectionProjection>> {
    let scope = state.knowledge_store().active_resource_scope().await?;
    if let Some(account) = scope.selected_account_id.as_deref() {
        let remote = list_remote_environment_connections(
            account,
            scope.workspace_id,
            project_environment_id,
        )
        .await?;
        let mut projections = Vec::with_capacity(remote.len());
        for binding in remote {
            let local_connection_id = state
                .knowledge_store()
                .local_connection_id_for_remote(scope.workspace_id, binding.connection_id)
                .await?;
            if let Some(local_connection_id) = local_connection_id {
                if let Ok(connection) = state
                    .knowledge_store()
                    .pin_connection_for_read(local_connection_id)
                    .await
                {
                    let _ = state
                        .knowledge_store()
                        .bind_environment_connection(
                            binding.id,
                            &connection,
                            project_environment_id,
                            &binding.role,
                            &binding.alias,
                        )
                        .await;
                }
            }
            projections.push(EnvironmentConnectionProjection {
                id: binding.id,
                project_environment_id: binding.project_environment_id,
                environment_revision: binding.environment_revision,
                connection_id: local_connection_id,
                remote_connection_id: Some(binding.connection_id),
                connection_revision: binding.connection_revision,
                current_connection_revision: binding.current_connection_revision,
                connection_name: binding.connection_name,
                role: binding.role,
                alias: binding.alias,
                stale: binding.stale,
            });
        }
        return Ok(projections);
    }
    let bindings = state
        .knowledge_store()
        .environment_connections(scope.workspace_id, project_environment_id)
        .await?;
    Ok(bindings
        .into_iter()
        .map(|binding| EnvironmentConnectionProjection {
            id: binding.id,
            project_environment_id: binding.project_environment_id,
            environment_revision: binding.environment_revision,
            connection_id: Some(binding.connection_id),
            remote_connection_id: None,
            connection_revision: binding.connection_revision,
            current_connection_revision: binding.current_connection_revision,
            connection_name: binding.connection_name,
            role: binding.role,
            alias: binding.alias,
            stale: binding.connection_revision != binding.current_connection_revision,
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn bind_knowledge_environment_connection(
    state: State<'_, AppState>,
    input: BindEnvironmentConnectionInput,
) -> AppResult<EnvironmentConnectionProjection> {
    let connection = state
        .knowledge_store()
        .pin_connection_for_read(input.connection_id)
        .await?;
    let proposed_binding_id = Uuid::new_v4();
    let binding_id = if let Some(account) = connection.scope.selected_account_id.as_deref() {
        let remote_connection_id = state
            .knowledge_store()
            .remote_connection_id(&connection)
            .await?
            .ok_or_else(|| AppError::Blocked {
                reason: "only a shared workspace connection can be bound to a shared Environment"
                    .into(),
            })?;
        bind_remote_environment_connection(
            account,
            connection.scope.workspace_id,
            input.project_environment_id,
            proposed_binding_id,
            remote_connection_id,
            &input.role,
            &input.alias,
        )
        .await?
        .id
    } else {
        proposed_binding_id
    };
    let binding = state
        .knowledge_store()
        .bind_environment_connection(
            binding_id,
            &connection,
            input.project_environment_id,
            &input.role,
            &input.alias,
        )
        .await?;
    Ok(EnvironmentConnectionProjection {
        id: binding.id,
        project_environment_id: binding.project_environment_id,
        environment_revision: binding.environment_revision,
        connection_id: Some(binding.connection_id),
        remote_connection_id: state
            .knowledge_store()
            .remote_connection_id(&connection)
            .await?,
        connection_revision: binding.connection_revision,
        current_connection_revision: binding.current_connection_revision,
        connection_name: binding.connection_name,
        role: binding.role,
        alias: binding.alias,
        stale: binding.connection_revision != binding.current_connection_revision,
    })
}

#[tauri::command]
pub(crate) async fn revoke_knowledge_environment_connection(
    state: State<'_, AppState>,
    project_environment_id: Uuid,
    binding_id: Uuid,
) -> AppResult<()> {
    let scope = state.knowledge_store().active_resource_scope().await?;
    if let Some(account) = scope.selected_account_id.as_deref() {
        revoke_remote_environment_connection(
            account,
            scope.workspace_id,
            project_environment_id,
            binding_id,
        )
        .await?;
    }
    state
        .knowledge_store()
        .revoke_environment_connection(scope.workspace_id, binding_id)
        .await
}
