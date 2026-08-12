//! Project Knowledge HTTP projections. Tokens remain in the OS credential store;
//! source content is returned only for an exact workspace/source/revision request.

use super::*;
use crate::features::knowledge::domain::{
    EnvironmentRiskClass, KnowledgeMappingProposal, MappingProposalState,
};
use dopedb_protocol::GraphBuildArtifactV1;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteGithubRepository {
    pub(crate) installation_id: Uuid,
    pub(crate) account_login: String,
    pub(crate) id: String,
    pub(crate) full_name: String,
    pub(crate) default_branch: String,
    pub(crate) private: bool,
    pub(crate) archived: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GithubInstallationInventory {
    installation_id: Uuid,
    account_login: String,
    repositories: Vec<GithubRepositoryProjection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GithubRepositoryProjection {
    id: String,
    full_name: String,
    default_branch: String,
    private: bool,
    archived: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GithubRepositoryResponse {
    installations: Vec<GithubInstallationInventory>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateKnowledgeSourceRequest<'a> {
    pub(crate) source_id: Uuid,
    pub(crate) provider: &'a str,
    pub(crate) project_id: Uuid,
    pub(crate) project_environment_id: Uuid,
    pub(crate) display_name: &'a str,
    pub(crate) installation_id: Uuid,
    pub(crate) repository_id: &'a str,
    pub(crate) repository_full_name: &'a str,
    pub(crate) ref_name: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedKnowledgeSourceResponse {
    source: CreatedKnowledgeSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueuedKnowledgeSourceResponse {
    queued: bool,
    job_id: Uuid,
    graph_revision_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteKnowledgeSourcesResponse {
    sources: Vec<RemoteKnowledgeSource>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteKnowledgeSource {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) project_environment_id: Uuid,
    pub(crate) environment_revision: u64,
    pub(crate) provider: String,
    pub(crate) display_name: String,
    pub(crate) visibility: String,
    pub(crate) repository_id: Option<String>,
    pub(crate) repository_full_name: Option<String>,
    pub(crate) ref_name: Option<String>,
    pub(crate) commit_sha: Option<String>,
    pub(crate) sync_state: String,
    pub(crate) sync_revision: u64,
    pub(crate) last_failure_code: Option<String>,
    pub(crate) graph_revision_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreatedKnowledgeSource {
    pub(crate) id: Uuid,
    pub(crate) sync_revision: u64,
    pub(crate) environment_revision: u64,
    pub(crate) commit_sha: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteKnowledgeEnvironment {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) risk_class: EnvironmentRiskClass,
    pub(crate) revision: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteKnowledgeProject {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) revision: u64,
    pub(crate) environments: Vec<RemoteKnowledgeEnvironment>,
}

#[derive(Debug, Clone)]
pub(crate) struct RemotePersonalKnowledgeScope {
    pub(crate) workspace_id: Uuid,
    pub(crate) member_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonalKnowledgeScopeRequest<'a> {
    projects: &'a [RemoteKnowledgeProject],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersonalKnowledgeScopeResponse {
    workspace_id: Uuid,
    member_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteKnowledgeGraphScope {
    pub(crate) source_id: Uuid,
    pub(crate) graph_revision_id: Uuid,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteKnowledgeGrant {
    pub(crate) id: Uuid,
    pub(crate) member_id: String,
    pub(crate) project_id: Uuid,
    pub(crate) project_environment_id: Uuid,
    pub(crate) environment_revision: u64,
    pub(crate) graph_revision_ids: Vec<Uuid>,
    pub(crate) graph_scopes: Vec<RemoteKnowledgeGraphScope>,
    pub(crate) expires_at: chrono::DateTime<chrono::Utc>,
    pub(crate) revoked_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KnowledgeGrantsResponse {
    grants: Vec<RemoteKnowledgeGrant>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateKnowledgeGrantRequest<'a> {
    member_id: &'a str,
    project_environment_id: Uuid,
    ttl_seconds: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedKnowledgeGrantResponse {
    grant: CreatedKnowledgeGrant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedKnowledgeGrant {
    id: Uuid,
    expires_at: chrono::DateTime<chrono::Utc>,
    graph_revision_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KnowledgeMappingsResponse {
    mappings: Vec<KnowledgeMappingProposal>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KnowledgeMappingResponse {
    mapping: KnowledgeMappingProposal,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProposeKnowledgeMappingRequest<'a> {
    grant_id: Uuid,
    graph_revision_id: Uuid,
    schema_fingerprint: &'a str,
    from_node_id: &'a str,
    target_kind: &'a str,
    target_identity: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecideKnowledgeMappingRequest<'a> {
    mapping_id: Uuid,
    expected_graph_revision_id: Uuid,
    decision: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DownloadedKnowledgeGraphResponse {
    graph_revision_id: Uuid,
    artifact_sha256: String,
    artifact: GraphBuildArtifactV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KnowledgeProjectsResponse {
    projects: Vec<RemoteKnowledgeProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateKnowledgeEnvironmentRequest {
    pub(crate) name: String,
    pub(crate) risk_class: EnvironmentRiskClass,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateKnowledgeProjectRequest {
    pub(crate) name: String,
    pub(crate) environments: Vec<CreateKnowledgeEnvironmentRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppendKnowledgeEnvironmentRequest {
    pub(crate) expected_project_revision: u64,
    pub(crate) name: String,
    pub(crate) risk_class: EnvironmentRiskClass,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedKnowledgeProjectResponse {
    project: RemoteKnowledgeProject,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteEnvironmentConnectionBinding {
    pub(crate) id: Uuid,
    pub(crate) project_environment_id: Uuid,
    pub(crate) environment_revision: u64,
    pub(crate) connection_id: Uuid,
    pub(crate) connection_revision: i64,
    pub(crate) current_connection_revision: i64,
    pub(crate) connection_name: String,
    pub(crate) role: String,
    pub(crate) alias: String,
    pub(crate) stale: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnvironmentConnectionBindingsResponse {
    bindings: Vec<RemoteEnvironmentConnectionBinding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnvironmentConnectionBindingResponse {
    binding: RemoteEnvironmentConnectionBinding,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GithubInstallResponse {
    authorization_url: String,
}

fn bearer(user_id: &str) -> AppResult<Zeroizing<String>> {
    fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("Project Knowledge requires an authenticated session".into())
        })
}

pub(crate) async fn ensure_personal_knowledge_scope(
    user_id: &str,
    projects: &[RemoteKnowledgeProject],
) -> AppResult<RemotePersonalKnowledgeScope> {
    if projects.len() > 100
        || projects.iter().any(|project| {
            project.name.trim().is_empty()
                || project.name.len() > 512
                || project.revision == 0
                || project.environments.is_empty()
                || project.environments.len() > 20
                || project.environments.iter().any(|environment| {
                    environment.name.trim().is_empty()
                        || environment.name.len() > 512
                        || environment.revision == 0
                })
        })
    {
        return Err(AppError::Config(
            "the Personal Knowledge scope inventory is invalid".into(),
        ));
    }
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!("{}/api/v1/personal/knowledge/scope", origin()?))
        .bearer_auth(token.as_str())
        .json(&PersonalKnowledgeScopeRequest { projects })
        .send()
        .await
        .map_err(|error| request_error("preparing Personal Knowledge", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    require_json_response(&response, "preparing Personal Knowledge")?;
    let scope = response
        .json::<PersonalKnowledgeScopeResponse>()
        .await
        .map_err(|error| request_error("reading the Personal Knowledge scope", error))?;
    if scope.member_id.trim().is_empty() || scope.member_id.len() > 255 {
        return Err(AppError::Network(
            "Personal Knowledge returned an invalid authority".into(),
        ));
    }
    Ok(RemotePersonalKnowledgeScope {
        workspace_id: scope.workspace_id,
        member_id: scope.member_id,
    })
}

pub(crate) async fn list_knowledge_projects(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<Vec<RemoteKnowledgeProject>> {
    let token = bearer(user_id)?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/projects",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Project Knowledge scopes", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let projects = response
        .json::<KnowledgeProjectsResponse>()
        .await
        .map_err(|error| request_error("reading Project Knowledge scopes", error))?
        .projects;
    if projects.len() > 1_000
        || projects.iter().any(|project| {
            project.name.is_empty()
                || project.name.len() > 512
                || project.revision == 0
                || project.environments.is_empty()
                || project.environments.len() > 100
                || project.environments.iter().any(|environment| {
                    environment.name.is_empty()
                        || environment.name.len() > 512
                        || environment.revision == 0
                })
        })
    {
        return Err(AppError::Network(
            "Project Knowledge returned an invalid scope inventory".into(),
        ));
    }
    Ok(projects)
}

pub(crate) async fn create_knowledge_project(
    user_id: &str,
    workspace_id: Uuid,
    request: &CreateKnowledgeProjectRequest,
) -> AppResult<RemoteKnowledgeProject> {
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/projects",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(request)
        .send()
        .await
        .map_err(|error| request_error("creating a Project Knowledge scope", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let project = response
        .json::<CreatedKnowledgeProjectResponse>()
        .await
        .map_err(|error| request_error("reading the Project Knowledge scope", error))?
        .project;
    if project.revision == 0 || project.environments.is_empty() {
        return Err(AppError::Network(
            "Project Knowledge returned an invalid created scope".into(),
        ));
    }
    Ok(project)
}

pub(crate) async fn create_knowledge_environment(
    user_id: &str,
    workspace_id: Uuid,
    project_id: Uuid,
    request: &AppendKnowledgeEnvironmentRequest,
) -> AppResult<RemoteKnowledgeProject> {
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/projects/{project_id}/environments",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(request)
        .send()
        .await
        .map_err(|error| request_error("adding a Project Environment", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let project = response
        .json::<CreatedKnowledgeProjectResponse>()
        .await
        .map_err(|error| request_error("reading the updated Project scope", error))?
        .project;
    if project.id != project_id
        || project.revision != request.expected_project_revision.saturating_add(1)
        || project.environments.is_empty()
        || project.environments.len() > 100
        || project.environments.iter().any(|environment| {
            environment.name.is_empty() || environment.name.len() > 512 || environment.revision == 0
        })
    {
        return Err(AppError::Network(
            "Project Knowledge returned an invalid updated scope".into(),
        ));
    }
    Ok(project)
}

pub(crate) async fn list_current_knowledge_grants(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<Vec<RemoteKnowledgeGrant>> {
    let token = bearer(user_id)?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/grants?scope=mine",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading current Knowledge grants", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let grants = response
        .json::<KnowledgeGrantsResponse>()
        .await
        .map_err(|error| request_error("reading current Knowledge grants", error))?
        .grants;
    let now = chrono::Utc::now();
    if grants.len() > 1_000
        || grants.iter().any(|grant| {
            grant.member_id.is_empty()
                || grant.member_id.len() > 255
                || grant.environment_revision == 0
                || grant.graph_revision_ids.is_empty()
                || grant.graph_revision_ids.len() > 100
                || grant.graph_scopes.len() != grant.graph_revision_ids.len()
                || grant.expires_at <= now
                || grant.revoked_at.is_some()
                || grant
                    .graph_scopes
                    .iter()
                    .any(|scope| !grant.graph_revision_ids.contains(&scope.graph_revision_id))
        })
    {
        return Err(AppError::Network(
            "Project Knowledge returned invalid current grants".into(),
        ));
    }
    Ok(grants)
}

pub(crate) async fn create_current_knowledge_grant(
    user_id: &str,
    workspace_id: Uuid,
    member_id: &str,
    project_environment_id: Uuid,
) -> AppResult<()> {
    if member_id.trim().is_empty() || member_id.len() > 255 {
        return Err(AppError::Config(
            "the Personal Knowledge member authority is invalid".into(),
        ));
    }
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/grants",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&CreateKnowledgeGrantRequest {
            member_id,
            project_environment_id,
            ttl_seconds: 60 * 60,
        })
        .send()
        .await
        .map_err(|error| request_error("issuing Personal Knowledge authority", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let created = response
        .json::<CreatedKnowledgeGrantResponse>()
        .await
        .map_err(|error| request_error("reading Personal Knowledge authority", error))?
        .grant;
    if created.expires_at <= chrono::Utc::now()
        || created.graph_revision_ids.is_empty()
        || created.graph_revision_ids.len() > 100
    {
        return Err(AppError::Network(
            "Personal Knowledge returned an invalid grant".into(),
        ));
    }
    let _ = created.id;
    Ok(())
}

fn valid_remote_mapping(mapping: &KnowledgeMappingProposal) -> bool {
    mapping.schema_fingerprint.len() == 64
        && mapping
            .schema_fingerprint
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
        && mapping.from_node_id.len() == 64
        && mapping
            .from_node_id
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
        && !mapping.target_kind.trim().is_empty()
        && mapping.target_kind.len() <= 128
        && !mapping.target_identity.trim().is_empty()
        && mapping.target_identity.len() <= 2_048
        && !mapping.target_identity.chars().any(char::is_control)
}

pub(crate) async fn list_remote_knowledge_mappings(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<Vec<KnowledgeMappingProposal>> {
    let token = bearer(user_id)?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/mappings",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Knowledge mappings", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let mappings = response
        .json::<KnowledgeMappingsResponse>()
        .await
        .map_err(|error| request_error("reading Knowledge mappings", error))?
        .mappings;
    if mappings.len() > 10_000
        || mappings
            .iter()
            .any(|mapping| !valid_remote_mapping(mapping))
    {
        return Err(AppError::Network(
            "Project Knowledge returned invalid mappings".into(),
        ));
    }
    Ok(mappings)
}

pub(crate) async fn propose_remote_knowledge_mapping(
    user_id: &str,
    workspace_id: Uuid,
    grant_id: Uuid,
    proposal: &KnowledgeMappingProposal,
) -> AppResult<KnowledgeMappingProposal> {
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/mappings",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&ProposeKnowledgeMappingRequest {
            grant_id,
            graph_revision_id: proposal.graph_revision_id,
            schema_fingerprint: &proposal.schema_fingerprint,
            from_node_id: &proposal.from_node_id,
            target_kind: &proposal.target_kind,
            target_identity: &proposal.target_identity,
        })
        .send()
        .await
        .map_err(|error| request_error("proposing a Knowledge mapping", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let mapping = response
        .json::<KnowledgeMappingResponse>()
        .await
        .map_err(|error| request_error("reading the Knowledge mapping proposal", error))?
        .mapping;
    if mapping.project_environment_id != proposal.project_environment_id
        || mapping.graph_revision_id != proposal.graph_revision_id
        || mapping.schema_fingerprint != proposal.schema_fingerprint
        || mapping.from_node_id != proposal.from_node_id
        || mapping.target_kind != proposal.target_kind
        || mapping.target_identity != proposal.target_identity
        || mapping.state != MappingProposalState::Proposed
        || !valid_remote_mapping(&mapping)
    {
        return Err(AppError::Network(
            "Project Knowledge changed the mapping proposal".into(),
        ));
    }
    Ok(mapping)
}

pub(crate) async fn decide_remote_knowledge_mapping(
    user_id: &str,
    workspace_id: Uuid,
    mapping_id: Uuid,
    expected_graph_revision_id: Uuid,
    decision: MappingProposalState,
) -> AppResult<()> {
    let decision = match decision {
        MappingProposalState::Approved => "approved",
        MappingProposalState::Rejected => "rejected",
        _ => {
            return Err(AppError::Config(
                "a remote Knowledge mapping decision must be final".into(),
            ));
        }
    };
    let token = bearer(user_id)?;
    let response = client()?
        .patch(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/mappings",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&DecideKnowledgeMappingRequest {
            mapping_id,
            expected_graph_revision_id,
            decision,
        })
        .send()
        .await
        .map_err(|error| request_error("deciding a Knowledge mapping", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    Ok(())
}

pub(crate) async fn download_knowledge_graph(
    user_id: &str,
    workspace_id: Uuid,
    grant_id: Uuid,
    source_id: Uuid,
    expected_graph_revision_id: Uuid,
) -> AppResult<GraphBuildArtifactV1> {
    let token = bearer(user_id)?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/sources/{source_id}/graph?grantId={grant_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading a granted Knowledge graph", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let downloaded = response
        .json::<DownloadedKnowledgeGraphResponse>()
        .await
        .map_err(|error| request_error("reading a granted Knowledge graph", error))?;
    let artifact_value = serde_json::to_value(&downloaded.artifact)?;
    let artifact_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&artifact_value)?));
    if downloaded.graph_revision_id != expected_graph_revision_id
        || downloaded.artifact.graph_revision_id != expected_graph_revision_id
        || downloaded.artifact.binding.source_id != source_id
        || downloaded.artifact_sha256 != artifact_sha256
        || !downloaded.artifact.validate()
    {
        return Err(AppError::Network(
            "Project Knowledge returned an invalid granted graph".into(),
        ));
    }
    Ok(downloaded.artifact)
}

pub(crate) async fn list_environment_connections(
    user_id: &str,
    workspace_id: Uuid,
    environment_id: Uuid,
) -> AppResult<Vec<RemoteEnvironmentConnectionBinding>> {
    let token = bearer(user_id)?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/environments/{environment_id}/connections",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Environment connections", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let bindings = response
        .json::<EnvironmentConnectionBindingsResponse>()
        .await
        .map_err(|error| request_error("reading Environment connections", error))?
        .bindings;
    if bindings.len() > 1_000
        || bindings.iter().any(|binding| {
            binding.project_environment_id != environment_id
                || binding.environment_revision == 0
                || binding.connection_revision <= 0
                || binding.current_connection_revision <= 0
                || binding.connection_name.is_empty()
                || binding.connection_name.len() > 512
                || binding.role.is_empty()
                || binding.role.len() > 64
                || binding.alias.is_empty()
                || binding.alias.len() > 128
                || binding.stale
                    != (binding.connection_revision != binding.current_connection_revision)
        })
    {
        return Err(AppError::Network(
            "Project Knowledge returned invalid Environment connections".into(),
        ));
    }
    Ok(bindings)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn bind_environment_connection(
    user_id: &str,
    workspace_id: Uuid,
    environment_id: Uuid,
    binding_id: Uuid,
    connection_id: Uuid,
    role: &str,
    alias: &str,
) -> AppResult<RemoteEnvironmentConnectionBinding> {
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/environments/{environment_id}/connections",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&json!({
            "bindingId": binding_id,
            "connectionId": connection_id,
            "role": role,
            "alias": alias,
        }))
        .send()
        .await
        .map_err(|error| request_error("binding an Environment connection", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let binding = response
        .json::<EnvironmentConnectionBindingResponse>()
        .await
        .map_err(|error| request_error("reading an Environment connection binding", error))?
        .binding;
    if binding.project_environment_id != environment_id || binding.connection_id != connection_id {
        return Err(AppError::Network(
            "Project Knowledge changed Environment connection identity".into(),
        ));
    }
    Ok(binding)
}

pub(crate) async fn revoke_environment_connection(
    user_id: &str,
    workspace_id: Uuid,
    environment_id: Uuid,
    binding_id: Uuid,
) -> AppResult<()> {
    let token = bearer(user_id)?;
    let response = client()?
        .delete(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/environments/{environment_id}/connections",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&json!({ "bindingId": binding_id }))
        .send()
        .await
        .map_err(|error| request_error("removing an Environment connection", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    Ok(())
}

pub(crate) async fn begin_knowledge_github_install(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<String> {
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/github/install",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&json!({}))
        .send()
        .await
        .map_err(|error| request_error("starting GitHub Knowledge installation", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let url = response
        .json::<GithubInstallResponse>()
        .await
        .map_err(|error| request_error("reading GitHub Knowledge installation", error))?
        .authorization_url;
    let parsed = Url::parse(&url)
        .map_err(|_| AppError::Network("GitHub Knowledge returned an invalid URL".into()))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.path().starts_with("/apps/")
        || !parsed.path().ends_with("/installations/new")
    {
        return Err(AppError::Network(
            "GitHub Knowledge returned an unsafe installation URL".into(),
        ));
    }
    Ok(url)
}

pub(crate) async fn list_knowledge_github_repositories(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<Vec<RemoteGithubRepository>> {
    let token = bearer(user_id)?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/github/repositories",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading GitHub Knowledge repositories", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let body = response
        .json::<GithubRepositoryResponse>()
        .await
        .map_err(|error| request_error("reading GitHub Knowledge repositories", error))?;
    let mut repositories = Vec::new();
    for installation in body.installations {
        if installation.account_login.is_empty() || installation.account_login.len() > 255 {
            return Err(AppError::Network(
                "GitHub Knowledge returned an invalid installation".into(),
            ));
        }
        for repository in installation.repositories {
            if repositories.len() >= 1_000
                || repository.id.is_empty()
                || repository.id.len() > 32
                || repository.full_name.len() > 512
                || repository.default_branch.len() > 255
            {
                return Err(AppError::Network(
                    "GitHub Knowledge returned an invalid repository inventory".into(),
                ));
            }
            repositories.push(RemoteGithubRepository {
                installation_id: installation.installation_id,
                account_login: installation.account_login.clone(),
                id: repository.id,
                full_name: repository.full_name,
                default_branch: repository.default_branch,
                private: repository.private,
                archived: repository.archived,
            });
        }
    }
    Ok(repositories)
}

pub(crate) async fn create_knowledge_source(
    user_id: &str,
    workspace_id: Uuid,
    request: &CreateKnowledgeSourceRequest<'_>,
) -> AppResult<CreatedKnowledgeSource> {
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/sources",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(request)
        .send()
        .await
        .map_err(|error| request_error("creating a Project Knowledge source", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let created = response
        .json::<CreatedKnowledgeSourceResponse>()
        .await
        .map_err(|error| request_error("reading the Project Knowledge source", error))?
        .source;
    if created.id != request.source_id
        || created.sync_revision == 0
        || created.environment_revision == 0
        || created.commit_sha.as_ref().is_some_and(|value| {
            value.len() != 40 || !value.chars().all(|character| character.is_ascii_hexdigit())
        })
    {
        return Err(AppError::Network(
            "Project Knowledge changed source identity".into(),
        ));
    }
    Ok(created)
}

pub(crate) async fn list_remote_knowledge_sources(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<Vec<RemoteKnowledgeSource>> {
    let token = bearer(user_id)?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/sources",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading workspace Knowledge sources", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let sources = response
        .json::<RemoteKnowledgeSourcesResponse>()
        .await
        .map_err(|error| request_error("reading workspace Knowledge sources", error))?
        .sources;
    if sources.len() > 10_000
        || sources.iter().any(|source| {
            source.environment_revision == 0
                || source.sync_revision == 0
                || source.display_name.trim().is_empty()
                || source.display_name.len() > 512
                || source.visibility != "shared_graph"
                || !matches!(
                    source.sync_state.as_str(),
                    "pending" | "syncing" | "ready" | "stale" | "failed"
                )
                || source
                    .last_failure_code
                    .as_ref()
                    .is_some_and(|value| value.is_empty() || value.len() > 255)
        })
    {
        return Err(AppError::Network(
            "Project Knowledge returned invalid source inventory".into(),
        ));
    }
    Ok(sources)
}

pub(crate) async fn request_knowledge_source_sync(
    user_id: &str,
    workspace_id: Uuid,
    source_id: Uuid,
) -> AppResult<Option<Uuid>> {
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/sources/{source_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&json!({}))
        .send()
        .await
        .map_err(|error| request_error("queueing the workspace code index", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let queued = response
        .json::<QueuedKnowledgeSourceResponse>()
        .await
        .map_err(|error| request_error("reading the queued workspace code index", error))?;
    if !queued.queued {
        return Err(AppError::Network(
            "Project Knowledge did not queue the code index".into(),
        ));
    }
    let _ = queued.job_id;
    Ok(queued.graph_revision_id)
}

pub(crate) async fn delete_knowledge_source(
    user_id: &str,
    workspace_id: Uuid,
    source_id: Uuid,
) -> AppResult<()> {
    let token = bearer(user_id)?;
    let response = client()?
        .delete(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/sources/{source_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("revoking a Project Knowledge source", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    Ok(())
}
