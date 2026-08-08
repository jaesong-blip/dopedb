//! Trusted Desktop transport for Project Knowledge source setup.
//!
//! The renderer receives source identity and revision evidence only. GitHub App
//! installation tokens remain in the control plane, and Local Folder paths stay
//! behind this native command boundary and the OS credential store.

use dopedb_protocol::{KnowledgeSourceProvider, KnowledgeSourceVisibility, SourceRevisionIdentity};
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
    delete_knowledge_source, list_environment_connections as list_remote_environment_connections,
    list_knowledge_github_repositories, list_knowledge_projects, publish_knowledge_graph,
    revoke_environment_connection as revoke_remote_environment_connection,
    CreateKnowledgeEnvironmentRequest, CreateKnowledgeProjectRequest, RemoteGithubRepository,
    RemoteKnowledgeProject,
};
use crate::kernel::identity::{AccountId, WorkspaceId};
use crate::state::AppState;
use crate::store::ActiveResourceScope;

use super::adapters::github::GithubSourceAdapter;
use super::application::{graph_path, search_graphs, KnowledgePathResult, KnowledgeSearchResult};
use super::domain::{
    validate_graph_publish, EnvironmentRiskClass, Project, ProjectEnvironment, SourceBindingDraft,
    SourceHealthState, SourceLocator, StoredKnowledgeScope,
};
use super::extractor::build_graph;
use super::ports::{
    KnowledgeGraphRepositoryPort, KnowledgeScopeRepositoryPort, SourceProviderAdapter,
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

fn selected_team_account(scope: &ActiveResourceScope) -> AppResult<AccountId> {
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
        health: if local_capability_available {
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
    list_knowledge_projects(account.as_str(), scope.workspace_id).await
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
    Ok(project_source(StoredKnowledgeScope {
        project,
        environment,
        binding: snapshot.binding,
    }))
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
    Ok(Some(project_source(StoredKnowledgeScope {
        project,
        environment,
        binding: snapshot.binding,
    })))
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
    state
        .knowledge_store()
        .active_set(project_environment_id)
        .await
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
