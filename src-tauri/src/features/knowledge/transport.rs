//! Trusted Desktop transport for Project Knowledge source setup.
//!
//! The renderer receives source identity and revision evidence only. GitHub App
//! installation tokens remain in the control plane, and Local Folder paths stay
//! behind this native command boundary and the OS credential store.

use dopedb_protocol::{
    KnowledgeSourceBindingV1, KnowledgeSourceProvider, KnowledgeSourceVisibility,
    SourceRevisionIdentity,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::connection::keychain::{
    delete_knowledge_source_root, fetch_knowledge_source_root, store_knowledge_source_root,
};
use crate::error::{AppError, AppResult};
use crate::features::workspaces::adapters::control_plane::{
    begin_knowledge_github_install,
    bind_environment_connection as bind_remote_environment_connection,
    create_current_knowledge_grant,
    create_knowledge_environment as create_remote_knowledge_environment, create_knowledge_project,
    decide_remote_knowledge_mapping, delete_knowledge_source, download_knowledge_graph,
    ensure_personal_knowledge_scope, list_current_knowledge_grants,
    list_environment_connections as list_remote_environment_connections,
    list_knowledge_github_repositories, list_knowledge_projects, list_remote_knowledge_mappings,
    list_remote_knowledge_sources, request_knowledge_source_sync,
    revoke_environment_connection as revoke_remote_environment_connection,
    AppendKnowledgeEnvironmentRequest, CreateKnowledgeEnvironmentRequest,
    CreateKnowledgeProjectRequest, RemoteGithubRepository, RemoteKnowledgeEnvironment,
    RemoteKnowledgeGrant, RemoteKnowledgeProject, RemoteKnowledgeSource,
};
use crate::features::workspaces::WorkspaceKind;
use crate::kernel::identity::{AccountId, WorkspaceId};
use crate::state::AppState;
use crate::store::ActiveResourceScope;

use super::adapters::github::GithubSourceControlPlane;
use super::application::{graph_path, search_graphs, KnowledgePathResult, KnowledgeSearchResult};
use super::domain::{
    validate_graph_publish, EnvironmentRiskClass, KnowledgeMappingProposal, MappingProposalState,
    Project, ProjectDefinition, ProjectEnvironment, SourceBindingDraft, SourceHealthState,
    SourceLocator, StoredKnowledgeScope,
};
use super::extractor::build_graph;
use super::ports::{
    KnowledgeGrantPort, KnowledgeGraphRepositoryPort, KnowledgeMappingRepositoryPort,
    KnowledgeScopeRepositoryPort, LocalKnowledgeSourcePort,
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
    graph_revision_id: Option<Uuid>,
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
pub(crate) struct CreateEnvironmentInput {
    project_id: Uuid,
    name: String,
    risk_class: EnvironmentRiskClass,
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
    state: SourceHealthState,
    graph_revision_id: Option<Uuid>,
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
    if scope.workspace_kind != WorkspaceKind::Team {
        return Err(AppError::Config(
            "Project Knowledge remote access requires a Team workspace".into(),
        ));
    }
    let value = scope.selected_account_id.as_ref().ok_or_else(|| {
        AppError::Config("Project Knowledge requires a selected workspace account".into())
    })?;
    AccountId::new(value.clone())
        .ok_or_else(|| AppError::Config("the selected workspace account is invalid".into()))
}

fn selected_remote_account(scope: &ActiveResourceScope) -> AppResult<AccountId> {
    let value = scope.selected_account_id.as_ref().ok_or_else(|| {
        AppError::Config("Sign in to connect GitHub to Personal Workspace".into())
    })?;
    AccountId::new(value.clone())
        .ok_or_else(|| AppError::Config("the selected workspace account is invalid".into()))
}

struct ActiveRemoteKnowledgeScope {
    local_scope: ActiveResourceScope,
    account: AccountId,
    remote_workspace_id: Uuid,
    personal_member_id: Option<String>,
    projects: Vec<RemoteKnowledgeProject>,
}

async fn active_remote_scope(state: &AppState) -> AppResult<ActiveRemoteKnowledgeScope> {
    let scope = state.knowledge_store().active_resource_scope().await?;
    let account = selected_remote_account(&scope)?;
    let projects = active_project_inventory(state, &scope).await?;
    if scope.workspace_kind == WorkspaceKind::Personal {
        let remote = ensure_personal_knowledge_scope(account.as_str(), &projects).await?;
        return Ok(ActiveRemoteKnowledgeScope {
            local_scope: scope,
            account,
            remote_workspace_id: remote.workspace_id,
            personal_member_id: Some(remote.member_id),
            projects,
        });
    }
    Ok(ActiveRemoteKnowledgeScope {
        remote_workspace_id: scope.workspace_id,
        local_scope: scope,
        account,
        personal_member_id: None,
        projects,
    })
}

fn project_definition(workspace_id: Uuid, project: &RemoteKnowledgeProject) -> ProjectDefinition {
    ProjectDefinition {
        project: Project {
            id: project.id,
            workspace_id: WorkspaceId::from(workspace_id),
            name: project.name.clone(),
            revision: project.revision,
        },
        environments: project
            .environments
            .iter()
            .map(|environment| ProjectEnvironment {
                id: environment.id,
                project_id: project.id,
                name: environment.name.clone(),
                risk_class: environment.risk_class,
                revision: environment.revision,
            })
            .collect(),
    }
}

fn project_projection(definition: ProjectDefinition) -> RemoteKnowledgeProject {
    RemoteKnowledgeProject {
        id: definition.project.id,
        name: definition.project.name,
        revision: definition.project.revision,
        environments: definition
            .environments
            .into_iter()
            .map(|environment| RemoteKnowledgeEnvironment {
                id: environment.id,
                name: environment.name,
                risk_class: environment.risk_class,
                revision: environment.revision,
            })
            .collect(),
    }
}

async fn active_project_inventory(
    state: &AppState,
    scope: &ActiveResourceScope,
) -> AppResult<Vec<RemoteKnowledgeProject>> {
    if scope.workspace_kind == WorkspaceKind::Personal {
        return state
            .knowledge_store()
            .knowledge_projects(scope.workspace_id)
            .await
            .map(|projects| projects.into_iter().map(project_projection).collect());
    };
    let account = selected_team_account(scope)?;
    let projects = list_knowledge_projects(account.as_str(), scope.workspace_id).await?;
    for project in &projects {
        state
            .knowledge_store()
            .save_knowledge_project(&project_definition(scope.workspace_id, project))
            .await?;
    }
    Ok(projects)
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

fn remote_github_binding(source: &RemoteKnowledgeSource) -> AppResult<KnowledgeSourceBindingV1> {
    let (Some(repository_id), Some(repository), Some(ref_name), Some(commit_sha)) = (
        source.repository_id.as_ref(),
        source.repository_full_name.as_ref(),
        source.ref_name.as_ref(),
        source.commit_sha.as_ref(),
    ) else {
        return Err(AppError::Network(
            "Project Knowledge omitted GitHub source identity".into(),
        ));
    };
    let binding = KnowledgeSourceBindingV1 {
        source_id: source.id,
        project_id: source.project_id,
        project_environment_id: source.project_environment_id,
        provider: KnowledgeSourceProvider::Github,
        display_name: source.display_name.clone(),
        visibility: KnowledgeSourceVisibility::SharedGraph,
        revision: SourceRevisionIdentity::Github {
            repository_id: repository_id.clone(),
            repository: repository.clone(),
            ref_name: ref_name.clone(),
            commit_sha: commit_sha.clone(),
        },
    };
    if source.provider != "github" || !binding.validate() {
        return Err(AppError::Network(
            "Project Knowledge returned invalid GitHub source identity".into(),
        ));
    }
    Ok(binding)
}

async fn project_source(
    state: &AppState,
    scope: StoredKnowledgeScope,
    remote: Option<&RemoteKnowledgeSource>,
) -> AppResult<KnowledgeSourceProjection> {
    let local_capability_available = scope.binding.provider != KnowledgeSourceProvider::LocalFolder
        || fetch_knowledge_source_root(scope.binding.source_id)
            .ok()
            .flatten()
            .is_some();
    let active_index = state
        .knowledge_store()
        .active_for_source(scope.binding.source_id)
        .await?;
    let active_index_available = active_index.is_some();
    let (health, graph_revision_id) = match scope.binding.provider {
        KnowledgeSourceProvider::Github => (
            match remote.map(|source| source.sync_state.as_str()) {
                Some("ready") => SourceHealthState::Ready,
                Some("failed") => SourceHealthState::Failed,
                Some("stale") => SourceHealthState::Stale,
                _ => SourceHealthState::Syncing,
            },
            remote.and_then(|source| source.graph_revision_id),
        ),
        KnowledgeSourceProvider::LocalFolder
            if local_capability_available && active_index_available =>
        {
            (
                SourceHealthState::Ready,
                active_index
                    .as_ref()
                    .map(|artifact| artifact.graph_revision_id),
            )
        }
        KnowledgeSourceProvider::LocalFolder => (SourceHealthState::Stale, None),
    };
    Ok(KnowledgeSourceProjection {
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
        health,
        graph_revision_id,
        local_capability_available,
    })
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
    let scope = state.knowledge_store().active_resource_scope().await?;
    let projects = active_project_inventory(&state, &scope).await?;
    if scope.workspace_kind == WorkspaceKind::Team {
        let account = selected_team_account(&scope)?;
        let grants = list_current_knowledge_grants(account.as_str(), scope.workspace_id).await?;
        sync_current_knowledge_access_with_projects(
            &state,
            &scope,
            &account,
            scope.workspace_id,
            &projects,
            grants,
        )
        .await?;
    }
    Ok(projects)
}

pub(crate) async fn sync_current_knowledge_access(state: &AppState) -> AppResult<()> {
    let remote = active_remote_scope(state).await?;
    let projects = remote.projects;
    if remote.local_scope.workspace_kind == WorkspaceKind::Team {
        for project in &projects {
            state
                .knowledge_store()
                .save_knowledge_project(&project_definition(
                    remote.local_scope.workspace_id,
                    project,
                ))
                .await?;
        }
    }
    let mut grants =
        list_current_knowledge_grants(remote.account.as_str(), remote.remote_workspace_id).await?;
    if let Some(member_id) = remote.personal_member_id.as_deref() {
        let sources =
            list_remote_knowledge_sources(remote.account.as_str(), remote.remote_workspace_id)
                .await?;
        let mut created = false;
        for project in &projects {
            for environment in &project.environments {
                let mut graph_revision_ids = sources
                    .iter()
                    .filter(|source| {
                        source.project_id == project.id
                            && source.project_environment_id == environment.id
                            && source.environment_revision == environment.revision
                    })
                    .filter_map(|source| source.graph_revision_id)
                    .collect::<Vec<_>>();
                graph_revision_ids.sort_unstable();
                graph_revision_ids.dedup();
                if graph_revision_ids.is_empty()
                    || grants.iter().any(|grant| {
                        grant_matches_revision_set(
                            grant,
                            environment.id,
                            environment.revision,
                            &graph_revision_ids,
                        )
                    })
                {
                    continue;
                }
                create_current_knowledge_grant(
                    remote.account.as_str(),
                    remote.remote_workspace_id,
                    member_id,
                    environment.id,
                )
                .await?;
                created = true;
            }
        }
        if created {
            grants =
                list_current_knowledge_grants(remote.account.as_str(), remote.remote_workspace_id)
                    .await?;
        }
    }
    sync_current_knowledge_access_with_projects(
        state,
        &remote.local_scope,
        &remote.account,
        remote.remote_workspace_id,
        &projects,
        grants,
    )
    .await
}

fn grant_matches_revision_set(
    grant: &RemoteKnowledgeGrant,
    environment_id: Uuid,
    environment_revision: u64,
    expected: &[Uuid],
) -> bool {
    if grant.project_environment_id != environment_id
        || grant.environment_revision != environment_revision
    {
        return false;
    }
    let mut actual = grant.graph_revision_ids.clone();
    actual.sort_unstable();
    actual.dedup();
    actual == expected
}

async fn sync_current_knowledge_access_with_projects(
    state: &AppState,
    scope: &ActiveResourceScope,
    account: &AccountId,
    remote_workspace_id: Uuid,
    projects: &[RemoteKnowledgeProject],
    grants: Vec<RemoteKnowledgeGrant>,
) -> AppResult<()> {
    // Revoke stale hosted heads before importing current grants. The store
    // prunes GitHub heads only, so device-owned Local Folder graphs survive a
    // missing, changed, or empty hosted grant set.
    for project in projects {
        for environment in &project.environments {
            let allowed_graph_revision_ids = grants
                .iter()
                .filter(|grant| {
                    grant.project_environment_id == environment.id
                        && grant.environment_revision == environment.revision
                })
                .flat_map(|grant| grant.graph_revision_ids.iter().copied())
                .collect::<Vec<_>>();
            state
                .knowledge_store()
                .retain_granted_environment_heads(environment.id, &allowed_graph_revision_ids)
                .await?;
        }
    }
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
                        remote_workspace_id,
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
    let scope = state.knowledge_store().active_resource_scope().await?;
    if scope.workspace_kind == WorkspaceKind::Personal {
        let environments = input
            .environments
            .into_iter()
            .map(|environment| (environment.name, environment.risk_class))
            .collect::<Vec<_>>();
        return state
            .knowledge_store()
            .create_knowledge_project(scope.workspace_id, &input.name, &environments)
            .await
            .map(project_projection);
    }
    let account = selected_team_account(&scope)?;
    let project = create_knowledge_project(
        account.as_str(),
        scope.workspace_id,
        &CreateKnowledgeProjectRequest {
            name: input.name,
            environments: input.environments,
        },
    )
    .await?;
    state
        .knowledge_store()
        .save_knowledge_project(&project_definition(scope.workspace_id, &project))
        .await?;
    Ok(project)
}

#[tauri::command]
pub(crate) async fn create_knowledge_environment_command(
    state: State<'_, AppState>,
    input: CreateEnvironmentInput,
) -> AppResult<RemoteKnowledgeProject> {
    let scope = state.knowledge_store().active_resource_scope().await?;
    let projects = active_project_inventory(&state, &scope).await?;
    let project = projects
        .iter()
        .find(|project| project.id == input.project_id)
        .ok_or_else(|| AppError::NotFound("the active workspace Project".into()))?;
    if scope.workspace_kind == WorkspaceKind::Personal {
        return state
            .knowledge_store()
            .create_knowledge_environment(
                scope.workspace_id,
                input.project_id,
                &input.name,
                input.risk_class,
            )
            .await
            .map(project_projection);
    }
    let account = selected_team_account(&scope)?;
    let updated = create_remote_knowledge_environment(
        account.as_str(),
        scope.workspace_id,
        input.project_id,
        &AppendKnowledgeEnvironmentRequest {
            expected_project_revision: project.revision,
            name: input.name,
            risk_class: input.risk_class,
        },
    )
    .await?;
    state
        .knowledge_store()
        .save_knowledge_project(&project_definition(scope.workspace_id, &updated))
        .await?;
    Ok(updated)
}

#[tauri::command]
pub(crate) async fn begin_knowledge_github_install_command(
    state: State<'_, AppState>,
) -> AppResult<String> {
    let remote = active_remote_scope(&state).await?;
    begin_knowledge_github_install(remote.account.as_str(), remote.remote_workspace_id).await
}

#[tauri::command]
pub(crate) async fn list_knowledge_github_repositories_command(
    state: State<'_, AppState>,
) -> AppResult<Vec<RemoteGithubRepository>> {
    let remote = active_remote_scope(&state).await?;
    list_knowledge_github_repositories(remote.account.as_str(), remote.remote_workspace_id).await
}

#[tauri::command]
pub(crate) async fn connect_knowledge_github_source(
    state: State<'_, AppState>,
    input: GithubSourceInput,
) -> AppResult<KnowledgeSourceProjection> {
    let remote = active_remote_scope(&state).await?;
    let (project, environment) = domain_scope(
        WorkspaceId::from(remote.local_scope.workspace_id),
        &remote.projects,
        input.project_id,
        input.project_environment_id,
    )?;
    let adapter = GithubSourceControlPlane::new(
        remote.account,
        WorkspaceId::from(remote.remote_workspace_id),
        environment.clone(),
    );
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
    state
        .knowledge_store()
        .save_scope(&project, &environment, &binding, environment.revision)
        .await?;
    project_source(
        &state,
        StoredKnowledgeScope {
            project,
            environment,
            binding,
        },
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn connect_knowledge_local_folder(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    input: LocalFolderSourceInput,
) -> AppResult<Option<KnowledgeSourceProjection>> {
    use tauri_plugin_dialog::DialogExt;

    let scope = state.knowledge_store().active_resource_scope().await?;
    let projects = active_project_inventory(&state, &scope).await?;
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
    sync_knowledge_source_inner(&state, source_id).await?;
    state.knowledge_watches.start(app.clone(), source_id);
    Ok(Some(
        project_source(
            &state,
            StoredKnowledgeScope {
                project,
                environment,
                binding: snapshot.binding,
            },
            None,
        )
        .await?,
    ))
}

#[tauri::command]
pub(crate) async fn list_knowledge_sources(
    state: State<'_, AppState>,
) -> AppResult<Vec<KnowledgeSourceProjection>> {
    let scope = state.knowledge_store().active_resource_scope().await?;
    let (remote_projects, remote_sources, remote_authoritative) = if scope.workspace_kind
        == WorkspaceKind::Team
    {
        let account = selected_team_account(&scope)?;
        let projects = list_knowledge_projects(account.as_str(), scope.workspace_id).await?;
        let sources = list_remote_knowledge_sources(account.as_str(), scope.workspace_id).await?;
        (projects, sources, true)
    } else if scope.selected_account_id.is_some() {
        match active_remote_scope(&state).await {
            Ok(remote) => match list_remote_knowledge_sources(
                remote.account.as_str(),
                remote.remote_workspace_id,
            )
            .await
            {
                Ok(sources) => (remote.projects, sources, true),
                Err(error) => {
                    tracing::warn!(%error, "Personal GitHub Knowledge inventory refresh deferred");
                    (Vec::new(), Vec::new(), false)
                }
            },
            Err(error) => {
                tracing::warn!(%error, "Personal GitHub Knowledge authority refresh deferred");
                (Vec::new(), Vec::new(), false)
            }
        }
    } else {
        (Vec::new(), Vec::new(), false)
    };
    if remote_authoritative {
        for source in remote_sources
            .iter()
            .filter(|source| source.provider == "github")
        {
            let (project, environment) = domain_scope(
                WorkspaceId::from(scope.workspace_id),
                &remote_projects,
                source.project_id,
                source.project_environment_id,
            )?;
            if source.environment_revision != environment.revision {
                return Err(AppError::Network(
                    "Project Knowledge source crossed its Environment revision".into(),
                ));
            }
            let binding = remote_github_binding(source)?;
            state
                .knowledge_store()
                .save_scope(&project, &environment, &binding, environment.revision)
                .await?;
        }
    }
    let sources = state.knowledge_store().scopes(scope.workspace_id).await?;
    let mut projections = Vec::with_capacity(sources.len());
    for source in sources {
        let remote = remote_sources
            .iter()
            .find(|candidate| candidate.id == source.binding.source_id);
        if source.binding.provider == KnowledgeSourceProvider::Github && remote.is_none() {
            if remote_authoritative && scope.workspace_kind == WorkspaceKind::Team {
                state
                    .knowledge_store()
                    .remove_scope(source.binding.source_id)
                    .await?;
            }
            continue;
        }
        projections.push(project_source(&state, source, remote).await?);
    }
    Ok(projections)
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
            let remote = active_remote_scope(&state).await?;
            delete_knowledge_source(
                remote.account.as_str(),
                remote.remote_workspace_id,
                source_id,
            )
            .await?;
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
    if stored.binding.provider == KnowledgeSourceProvider::Github {
        let remote = active_remote_scope(state).await?;
        let previous_graph_revision_id = request_knowledge_source_sync(
            remote.account.as_str(),
            remote.remote_workspace_id,
            source_id,
        )
        .await?;
        return Ok(KnowledgeSyncProjection {
            source_id,
            state: SourceHealthState::Syncing,
            graph_revision_id: previous_graph_revision_id,
            parsed_files: previous_artifact
                .as_ref()
                .map_or(0, |artifact| artifact.health.parsed_files),
            skipped_files: previous_artifact
                .as_ref()
                .map_or(0, |artifact| artifact.health.skipped_files),
            changed_files: previous_artifact
                .as_ref()
                .map_or_else(Vec::new, |artifact| artifact.changed_files.clone()),
            node_count: previous_artifact
                .as_ref()
                .map_or(0, |artifact| artifact.nodes.len()),
            edge_count: previous_artifact
                .as_ref()
                .map_or(0, |artifact| artifact.edges.len()),
        });
    }
    let parent = previous_artifact
        .as_ref()
        .map(|artifact| artifact.graph_revision_id);
    let previous_snapshot = state.knowledge_store().source_snapshot(source_id).await?;
    let artifact = match stored.binding.provider {
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
        KnowledgeSourceProvider::Github => {
            unreachable!("GitHub sync is owned by the control plane")
        }
    };
    if parent != Some(artifact.graph_revision_id) {
        state.knowledge_store().activate(&artifact).await?;
    }
    Ok(KnowledgeSyncProjection {
        source_id,
        state: SourceHealthState::Ready,
        graph_revision_id: Some(artifact.graph_revision_id),
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
    if active_scope.workspace_kind == WorkspaceKind::Team {
        sync_current_knowledge_access(state).await?;
    } else if active_scope.selected_account_id.is_some() {
        if let Err(error) = sync_current_knowledge_access(state).await {
            let has_remote_graph = state
                .knowledge_store()
                .active_set(project_environment_id)
                .await?
                .iter()
                .any(|graph| graph.binding.provider == KnowledgeSourceProvider::Github);
            if has_remote_graph {
                return Err(error);
            }
            tracing::warn!(%error, "Personal GitHub Knowledge refresh deferred for a local-only graph");
        }
    }
    let allowed = state
        .knowledge_store()
        .knowledge_environment_exists(active_scope.workspace_id, project_environment_id)
        .await?;
    if !allowed {
        return Err(AppError::NotFound(
            "the active workspace Project Environment".into(),
        ));
    }
    let mut graphs = state
        .knowledge_store()
        .active_set(project_environment_id)
        .await?;
    if active_scope.selected_account_id.is_none() {
        graphs.retain(|graph| graph.binding.provider != KnowledgeSourceProvider::Github);
    }
    let environment_revision = graphs
        .first()
        .map(|graph| graph.environment_revision)
        .ok_or_else(|| AppError::NotFound("an active Knowledge graph revision set".into()))?;
    let remote_graph_revision_ids = graphs
        .iter()
        .filter(|graph| graph.binding.provider == KnowledgeSourceProvider::Github)
        .map(|graph| graph.graph_revision_id)
        .collect::<Vec<_>>();
    if !remote_graph_revision_ids.is_empty() {
        let account_id =
            active_scope
                .selected_account_id
                .as_deref()
                .ok_or_else(|| AppError::Blocked {
                    reason: "Project Knowledge requires an exact member grant".into(),
                })?;
        if state
            .knowledge_store()
            .active_knowledge_grant(
                active_scope.workspace_id,
                account_id,
                project_environment_id,
                environment_revision,
                &remote_graph_revision_ids,
            )
            .await?
            .is_none()
        {
            return Err(AppError::Blocked {
                reason: "this member has no current grant for the active Knowledge revision set"
                    .into(),
            });
        }
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
    if active_scope.workspace_kind == WorkspaceKind::Team {
        let account = selected_team_account(&active_scope)?;
        for mapping in
            list_remote_knowledge_mappings(account.as_str(), active_scope.workspace_id).await?
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
    if active_scope.workspace_kind == WorkspaceKind::Team {
        let account = selected_team_account(&active_scope)?;
        decide_remote_knowledge_mapping(
            account.as_str(),
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
    if scope.workspace_kind == WorkspaceKind::Team {
        let account = selected_team_account(&scope)?;
        let remote = list_remote_environment_connections(
            account.as_str(),
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
    let binding_id = if connection.scope.workspace_kind == WorkspaceKind::Team {
        let account = selected_team_account(&connection.scope)?;
        let remote_connection_id = state
            .knowledge_store()
            .remote_connection_id(&connection)
            .await?
            .ok_or_else(|| AppError::Blocked {
                reason: "only a shared workspace connection can be bound to a shared Environment"
                    .into(),
            })?;
        bind_remote_environment_connection(
            account.as_str(),
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
    if scope.workspace_kind == WorkspaceKind::Team {
        let account = selected_team_account(&scope)?;
        revoke_remote_environment_connection(
            account.as_str(),
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
