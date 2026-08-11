//! GitHub source registration through the workspace control plane.
//!
//! GitHub content is indexed centrally by bounded Vercel jobs. Desktop receives
//! only the exact source identity and later downloads an immutable granted
//! index; it never downloads a repository to build a competing local graph.

use dopedb_protocol::{
    KnowledgeSourceBindingV1, KnowledgeSourceProvider, KnowledgeSourceVisibility,
    SourceRevisionIdentity,
};

use crate::error::{AppError, AppResult};
use crate::features::workspaces::adapters::control_plane::{
    create_knowledge_source, CreateKnowledgeSourceRequest,
};
use crate::kernel::identity::{AccountId, WorkspaceId};

use super::super::domain::{
    validate_binding_draft, ProjectEnvironment, SourceBindingDraft, SourceLocator,
};

#[derive(Clone)]
pub(crate) struct GithubSourceControlPlane {
    account_id: AccountId,
    workspace_id: WorkspaceId,
    environment: ProjectEnvironment,
}

impl GithubSourceControlPlane {
    pub(crate) fn new(
        account_id: AccountId,
        workspace_id: WorkspaceId,
        environment: ProjectEnvironment,
    ) -> Self {
        Self {
            account_id,
            workspace_id,
            environment,
        }
    }

    pub(crate) async fn bind(
        &self,
        draft: &SourceBindingDraft,
    ) -> AppResult<KnowledgeSourceBindingV1> {
        validate_binding_draft(draft, &self.environment)?;
        let SourceLocator::Github {
            installation_id,
            repository_id,
            repository,
            ref_name,
        } = &draft.locator
        else {
            return Err(AppError::Config(
                "the GitHub source received another provider".into(),
            ));
        };
        let created = create_knowledge_source(
            self.account_id.as_str(),
            self.workspace_id.into(),
            &CreateKnowledgeSourceRequest {
                source_id: draft.source_id,
                provider: "github",
                project_id: draft.project_id,
                project_environment_id: draft.project_environment_id,
                display_name: &draft.display_name,
                installation_id: *installation_id,
                repository_id,
                repository_full_name: repository,
                ref_name,
            },
        )
        .await?;
        let commit_sha = created.commit_sha.ok_or_else(|| {
            AppError::Network("GitHub source registration omitted its exact commit".into())
        })?;
        if created.environment_revision != self.environment.revision {
            return Err(AppError::Blocked {
                reason: "GitHub source registration crossed its Environment revision".into(),
            });
        }
        let binding = KnowledgeSourceBindingV1 {
            source_id: draft.source_id,
            project_id: draft.project_id,
            project_environment_id: draft.project_environment_id,
            provider: KnowledgeSourceProvider::Github,
            display_name: draft.display_name.trim().to_owned(),
            visibility: KnowledgeSourceVisibility::SharedGraph,
            revision: SourceRevisionIdentity::Github {
                repository_id: repository_id.clone(),
                repository: repository.clone(),
                ref_name: ref_name.clone(),
                commit_sha,
            },
        };
        if !binding.validate() {
            return Err(AppError::Network(
                "GitHub source registration returned an invalid identity".into(),
            ));
        }
        Ok(binding)
    }
}
