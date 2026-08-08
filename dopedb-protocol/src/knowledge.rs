//! Provider-neutral Project Knowledge wire contracts.
//!
//! These values deliberately cannot carry a local folder path, repository token,
//! source file body, provider credential, or inferred fact without provenance.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const GRAPH_BUILD_ARTIFACT_SCHEMA_VERSION: u16 = 1;
pub const MAX_KNOWLEDGE_NODES: usize = 200_000;
pub const MAX_KNOWLEDGE_EDGES: usize = 600_000;
pub const MAX_KNOWLEDGE_EVIDENCE: usize = 600_000;
pub const MAX_KNOWLEDGE_STRING_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeSourceProvider {
    Github,
    LocalFolder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceProviderCapability {
    Discover,
    Bind,
    ResolveRevision,
    Snapshot,
    ListChanges,
    ReadFileAtRevision,
    Watch,
    Health,
    Revoke,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeSourceVisibility {
    LocalOnly,
    SharedGraph,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceRevisionIdentity {
    Github {
        repository_id: String,
        repository: String,
        ref_name: String,
        commit_sha: String,
    },
    LocalGit {
        root_fingerprint: String,
        git_root_fingerprint: String,
        ref_name: String,
        commit_sha: String,
        dirty: bool,
        worktree: bool,
    },
    LocalSnapshot {
        root_fingerprint: String,
        snapshot_sha256: String,
    },
}

impl SourceRevisionIdentity {
    pub fn validate(&self) -> bool {
        match self {
            Self::Github {
                repository_id,
                repository,
                ref_name,
                commit_sha,
            } => {
                safe_text(repository_id)
                    && safe_repository(repository)
                    && safe_ref(ref_name)
                    && sha1(commit_sha)
            }
            Self::LocalGit {
                root_fingerprint,
                git_root_fingerprint,
                ref_name,
                commit_sha,
                ..
            } => {
                sha256(root_fingerprint)
                    && sha256(git_root_fingerprint)
                    && safe_ref(ref_name)
                    && sha1(commit_sha)
            }
            Self::LocalSnapshot {
                root_fingerprint,
                snapshot_sha256,
            } => sha256(root_fingerprint) && sha256(snapshot_sha256),
        }
    }

    pub fn is_dirty_local(&self) -> bool {
        matches!(self, Self::LocalGit { dirty: true, .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSourceBindingV1 {
    pub source_id: Uuid,
    pub project_id: Uuid,
    pub project_environment_id: Uuid,
    pub provider: KnowledgeSourceProvider,
    pub display_name: String,
    pub visibility: KnowledgeSourceVisibility,
    pub revision: SourceRevisionIdentity,
}

impl KnowledgeSourceBindingV1 {
    pub fn validate(&self) -> bool {
        safe_text(&self.display_name)
            && self.revision.validate()
            && matches!(
                (&self.provider, &self.revision),
                (
                    KnowledgeSourceProvider::Github,
                    SourceRevisionIdentity::Github { .. }
                ) | (
                    KnowledgeSourceProvider::LocalFolder,
                    SourceRevisionIdentity::LocalGit { .. }
                ) | (
                    KnowledgeSourceProvider::LocalFolder,
                    SourceRevisionIdentity::LocalSnapshot { .. }
                )
            )
            && !(self.visibility == KnowledgeSourceVisibility::SharedGraph
                && self.revision.is_dirty_local())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeNodeKind {
    File,
    Module,
    Type,
    Function,
    Route,
    Table,
    Column,
    Migration,
    Event,
    Funnel,
    Dashboard,
    Report,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeRelation {
    Defines,
    Imports,
    Calls,
    HandlesRoute,
    ReadsTable,
    WritesTable,
    EmitsEvent,
    MigrationDefinesTable,
    MigrationDefinesColumn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KnowledgeEvidenceState {
    Extracted,
    AgentProposed,
    Verified,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeNodeV1 {
    pub id: String,
    pub kind: KnowledgeNodeKind,
    pub name: String,
    pub qualified_name: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeEdgeV1 {
    pub id: String,
    pub from: String,
    pub to: String,
    pub relation: KnowledgeRelation,
    pub state: KnowledgeEvidenceState,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeEvidenceV1 {
    pub id: String,
    pub source_id: Uuid,
    pub source_revision_sha256: String,
    pub file_path: String,
    pub line_start: u32,
    pub line_end: u32,
    pub extraction_method: String,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphExtractorIdentityV1 {
    pub id: String,
    pub version: String,
    pub source_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphBuildHealthV1 {
    pub complete: bool,
    pub parsed_files: u64,
    pub skipped_files: u64,
    pub failed_files: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphBuildArtifactV1 {
    pub schema_version: u16,
    pub graph_revision_id: Uuid,
    pub environment_revision: u64,
    pub binding: KnowledgeSourceBindingV1,
    pub source_revision_sha256: String,
    pub parent_graph_revision_id: Option<Uuid>,
    pub extractor: GraphExtractorIdentityV1,
    pub generated_at: DateTime<Utc>,
    pub health: GraphBuildHealthV1,
    pub changed_files: Vec<String>,
    pub nodes: Vec<KnowledgeNodeV1>,
    pub edges: Vec<KnowledgeEdgeV1>,
    pub evidence: Vec<KnowledgeEvidenceV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphRevisionDiffV1 {
    pub project_environment_id: Uuid,
    pub from_graph_revision_id: Uuid,
    pub to_graph_revision_id: Uuid,
    pub added_node_ids: Vec<String>,
    pub removed_node_ids: Vec<String>,
    pub added_edge_ids: Vec<String>,
    pub removed_edge_ids: Vec<String>,
    pub changed_files: Vec<String>,
}

impl GraphRevisionDiffV1 {
    pub fn validate(&self) -> bool {
        self.from_graph_revision_id != self.to_graph_revision_id
            && bounded_unique_hashes(&self.added_node_ids, MAX_KNOWLEDGE_NODES)
            && bounded_unique_hashes(&self.removed_node_ids, MAX_KNOWLEDGE_NODES)
            && bounded_unique_hashes(&self.added_edge_ids, MAX_KNOWLEDGE_EDGES)
            && bounded_unique_hashes(&self.removed_edge_ids, MAX_KNOWLEDGE_EDGES)
            && bounded_unique_paths(&self.changed_files)
    }
}

impl GraphBuildArtifactV1 {
    pub fn validate(&self) -> bool {
        if self.schema_version != GRAPH_BUILD_ARTIFACT_SCHEMA_VERSION
            || self.environment_revision == 0
            || !self.binding.validate()
            || !sha256(&self.source_revision_sha256)
            || !safe_text(&self.extractor.id)
            || !safe_version(&self.extractor.version)
            || !sha256(&self.extractor.source_sha256)
            || !self.health.complete
            || self.health.failed_files != 0
            || self.nodes.len() > MAX_KNOWLEDGE_NODES
            || self.edges.len() > MAX_KNOWLEDGE_EDGES
            || self.evidence.len() > MAX_KNOWLEDGE_EVIDENCE
            || !bounded_unique_paths(&self.changed_files)
        {
            return false;
        }

        let node_ids = self
            .nodes
            .iter()
            .filter(|node| {
                sha256(&node.id)
                    && safe_text(&node.name)
                    && safe_text(&node.qualified_name)
                    && node.attributes.len() <= 64
                    && node
                        .attributes
                        .iter()
                        .all(|(key, value)| safe_text(key) && safe_text(value))
            })
            .map(|node| node.id.as_str())
            .collect::<BTreeSet<_>>();
        if node_ids.len() != self.nodes.len() {
            return false;
        }

        let evidence_ids = self
            .evidence
            .iter()
            .filter(|evidence| {
                sha256(&evidence.id)
                    && evidence.source_id == self.binding.source_id
                    && evidence.source_revision_sha256 == self.source_revision_sha256
                    && safe_relative_path(&evidence.file_path)
                    && evidence.line_start > 0
                    && evidence.line_end >= evidence.line_start
                    && safe_text(&evidence.extraction_method)
            })
            .map(|evidence| evidence.id.as_str())
            .collect::<BTreeSet<_>>();
        if evidence_ids.len() != self.evidence.len() {
            return false;
        }

        let edge_ids = self
            .edges
            .iter()
            .filter(|edge| {
                sha256(&edge.id)
                    && node_ids.contains(edge.from.as_str())
                    && node_ids.contains(edge.to.as_str())
                    && !edge.evidence_ids.is_empty()
                    && edge.evidence_ids.len() <= 64
                    && edge
                        .evidence_ids
                        .iter()
                        .all(|id| evidence_ids.contains(id.as_str()))
                    && edge.state != KnowledgeEvidenceState::AgentProposed
            })
            .map(|edge| edge.id.as_str())
            .collect::<BTreeSet<_>>();
        edge_ids.len() == self.edges.len()
    }
}

fn bounded_unique_paths(paths: &[String]) -> bool {
    paths.len() <= 100_000
        && paths.iter().all(|path| safe_relative_path(path))
        && paths.iter().collect::<BTreeSet<_>>().len() == paths.len()
}

fn bounded_unique_hashes(values: &[String], maximum: usize) -> bool {
    values.len() <= maximum
        && values.iter().all(|value| sha256(value))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

fn safe_repository(value: &str) -> bool {
    let mut parts = value.split('/');
    parts.next().is_some_and(safe_slug)
        && parts.next().is_some_and(safe_slug)
        && parts.next().is_none()
}

fn safe_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn safe_ref(value: &str) -> bool {
    safe_text(value)
        && !value.starts_with(['/', '.'])
        && !value.ends_with(['/', '.'])
        && !value.contains("..")
        && !value.contains("//")
        && !value.contains("@{")
        && !value.contains(['\\', '~', '^', ':', '?', '*', '['])
}

fn safe_relative_path(value: &str) -> bool {
    safe_text(value)
        && !value.starts_with(['/', '\\'])
        && !value
            .split(['/', '\\'])
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
}

fn safe_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_KNOWLEDGE_STRING_BYTES
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

fn safe_version(value: &str) -> bool {
    safe_text(value)
        && value.split('.').count().eq(&3)
        && value
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn sha1(value: &str) -> bool {
    value.len() == 40 && lower_hex(value)
}

fn sha256(value: &str) -> bool {
    value.len() == 64 && lower_hex(value)
}

fn lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
