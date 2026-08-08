//! Project Knowledge HTTP projections. Tokens remain in the OS credential store;
//! source content is returned only for an exact workspace/source/revision request.

use super::*;
use dopedb_protocol::GraphBuildArtifactV1;
use sha2::{Digest, Sha256};
const MAX_SOURCE_FILES: usize = 100_000;
const MAX_SOURCE_FILE_BYTES: usize = 16 * 1024 * 1024;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) installation_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repository_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repository_full_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ref_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) root_fingerprint: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot_sha256: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) publish_approved: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) exposure: Option<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedKnowledgeSourceResponse {
    source: CreatedKnowledgeSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedKnowledgeSource {
    id: Uuid,
    sync_revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishedKnowledgeGraph {
    pub(crate) graph_revision_id: Uuid,
    pub(crate) artifact_sha256: String,
    pub(crate) active: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteKnowledgeSourceFile {
    pub(crate) path: String,
    pub(crate) blob_sha: String,
    pub(crate) bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteKnowledgeSourceSnapshot {
    pub(crate) source_id: Uuid,
    pub(crate) environment_revision: u64,
    pub(crate) sync_revision: u64,
    pub(crate) repository: String,
    pub(crate) commit_sha: String,
    pub(crate) files: Vec<RemoteKnowledgeSourceFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteKnowledgeSourceEvent {
    pub(crate) id: Uuid,
    pub(crate) event_kind: String,
    pub(crate) before_commit_sha: Option<String>,
    pub(crate) after_commit_sha: Option<String>,
    pub(crate) changed_files: Vec<String>,
    pub(crate) created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KnowledgeSourceEventsResponse {
    events: Vec<RemoteKnowledgeSourceEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteKnowledgeEnvironment {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) production: bool,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KnowledgeProjectsResponse {
    projects: Vec<RemoteKnowledgeProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateKnowledgeEnvironmentRequest {
    pub(crate) name: String,
    pub(crate) production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateKnowledgeProjectRequest {
    pub(crate) name: String,
    pub(crate) environments: Vec<CreateKnowledgeEnvironmentRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedKnowledgeProjectResponse {
    project: RemoteKnowledgeProject,
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
) -> AppResult<u64> {
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
    if created.id != request.source_id || created.sync_revision == 0 {
        return Err(AppError::Network(
            "Project Knowledge changed source identity".into(),
        ));
    }
    Ok(created.sync_revision)
}

pub(crate) async fn knowledge_source_snapshot(
    user_id: &str,
    workspace_id: Uuid,
    source_id: Uuid,
) -> AppResult<RemoteKnowledgeSourceSnapshot> {
    let token = bearer(user_id)?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/sources/{source_id}/snapshot",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading a GitHub Knowledge snapshot", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let snapshot = response
        .json::<RemoteKnowledgeSourceSnapshot>()
        .await
        .map_err(|error| request_error("reading a GitHub Knowledge snapshot", error))?;
    if snapshot.source_id != source_id
        || snapshot.environment_revision == 0
        || snapshot.sync_revision == 0
        || snapshot.files.len() > MAX_SOURCE_FILES
        || snapshot.repository.len() > 512
        || !snapshot
            .files
            .iter()
            .all(|file| file.path.len() <= 4_096 && file.blob_sha.len() == 40)
    {
        return Err(AppError::Network(
            "GitHub Knowledge returned an invalid snapshot".into(),
        ));
    }
    Ok(snapshot)
}

pub(crate) async fn read_knowledge_source_blob(
    user_id: &str,
    workspace_id: Uuid,
    source_id: Uuid,
    path: &str,
    blob_sha: &str,
) -> AppResult<Vec<u8>> {
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/sources/{source_id}/blob",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&json!({ "path": path, "blobSha": blob_sha }))
        .send()
        .await
        .map_err(|error| request_error("reading a GitHub Knowledge file", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| request_error("reading a GitHub Knowledge file", error))?;
    if bytes.len() > MAX_SOURCE_FILE_BYTES {
        return Err(AppError::Blocked {
            reason: "GitHub Knowledge source file exceeds the safety limit".into(),
        });
    }
    Ok(bytes.to_vec())
}

pub(crate) async fn knowledge_source_events(
    user_id: &str,
    workspace_id: Uuid,
    source_id: Uuid,
) -> AppResult<Vec<RemoteKnowledgeSourceEvent>> {
    let token = bearer(user_id)?;
    let response = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/events?sourceId={source_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Project Knowledge changes", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let events = response
        .json::<KnowledgeSourceEventsResponse>()
        .await
        .map_err(|error| request_error("reading Project Knowledge changes", error))?
        .events;
    if events.len() > 100
        || events.iter().any(|event| {
            event.event_kind != "push"
                || event.changed_files.len() > MAX_SOURCE_FILES
                || event
                    .changed_files
                    .iter()
                    .any(|path| path.is_empty() || path.len() > 4_096)
                || chrono::DateTime::parse_from_rfc3339(&event.created_at).is_err()
        })
    {
        return Err(AppError::Network(
            "Project Knowledge returned invalid change events".into(),
        ));
    }
    Ok(events)
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

pub(crate) async fn publish_knowledge_graph(
    user_id: &str,
    workspace_id: Uuid,
    artifact: &GraphBuildArtifactV1,
) -> AppResult<PublishedKnowledgeGraph> {
    if !artifact.validate() {
        return Err(AppError::Blocked {
            reason: "an unhealthy Knowledge graph cannot be published".into(),
        });
    }
    // Hash the exact Value projection sent over the wire. serde_json structs keep
    // declaration order while Value maps are canonical key ordered in this build;
    // the control plane hashes JSON.parse(request).artifact with that wire order.
    let artifact_value = serde_json::to_value(artifact)?;
    let artifact_json = serde_json::to_vec(&artifact_value)?;
    if artifact_json.len() > 256 * 1024 * 1024 {
        return Err(AppError::Config(
            "the Knowledge graph exceeds the publish limit".into(),
        ));
    }
    let artifact_sha256 = hex::encode(Sha256::digest(&artifact_json));
    let token = bearer(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/knowledge/sources/{}/graph",
            origin()?,
            artifact.binding.source_id,
        ))
        .bearer_auth(token.as_str())
        .json(&json!({
            "artifact": artifact_value,
            "approval": {
                "sourceId": artifact.binding.source_id,
                "exposure": "normalized_graph_only",
                "artifactSha256": artifact_sha256,
            },
        }))
        .send()
        .await
        .map_err(|error| request_error("publishing a Knowledge graph", error))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let published = response
        .json::<PublishedKnowledgeGraph>()
        .await
        .map_err(|error| request_error("reading the Knowledge graph receipt", error))?;
    if published.graph_revision_id != artifact.graph_revision_id
        || published.artifact_sha256 != artifact_sha256
        || !published.active
    {
        return Err(AppError::Network(
            "Project Knowledge returned an invalid publish receipt".into(),
        ));
    }
    Ok(published)
}
