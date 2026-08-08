//! Read-only GitHub App source adapter backed by the workspace control plane.
//!
//! Desktop never receives an installation token. It requests an exact commit
//! manifest and then one manifest-approved blob at a time.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use dopedb_protocol::{
    KnowledgeSourceBindingV1, KnowledgeSourceProvider, KnowledgeSourceVisibility,
    SourceRevisionIdentity,
};
use sha1::{Digest as Sha1Digest, Sha1};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::workspaces::adapters::control_plane::{
    create_knowledge_source, delete_knowledge_source, knowledge_source_events,
    knowledge_source_snapshot, list_knowledge_github_repositories, read_knowledge_source_blob,
    CreateKnowledgeSourceRequest, RemoteGithubRepository,
};
use crate::kernel::identity::{AccountId, WorkspaceId};

use super::super::domain::{
    source_snapshot_digest, validate_binding_draft, ProjectEnvironment, SourceBindingDraft,
    SourceContentHashAlgorithm, SourceFileManifest, SourceHealth, SourceHealthState, SourceLocator,
    SourceSnapshot,
};
use super::super::ports::SourceProviderAdapter;

const WATCH_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub(crate) struct GithubSourceAdapter {
    account_id: AccountId,
    workspace_id: WorkspaceId,
    environment: ProjectEnvironment,
    bindings: Arc<DashMap<Uuid, GithubBinding>>,
}

#[derive(Clone)]
struct GithubBinding {
    binding: KnowledgeSourceBindingV1,
    environment_revision: u64,
    repository_id: String,
    repository: String,
    ref_name: String,
    files: BTreeMap<String, GithubFile>,
}

#[derive(Clone)]
struct GithubFile {
    blob_sha: String,
    bytes: u64,
}

pub(crate) struct GithubSourceWatch {
    _task: tokio::task::JoinHandle<()>,
    pub(crate) changes: tokio::sync::mpsc::Receiver<Vec<String>>,
}

impl GithubSourceAdapter {
    pub(crate) fn new(
        account_id: AccountId,
        workspace_id: WorkspaceId,
        environment: ProjectEnvironment,
    ) -> Self {
        Self {
            account_id,
            workspace_id,
            environment,
            bindings: Arc::new(DashMap::new()),
        }
    }

    pub(crate) async fn repositories(&self) -> AppResult<Vec<RemoteGithubRepository>> {
        list_knowledge_github_repositories(self.account_id.as_str(), self.workspace_id.into()).await
    }

    pub(crate) fn restore(
        &self,
        binding: KnowledgeSourceBindingV1,
        environment_revision: u64,
    ) -> AppResult<()> {
        let SourceRevisionIdentity::Github {
            repository_id,
            repository,
            ref_name,
            ..
        } = &binding.revision
        else {
            return Err(AppError::Config(
                "the stored GitHub Knowledge revision is invalid".into(),
            ));
        };
        if !binding.validate()
            || binding.provider != KnowledgeSourceProvider::Github
            || binding.project_environment_id != self.environment.id
            || environment_revision != self.environment.revision
        {
            return Err(AppError::Blocked {
                reason: "the stored GitHub Knowledge binding is stale".into(),
            });
        }
        self.bindings.insert(
            binding.source_id,
            GithubBinding {
                binding: binding.clone(),
                environment_revision,
                repository_id: repository_id.clone(),
                repository: repository.clone(),
                ref_name: ref_name.clone(),
                files: BTreeMap::new(),
            },
        );
        Ok(())
    }

    fn local_binding(&self, source_id: Uuid) -> AppResult<GithubBinding> {
        self.bindings
            .get(&source_id)
            .map(|value| value.value().clone())
            .ok_or_else(|| AppError::NotFound("the GitHub Knowledge source binding".into()))
    }

    async fn remote_snapshot(
        &self,
        local: &GithubBinding,
    ) -> AppResult<(
        KnowledgeSourceBindingV1,
        Vec<SourceFileManifest>,
        BTreeMap<String, GithubFile>,
    )> {
        let snapshot = knowledge_source_snapshot(
            self.account_id.as_str(),
            self.workspace_id.into(),
            local.binding.source_id,
        )
        .await?;
        if snapshot.environment_revision != local.environment_revision
            || snapshot.repository != local.repository
        {
            return Err(AppError::Blocked {
                reason: "the GitHub Knowledge snapshot crossed source scope".into(),
            });
        }
        let revision = SourceRevisionIdentity::Github {
            repository_id: local.repository_id.clone(),
            repository: local.repository.clone(),
            ref_name: local.ref_name.clone(),
            commit_sha: snapshot.commit_sha,
        };
        let mut binding = local.binding.clone();
        binding.revision = revision;
        if !binding.validate() {
            return Err(AppError::Network(
                "GitHub Knowledge returned an invalid source revision".into(),
            ));
        }
        let files = snapshot
            .files
            .into_iter()
            .map(|file| SourceFileManifest {
                path: file.path,
                content_hash: file.blob_sha,
                hash_algorithm: SourceContentHashAlgorithm::GitSha1,
                bytes: file.bytes,
            })
            .collect::<Vec<_>>();
        let file_index = files
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    GithubFile {
                        blob_sha: file.content_hash.clone(),
                        bytes: file.bytes,
                    },
                )
            })
            .collect();
        Ok((binding, files, file_index))
    }
}

impl SourceProviderAdapter for GithubSourceAdapter {
    type Watch = GithubSourceWatch;

    async fn discover(&self) -> AppResult<Vec<String>> {
        Ok(self
            .repositories()
            .await?
            .into_iter()
            .filter(|repository| !repository.archived)
            .map(|repository| repository.full_name)
            .collect())
    }

    async fn bind(&self, draft: &SourceBindingDraft) -> AppResult<KnowledgeSourceBindingV1> {
        validate_binding_draft(draft, &self.environment)?;
        let SourceLocator::Github {
            installation_id,
            repository_id,
            repository,
            ref_name,
        } = &draft.locator
        else {
            return Err(AppError::Config(
                "the GitHub adapter received another provider".into(),
            ));
        };
        create_knowledge_source(
            self.account_id.as_str(),
            self.workspace_id.into(),
            &CreateKnowledgeSourceRequest {
                source_id: draft.source_id,
                provider: "github",
                project_id: draft.project_id,
                project_environment_id: draft.project_environment_id,
                display_name: &draft.display_name,
                installation_id: Some(*installation_id),
                repository_id: Some(repository_id),
                repository_full_name: Some(repository),
                ref_name: Some(ref_name),
                root_fingerprint: None,
                snapshot_sha256: None,
                publish_approved: None,
                exposure: None,
            },
        )
        .await?;
        let placeholder = GithubBinding {
            binding: KnowledgeSourceBindingV1 {
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
                    commit_sha: "0".repeat(40),
                },
            },
            environment_revision: draft.environment_revision,
            repository_id: repository_id.clone(),
            repository: repository.clone(),
            ref_name: ref_name.clone(),
            files: BTreeMap::new(),
        };
        let (binding, _, files) = self.remote_snapshot(&placeholder).await?;
        self.bindings.insert(
            binding.source_id,
            GithubBinding {
                binding: binding.clone(),
                files,
                ..placeholder
            },
        );
        Ok(binding)
    }

    async fn resolve_revision(
        &self,
        binding: &KnowledgeSourceBindingV1,
    ) -> AppResult<SourceRevisionIdentity> {
        let local = self.local_binding(binding.source_id)?;
        require_binding_scope(binding, &local)?;
        let (binding, _, _) = self.remote_snapshot(&local).await?;
        Ok(binding.revision)
    }

    async fn snapshot(
        &self,
        binding: &KnowledgeSourceBindingV1,
        previous: Option<&SourceSnapshot>,
    ) -> AppResult<SourceSnapshot> {
        let local = self.local_binding(binding.source_id)?;
        require_binding_scope(binding, &local)?;
        let (projected_binding, files, file_index) = self.remote_snapshot(&local).await?;
        let previous_files = previous
            .map(|snapshot| {
                snapshot
                    .files
                    .iter()
                    .map(|file| (file.path.as_str(), file.content_hash.as_str()))
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        let current_files = files
            .iter()
            .map(|file| (file.path.as_str(), file.content_hash.as_str()))
            .collect::<BTreeMap<_, _>>();
        let changed_files = previous_files
            .keys()
            .chain(current_files.keys())
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|path| previous_files.get(path) != current_files.get(path))
            .map(ToOwned::to_owned)
            .collect();
        let source_revision_sha256 = source_snapshot_digest(&files);
        self.bindings.insert(
            projected_binding.source_id,
            GithubBinding {
                binding: projected_binding.clone(),
                files: file_index,
                ..local
            },
        );
        Ok(SourceSnapshot {
            binding: projected_binding,
            environment_revision: self.environment.revision,
            source_revision_sha256,
            files,
            changed_files,
        })
    }

    async fn list_changes(
        &self,
        before: &SourceRevisionIdentity,
        after: &SourceRevisionIdentity,
    ) -> AppResult<Vec<String>> {
        let (
            SourceRevisionIdentity::Github {
                repository_id: before_repository,
                commit_sha: before_commit,
                ..
            },
            SourceRevisionIdentity::Github {
                repository_id: after_repository,
                commit_sha: after_commit,
                ..
            },
        ) = (before, after)
        else {
            return Err(AppError::Config(
                "GitHub change comparison requires two GitHub revisions".into(),
            ));
        };
        if before_repository != after_repository {
            return Err(AppError::Blocked {
                reason: "GitHub change comparison crossed repository identity".into(),
            });
        }
        let source_id = self
            .bindings
            .iter()
            .find(|entry| entry.repository_id == *before_repository)
            .map(|entry| *entry.key())
            .ok_or_else(|| AppError::NotFound("the GitHub Knowledge source".into()))?;
        let events = knowledge_source_events(
            self.account_id.as_str(),
            self.workspace_id.into(),
            source_id,
        )
        .await?;
        Ok(events
            .into_iter()
            .find(|event| {
                event.before_commit_sha.as_deref() == Some(before_commit)
                    && event.after_commit_sha.as_deref() == Some(after_commit)
            })
            .map(|event| event.changed_files)
            .unwrap_or_default())
    }

    async fn read_file_at_revision(
        &self,
        binding: &KnowledgeSourceBindingV1,
        revision: &SourceRevisionIdentity,
        path: &str,
    ) -> AppResult<Vec<u8>> {
        let local = self.local_binding(binding.source_id)?;
        require_binding_scope(binding, &local)?;
        if &local.binding.revision != revision {
            return Err(AppError::Blocked {
                reason: "the GitHub revision changed before evidence could be read".into(),
            });
        }
        let file = local
            .files
            .get(path)
            .ok_or_else(|| AppError::NotFound("the manifest-approved source file".into()))?;
        let bytes = read_knowledge_source_blob(
            self.account_id.as_str(),
            self.workspace_id.into(),
            binding.source_id,
            path,
            &file.blob_sha,
        )
        .await?;
        if bytes.len() as u64 != file.bytes || git_blob_sha1(&bytes) != file.blob_sha {
            return Err(AppError::Blocked {
                reason: "the GitHub source blob changed or failed integrity validation".into(),
            });
        }
        Ok(bytes)
    }

    async fn watch(&self, binding: &KnowledgeSourceBindingV1) -> AppResult<Self::Watch> {
        let local = self.local_binding(binding.source_id)?;
        require_binding_scope(binding, &local)?;
        let account_id = self.account_id.clone();
        let workspace_id = self.workspace_id;
        let source_id = binding.source_id;
        let (changes_tx, changes) = tokio::sync::mpsc::channel(16);
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(WATCH_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut delivered = BTreeSet::new();
            loop {
                interval.tick().await;
                let Ok(events) =
                    knowledge_source_events(account_id.as_str(), workspace_id.into(), source_id)
                        .await
                else {
                    continue;
                };
                for event in events {
                    if delivered.insert(event.id) {
                        let _ = changes_tx.send(event.changed_files).await;
                    }
                }
                while delivered.len() > 1_000 {
                    let Some(first) = delivered.first().copied() else {
                        break;
                    };
                    delivered.remove(&first);
                }
            }
        });
        Ok(GithubSourceWatch {
            _task: task,
            changes,
        })
    }

    async fn health(&self, binding: &KnowledgeSourceBindingV1) -> AppResult<SourceHealth> {
        let local = self.local_binding(binding.source_id)?;
        let state = if require_binding_scope(binding, &local).is_ok()
            && self.remote_snapshot(&local).await.is_ok()
        {
            SourceHealthState::Ready
        } else {
            SourceHealthState::Failed
        };
        Ok(SourceHealth {
            state,
            last_good_graph_revision_id: None,
            checked_at: chrono::Utc::now(),
            failure_code: (state == SourceHealthState::Failed)
                .then(|| "github_source_unavailable".into()),
        })
    }

    async fn revoke(&self, binding: &KnowledgeSourceBindingV1) -> AppResult<()> {
        let local = self.local_binding(binding.source_id)?;
        require_binding_scope(binding, &local)?;
        delete_knowledge_source(
            self.account_id.as_str(),
            self.workspace_id.into(),
            binding.source_id,
        )
        .await?;
        self.bindings.remove(&binding.source_id);
        Ok(())
    }
}

fn require_binding_scope(
    received: &KnowledgeSourceBindingV1,
    local: &GithubBinding,
) -> AppResult<()> {
    if received.source_id != local.binding.source_id
        || received.project_id != local.binding.project_id
        || received.project_environment_id != local.binding.project_environment_id
        || received.provider != KnowledgeSourceProvider::Github
    {
        return Err(AppError::Blocked {
            reason: "the GitHub Knowledge binding crossed environment scope".into(),
        });
    }
    Ok(())
}

fn git_blob_sha1(bytes: &[u8]) -> String {
    let mut hash = Sha1::new();
    hash.update(format!("blob {}\0", bytes.len()).as_bytes());
    hash.update(bytes);
    hex::encode(hash.finalize())
}
