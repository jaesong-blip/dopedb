//! Provider adapters and immutable graph persistence ports.

use std::future::Future;

use dopedb_protocol::{
    GraphBuildArtifactV1, GraphRevisionDiffV1, KnowledgeSourceBindingV1, SourceRevisionIdentity,
};
use uuid::Uuid;

use crate::error::AppResult;

use super::domain::{
    KnowledgeGrant, KnowledgeMappingProposal, MappingProposalState, Project, ProjectEnvironment,
    SourceBindingDraft, SourceHealth, SourceSnapshot, StoredKnowledgeScope,
};

pub(crate) trait KnowledgeScopeRepositoryPort: Clone + Send + Sync + 'static {
    /// Persist only provider-neutral, secret-free identity. Local roots remain in
    /// the Desktop adapter's process-local capability registry.
    fn save_scope(
        &self,
        project: &Project,
        environment: &ProjectEnvironment,
        binding: &KnowledgeSourceBindingV1,
        environment_revision: u64,
    ) -> impl Future<Output = AppResult<()>> + Send;
    fn scopes(
        &self,
        workspace_id: Uuid,
    ) -> impl Future<Output = AppResult<Vec<StoredKnowledgeScope>>> + Send;
    fn remove_scope(&self, source_id: Uuid) -> impl Future<Output = AppResult<()>> + Send;
    fn save_snapshot(
        &self,
        snapshot: &SourceSnapshot,
    ) -> impl Future<Output = AppResult<()>> + Send;
    fn source_snapshot(
        &self,
        source_id: Uuid,
    ) -> impl Future<Output = AppResult<Option<SourceSnapshot>>> + Send;
}

pub(crate) trait SourceProviderAdapter: Clone + Send + Sync + 'static {
    type Watch: Send + 'static;

    fn discover(&self) -> impl Future<Output = AppResult<Vec<String>>> + Send;
    fn bind(
        &self,
        draft: &SourceBindingDraft,
    ) -> impl Future<Output = AppResult<KnowledgeSourceBindingV1>> + Send;
    fn resolve_revision(
        &self,
        binding: &KnowledgeSourceBindingV1,
    ) -> impl Future<Output = AppResult<SourceRevisionIdentity>> + Send;
    fn snapshot(
        &self,
        binding: &KnowledgeSourceBindingV1,
        previous: Option<&SourceSnapshot>,
    ) -> impl Future<Output = AppResult<SourceSnapshot>> + Send;
    fn list_changes(
        &self,
        before: &SourceRevisionIdentity,
        after: &SourceRevisionIdentity,
    ) -> impl Future<Output = AppResult<Vec<String>>> + Send;
    fn read_file_at_revision(
        &self,
        binding: &KnowledgeSourceBindingV1,
        revision: &SourceRevisionIdentity,
        path: &str,
    ) -> impl Future<Output = AppResult<Vec<u8>>> + Send;
    fn watch(
        &self,
        binding: &KnowledgeSourceBindingV1,
    ) -> impl Future<Output = AppResult<Self::Watch>> + Send;
    fn health(
        &self,
        binding: &KnowledgeSourceBindingV1,
    ) -> impl Future<Output = AppResult<SourceHealth>> + Send;
    fn revoke(
        &self,
        binding: &KnowledgeSourceBindingV1,
    ) -> impl Future<Output = AppResult<()>> + Send;
}

pub(crate) trait KnowledgeGraphRepositoryPort: Clone + Send + Sync + 'static {
    /// Store a build candidate without changing the active graph revision.
    fn stage(&self, artifact: &GraphBuildArtifactV1) -> impl Future<Output = AppResult<()>> + Send;
    /// Atomically activate only a healthy candidate for the expected environment
    /// revision; a failed build leaves the previous last-good revision active.
    fn activate(
        &self,
        artifact: &GraphBuildArtifactV1,
    ) -> impl Future<Output = AppResult<()>> + Send;
    fn active(
        &self,
        project_environment_id: Uuid,
    ) -> impl Future<Output = AppResult<Option<GraphBuildArtifactV1>>> + Send;
    fn by_revision(
        &self,
        graph_revision_id: Uuid,
    ) -> impl Future<Output = AppResult<Option<GraphBuildArtifactV1>>> + Send;
    fn diff(
        &self,
        from_graph_revision_id: Uuid,
        to_graph_revision_id: Uuid,
    ) -> impl Future<Output = AppResult<GraphRevisionDiffV1>> + Send;
}

pub(crate) trait KnowledgeGrantPort: Clone + Send + Sync + 'static {
    fn save_grant(&self, grant: &KnowledgeGrant) -> impl Future<Output = AppResult<()>> + Send;
    fn exact_grant(
        &self,
        grant_id: Uuid,
    ) -> impl Future<Output = AppResult<Option<KnowledgeGrant>>> + Send;
    fn revoke_grant(&self, grant_id: Uuid) -> impl Future<Output = AppResult<()>> + Send;
}

pub(crate) trait KnowledgeMappingRepositoryPort: Clone + Send + Sync + 'static {
    fn propose_mapping(
        &self,
        proposal: &KnowledgeMappingProposal,
    ) -> impl Future<Output = AppResult<()>> + Send;
    fn decide_mapping(
        &self,
        proposal_id: Uuid,
        expected_graph_revision_id: Uuid,
        state: MappingProposalState,
    ) -> impl Future<Output = AppResult<()>> + Send;
    fn mappings_for_revision(
        &self,
        project_environment_id: Uuid,
        graph_revision_id: Uuid,
    ) -> impl Future<Output = AppResult<Vec<KnowledgeMappingProposal>>> + Send;
}
