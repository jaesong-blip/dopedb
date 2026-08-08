//! OS-owned Local Folder source adapter.
//!
//! Absolute roots stay in this process-local registry. Shared binding and graph
//! values contain only salted-free SHA-256 fingerprints and revision evidence.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use dopedb_protocol::{
    KnowledgeSourceBindingV1, KnowledgeSourceProvider, KnowledgeSourceVisibility,
    SourceRevisionIdentity,
};
use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::super::domain::{
    source_snapshot_digest, validate_binding_draft, ProjectEnvironment, SourceBindingDraft,
    SourceContentHashAlgorithm, SourceFileManifest, SourceHealth, SourceHealthState, SourceLocator,
    SourceSnapshot,
};
use super::super::ports::SourceProviderAdapter;

const MAX_SOURCE_FILES: usize = 100_000;
const MAX_SOURCE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SOURCE_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Default)]
pub(crate) struct LocalFolderAdapter {
    bindings: Arc<DashMap<Uuid, LocalBinding>>,
}

#[derive(Clone)]
struct LocalBinding {
    root: PathBuf,
    environment_revision: u64,
    binding: KnowledgeSourceBindingV1,
}

pub(crate) struct LocalFolderWatch {
    _watcher: RecommendedWatcher,
    pub(crate) changes: tokio::sync::mpsc::Receiver<Vec<String>>,
}

impl LocalFolderAdapter {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn restore(
        &self,
        binding: KnowledgeSourceBindingV1,
        environment_revision: u64,
        root: PathBuf,
    ) -> AppResult<()> {
        let root = canonical_directory(&root)?;
        let root_fingerprint = path_fingerprint(&root);
        if !binding.validate()
            || binding.provider != KnowledgeSourceProvider::LocalFolder
            || environment_revision == 0
            || revision_root_fingerprint(&binding.revision) != Some(root_fingerprint.as_str())
        {
            return Err(AppError::Blocked {
                reason: "the stored Local Folder capability is stale".into(),
            });
        }
        self.bindings.insert(
            binding.source_id,
            LocalBinding {
                root,
                environment_revision,
                binding,
            },
        );
        Ok(())
    }

    pub(crate) async fn bind_for_environment(
        &self,
        draft: &SourceBindingDraft,
        environment: &ProjectEnvironment,
    ) -> AppResult<KnowledgeSourceBindingV1> {
        validate_binding_draft(draft, environment)?;
        let SourceLocator::LocalFolder { root } = &draft.locator else {
            return Err(AppError::Config(
                "the Local Folder adapter received another provider".into(),
            ));
        };
        let root = canonical_directory(root)?;
        let mut revision = resolve_local_revision(&root).await?;
        if matches!(revision, SourceRevisionIdentity::LocalSnapshot { .. }) {
            let scan_root = root.clone();
            let files = tokio::task::spawn_blocking(move || inventory(&scan_root))
                .await
                .map_err(|_| AppError::Config("the Local Folder scanner stopped".into()))??;
            revision = SourceRevisionIdentity::LocalSnapshot {
                root_fingerprint: path_fingerprint(&root),
                snapshot_sha256: source_snapshot_digest(&files),
            };
        }
        let binding = KnowledgeSourceBindingV1 {
            source_id: draft.source_id,
            project_id: draft.project_id,
            project_environment_id: draft.project_environment_id,
            provider: KnowledgeSourceProvider::LocalFolder,
            display_name: draft.display_name.trim().to_owned(),
            visibility: KnowledgeSourceVisibility::LocalOnly,
            revision,
        };
        if !binding.validate() {
            return Err(AppError::Config(
                "the Local Folder revision is invalid".into(),
            ));
        }
        self.bindings.insert(
            binding.source_id,
            LocalBinding {
                root,
                environment_revision: draft.environment_revision,
                binding: binding.clone(),
            },
        );
        Ok(binding)
    }

    fn local_binding(&self, source_id: Uuid) -> AppResult<LocalBinding> {
        self.bindings
            .get(&source_id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| AppError::NotFound("a process-local Knowledge source binding".into()))
    }
}

impl SourceProviderAdapter for LocalFolderAdapter {
    type Watch = LocalFolderWatch;

    async fn discover(&self) -> AppResult<Vec<String>> {
        let mut names = self
            .bindings
            .iter()
            .map(|entry| entry.binding.display_name.clone())
            .collect::<Vec<_>>();
        names.sort();
        names.dedup();
        Ok(names)
    }

    async fn bind(&self, _draft: &SourceBindingDraft) -> AppResult<KnowledgeSourceBindingV1> {
        Err(AppError::Config(
            "Local Folder binding requires an exact ProjectEnvironment revision".into(),
        ))
    }

    async fn resolve_revision(
        &self,
        binding: &KnowledgeSourceBindingV1,
    ) -> AppResult<SourceRevisionIdentity> {
        let local = self.local_binding(binding.source_id)?;
        require_same_binding(binding, &local.binding)?;
        resolve_local_revision(&local.root).await
    }

    async fn snapshot(
        &self,
        binding: &KnowledgeSourceBindingV1,
        previous: Option<&SourceSnapshot>,
    ) -> AppResult<SourceSnapshot> {
        let local = self.local_binding(binding.source_id)?;
        require_same_binding(binding, &local.binding)?;
        let root = local.root.clone();
        let files = tokio::task::spawn_blocking(move || inventory(&root))
            .await
            .map_err(|_| AppError::Config("the Local Folder scanner stopped".into()))??;
        let revision = resolve_local_revision(&local.root).await?;
        let snapshot_sha256 = source_snapshot_digest(&files);
        let revision = match revision {
            SourceRevisionIdentity::LocalGit { .. } => revision,
            SourceRevisionIdentity::LocalSnapshot {
                root_fingerprint, ..
            } => SourceRevisionIdentity::LocalSnapshot {
                root_fingerprint,
                snapshot_sha256: snapshot_sha256.clone(),
            },
            SourceRevisionIdentity::Github { .. } => unreachable!("local revision resolver"),
        };
        let mut projected_binding = local.binding.clone();
        projected_binding.revision = revision;
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
        self.bindings.insert(
            projected_binding.source_id,
            LocalBinding {
                root: local.root,
                environment_revision: local.environment_revision,
                binding: projected_binding.clone(),
            },
        );
        Ok(SourceSnapshot {
            binding: projected_binding,
            environment_revision: local.environment_revision,
            source_revision_sha256: snapshot_sha256,
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
            SourceRevisionIdentity::LocalGit {
                git_root_fingerprint: before_root,
                commit_sha: before_commit,
                ..
            },
            SourceRevisionIdentity::LocalGit {
                git_root_fingerprint: after_root,
                commit_sha: after_commit,
                ..
            },
        ) = (before, after)
        else {
            return Err(AppError::Config(
                "non-Git Local Folder changes require adjacent snapshot manifests".into(),
            ));
        };
        if before_root != after_root {
            return Err(AppError::Blocked {
                reason: "Local Git change comparison crossed repository identity".into(),
            });
        }
        let local = self
            .bindings
            .iter()
            .find(|entry| revision_git_root(&entry.binding.revision) == Some(before_root.as_str()))
            .map(|entry| entry.value().clone())
            .ok_or_else(|| AppError::NotFound("the Local Git binding".into()))?;
        let output = run_git_bounded(
            &local.root,
            &[
                "diff",
                "--name-only",
                "--no-renames",
                before_commit,
                after_commit,
                "--",
            ],
        )
        .await?;
        bounded_paths(&output)
    }

    async fn read_file_at_revision(
        &self,
        binding: &KnowledgeSourceBindingV1,
        revision: &SourceRevisionIdentity,
        path: &str,
    ) -> AppResult<Vec<u8>> {
        let local = self.local_binding(binding.source_id)?;
        require_same_binding(binding, &local.binding)?;
        let current = resolve_local_revision(&local.root).await?;
        let revision_matches = match (&current, revision) {
            (SourceRevisionIdentity::LocalGit { .. }, SourceRevisionIdentity::LocalGit { .. }) => {
                &current == revision
            }
            (
                SourceRevisionIdentity::LocalSnapshot {
                    root_fingerprint: current_root,
                    ..
                },
                SourceRevisionIdentity::LocalSnapshot {
                    root_fingerprint: expected_root,
                    ..
                },
            ) => current_root == expected_root,
            _ => false,
        };
        if !revision_matches {
            return Err(AppError::Blocked {
                reason: "the Local Folder revision changed; rebuild before reading evidence".into(),
            });
        }
        let path = checked_file(&local.root, path)?;
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_SOURCE_FILE_BYTES {
            return Err(AppError::Blocked {
                reason: "the Knowledge source file is not a bounded regular file".into(),
            });
        }
        Ok(std::fs::read(path)?)
    }

    async fn watch(&self, binding: &KnowledgeSourceBindingV1) -> AppResult<Self::Watch> {
        let local = self.local_binding(binding.source_id)?;
        require_same_binding(binding, &local.binding)?;
        let root = local.root.clone();
        let callback_root = root.clone();
        let (changes_tx, changes) = tokio::sync::mpsc::channel(64);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else { return };
                let paths = event
                    .paths
                    .into_iter()
                    .filter(|path| supported_source_event(&callback_root, path))
                    .filter_map(|path| relative_source_path(&callback_root, &path).ok())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>();
                if !paths.is_empty() {
                    let _ = changes_tx.try_send(paths);
                }
            })
            .map_err(|_| AppError::Config("the Local Folder watcher is unavailable".into()))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|_| AppError::Config("the Local Folder could not be watched".into()))?;
        Ok(LocalFolderWatch {
            _watcher: watcher,
            changes,
        })
    }

    async fn health(&self, binding: &KnowledgeSourceBindingV1) -> AppResult<SourceHealth> {
        let local = self.local_binding(binding.source_id)?;
        let state = if require_same_binding(binding, &local.binding).is_ok()
            && resolve_local_revision(&local.root).await.is_ok()
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
                .then(|| "local_source_changed".into()),
        })
    }

    async fn revoke(&self, binding: &KnowledgeSourceBindingV1) -> AppResult<()> {
        let local = self.local_binding(binding.source_id)?;
        require_same_binding(binding, &local.binding)?;
        self.bindings.remove(&binding.source_id);
        Ok(())
    }
}

async fn resolve_local_revision(root: &Path) -> AppResult<SourceRevisionIdentity> {
    let root_fingerprint = path_fingerprint(root);
    let git_root = match run_git_bounded(root, &["rev-parse", "--show-toplevel"]).await {
        Ok(value) => PathBuf::from(value.trim()),
        Err(_) => {
            return Ok(SourceRevisionIdentity::LocalSnapshot {
                root_fingerprint,
                snapshot_sha256: "0".repeat(64),
            });
        }
    };
    let git_root = canonical_directory(&git_root)?;
    let commit_sha = run_git_bounded(root, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_owned();
    if !valid_sha1(&commit_sha) {
        return Err(AppError::Config("the Local Git commit is invalid".into()));
    }
    let ref_name = run_git_bounded(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .map(|value| value.trim().to_owned())
        .unwrap_or_else(|_| format!("detached/{commit_sha}"));
    let status = run_git_bounded(
        root,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )
    .await?;
    let git_dir = resolve_git_metadata_path(
        root,
        run_git_bounded(root, &["rev-parse", "--git-dir"])
            .await?
            .trim(),
    )?;
    let common_dir = resolve_git_metadata_path(
        root,
        run_git_bounded(root, &["rev-parse", "--git-common-dir"])
            .await?
            .trim(),
    )?;
    Ok(SourceRevisionIdentity::LocalGit {
        root_fingerprint,
        git_root_fingerprint: path_fingerprint(&git_root),
        ref_name,
        commit_sha,
        dirty: !status.trim().is_empty(),
        worktree: git_dir != common_dir,
    })
}

async fn run_git_bounded(root: &Path, args: &[&str]) -> AppResult<String> {
    let mut child = tokio::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| AppError::Config("system Git is unavailable".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Config("Git stdout is unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Config("Git stderr is unavailable".into()))?;
    let read_stdout = read_stream_bounded(stdout, MAX_GIT_OUTPUT_BYTES);
    let read_stderr = read_stream_bounded(stderr, 64 * 1024);
    let result = tokio::time::timeout(GIT_TIMEOUT, async {
        let (stdout, stderr, status) = tokio::join!(read_stdout, read_stderr, child.wait());
        Ok::<_, AppError>((stdout?, stderr?, status?))
    })
    .await
    .map_err(|_| AppError::Timeout("system Git exceeded 30 seconds".into()))??;
    if !result.2.success() {
        return Err(AppError::Config(
            "system Git could not resolve the Local Folder".into(),
        ));
    }
    String::from_utf8(result.0)
        .map_err(|_| AppError::Config("system Git returned non-UTF-8 output".into()))
}

async fn read_stream_bounded(
    stream: impl tokio::io::AsyncRead + Unpin,
    maximum: u64,
) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    stream.take(maximum + 1).read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > maximum {
        return Err(AppError::Blocked {
            reason: "system Git output exceeded its safety bound".into(),
        });
    }
    Ok(bytes)
}

fn inventory(root: &Path) -> AppResult<Vec<SourceFileManifest>> {
    let mut files = Vec::new();
    let mut total = 0u64;
    let walker = WalkBuilder::new(root)
        .standard_filters(true)
        .hidden(false)
        .follow_links(false)
        .filter_entry(|entry| !excluded_directory(entry.path()))
        .build();
    for entry in walker {
        let entry =
            entry.map_err(|_| AppError::Config("the Local Folder could not be scanned".into()))?;
        let file_type = entry.file_type().ok_or_else(|| AppError::Blocked {
            reason: "a Local Folder entry has no filesystem type".into(),
        })?;
        if !file_type.is_file() || !supported_source_file(entry.path()) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_SOURCE_FILE_BYTES {
            continue;
        }
        total = total
            .checked_add(metadata.len())
            .ok_or_else(|| AppError::Blocked {
                reason: "the Local Folder snapshot size overflowed".into(),
            })?;
        if total > MAX_SOURCE_SNAPSHOT_BYTES || files.len() >= MAX_SOURCE_FILES {
            return Err(AppError::Blocked {
                reason: "the Local Folder exceeds the Knowledge snapshot budget".into(),
            });
        }
        files.push(SourceFileManifest {
            path: relative_source_path(root, entry.path())?,
            content_hash: sha256_file(entry.path())?,
            hash_algorithm: SourceContentHashAlgorithm::Sha256,
            bytes: metadata.len(),
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn excluded_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | "vendor"
            )
        })
}

fn supported_source_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "rs" | "ts"
                    | "tsx"
                    | "js"
                    | "jsx"
                    | "mjs"
                    | "cjs"
                    | "py"
                    | "go"
                    | "java"
                    | "kt"
                    | "kts"
                    | "sql"
                    | "rb"
                    | "php"
                    | "cs"
                    | "c"
                    | "cc"
                    | "cpp"
                    | "h"
                    | "hpp"
                    | "swift"
                    | "vue"
                    | "svelte"
                    | "json"
                    | "yaml"
                    | "yml"
                    | "toml"
            )
        })
}

fn supported_source_event(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    supported_source_file(relative)
        && relative.components().all(|component| match component {
            Component::Normal(name) => !matches!(
                name.to_str(),
                Some(".git" | "node_modules" | "target" | "dist" | "build" | ".next" | "vendor")
            ),
            _ => false,
        })
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn canonical_directory(path: &Path) -> AppResult<PathBuf> {
    let path = std::fs::canonicalize(path)?;
    if !std::fs::symlink_metadata(&path)?.file_type().is_dir() {
        return Err(AppError::Config(
            "the Local Folder is not a directory".into(),
        ));
    }
    Ok(path)
}

fn resolve_git_metadata_path(root: &Path, value: &str) -> AppResult<PathBuf> {
    if value.is_empty() {
        return Err(AppError::Config(
            "system Git returned an empty metadata path".into(),
        ));
    }
    let path = Path::new(value);
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    };
    std::fs::canonicalize(path)
        .map_err(|_| AppError::Config("system Git metadata could not be resolved".into()))
}

fn checked_file(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::Blocked {
            reason: "the Knowledge source path is unsafe".into(),
        });
    }
    let joined = root.join(path);
    let canonical = std::fs::canonicalize(&joined)?;
    if !canonical.starts_with(root) || std::fs::symlink_metadata(&joined)?.file_type().is_symlink()
    {
        return Err(AppError::Blocked {
            reason: "the Knowledge source path escaped its Local Folder".into(),
        });
    }
    Ok(canonical)
}

fn relative_source_path(root: &Path, path: &Path) -> AppResult<String> {
    let relative = path.strip_prefix(root).map_err(|_| AppError::Blocked {
        reason: "the Knowledge source event escaped its Local Folder".into(),
    })?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::Blocked {
            reason: "the Knowledge source path is unsafe".into(),
        });
    }
    relative
        .to_str()
        .map(|value| value.replace('\\', "/"))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Config("the Knowledge source path is not Unicode".into()))
}

fn bounded_paths(value: &str) -> AppResult<Vec<String>> {
    let paths = value
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let path = Path::new(line);
            if path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            {
                return Err(AppError::Blocked {
                    reason: "system Git returned an unsafe path".into(),
                });
            }
            Ok(line.replace('\\', "/"))
        })
        .collect::<AppResult<BTreeSet<_>>>()?;
    if paths.len() > MAX_SOURCE_FILES {
        return Err(AppError::Blocked {
            reason: "system Git returned too many changed files".into(),
        });
    }
    Ok(paths.into_iter().collect())
}

fn path_fingerprint(path: &Path) -> String {
    hex::encode(Sha256::digest(
        path.as_os_str().to_string_lossy().as_bytes(),
    ))
}

fn require_same_binding(
    received: &KnowledgeSourceBindingV1,
    local: &KnowledgeSourceBindingV1,
) -> AppResult<()> {
    if received != local {
        return Err(AppError::Blocked {
            reason: "the Local Folder binding changed or crossed environment scope".into(),
        });
    }
    Ok(())
}

fn revision_git_root(revision: &SourceRevisionIdentity) -> Option<&str> {
    match revision {
        SourceRevisionIdentity::LocalGit {
            git_root_fingerprint,
            ..
        } => Some(git_root_fingerprint),
        _ => None,
    }
}

fn revision_root_fingerprint(revision: &SourceRevisionIdentity) -> Option<&str> {
    match revision {
        SourceRevisionIdentity::LocalGit {
            root_fingerprint, ..
        }
        | SourceRevisionIdentity::LocalSnapshot {
            root_fingerprint, ..
        } => Some(root_fingerprint),
        SourceRevisionIdentity::Github { .. } => None,
    }
}

fn valid_sha1(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
