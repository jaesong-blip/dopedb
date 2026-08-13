use std::collections::{BTreeMap, BTreeSet};
#[cfg(windows)]
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dopedb_protocol::{AcpPluginId, SignedAcpPluginManifestV1};
use futures::StreamExt;
use reqwest::redirect::{Attempt, Policy};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::archive::{checked_stage_file, extract_verified_archive, verify_content_tree};
use super::domain::{
    AcpPluginInstallationState, AcpPluginLaunchPlan, AcpPluginMutationReceipt, AcpPluginStatus,
    AcpPluginTelemetry, InstalledPluginMarker, InstalledPluginVersion, PersistedPluginRecord,
    PersistedQuarantineState, PersistedRuntimeState, QuarantinedPluginVersion,
    RUNTIME_STATE_SCHEMA_VERSION,
};
use super::verification::{
    sha256_file, verify_artifact, verify_bundled_node, verify_compatibility, verify_manifest,
};

const MAX_MANIFEST_BYTES: u64 = 128 * 1024;
const MAX_CATALOG_REFS_BYTES: u64 = 256 * 1024;
// Request one more slot than the supported catalog so pagination can never
// make the app silently select an old release.
const MAX_CATALOG_REFS: usize = 99;
const MAX_CATALOG_RELEASE_FALLBACKS: usize = 8;
const MAX_STATE_BYTES: u64 = 1024 * 1024;
const MAX_FAILURE_BYTES: usize = 4 * 1024;
const MAX_QUARANTINE_RECORDS_PER_PLUGIN: usize = 16;
const CATALOG_REFS_URL: &str =
    "https://api.github.com/repos/json-choi/dopedb/git/matching-refs/tags/acp-bundle-v?per_page=100";
const CATALOG_RESOLUTION_TTL: Duration = Duration::from_secs(15 * 60);
const UPDATE_CHECK_INTERVAL: chrono::Duration = chrono::Duration::hours(24);

#[derive(Clone)]
pub(crate) struct AcpPluginManager {
    inner: Arc<Inner>,
}

struct Inner {
    root: PathBuf,
    client: reqwest::Client,
    mutation: tokio::sync::Mutex<()>,
    phases: Mutex<BTreeMap<AcpPluginId, AcpPluginInstallationState>>,
    catalog_release: Mutex<Option<CachedCatalogRelease>>,
}

#[derive(Clone)]
struct CachedCatalogRelease {
    tag: String,
    resolved_at: Instant,
}

#[derive(Deserialize)]
struct GitHubTagRef {
    #[serde(rename = "ref")]
    reference: String,
}

impl AcpPluginManager {
    pub(crate) fn new() -> AppResult<Self> {
        Self::with_root(crate::app_paths::data_root()?.join("acp-plugins"))
    }

    fn with_root(root: PathBuf) -> AppResult<Self> {
        prepare_directory(&root)?;
        for child in ["downloads", "staging", "quarantine"] {
            prepare_directory(&root.join(child))?;
        }
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(120))
            .redirect(Policy::custom(safe_redirect))
            .user_agent(format!(
                "DopeDB/{} ACP-plugin-manager",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|_| AppError::Config("the ACP plugin HTTP client is unavailable".into()))?;
        Ok(Self {
            inner: Arc::new(Inner {
                root,
                client,
                mutation: tokio::sync::Mutex::new(()),
                phases: Mutex::new(BTreeMap::new()),
                catalog_release: Mutex::new(None),
            }),
        })
    }

    pub(crate) fn statuses(&self) -> AppResult<Vec<AcpPluginStatus>> {
        let state = self.load_state()?;
        [AcpPluginId::Claude, AcpPluginId::Codex]
            .into_iter()
            .map(|plugin_id| self.project_status(plugin_id, &state))
            .collect()
    }

    pub(crate) fn has_ready_fallback(&self, plugin_id: AcpPluginId) -> AppResult<bool> {
        let state = self.load_state()?;
        Ok(state
            .plugins
            .get(&plugin_id)
            .is_some_and(record_has_ready_fallback))
    }

    pub(crate) async fn update_installed(&self, app: &AppHandle) {
        let state = match self.load_state() {
            Ok(state) => state,
            Err(error) => {
                tracing::warn!(%error, "could not load ACP plugin state for background update");
                return;
            }
        };
        let now = chrono::Utc::now();
        let due = state
            .plugins
            .iter()
            .filter_map(|(plugin_id, record)| {
                let installed = record.current.is_some()
                    || record.candidate.is_some()
                    || record.last_known_good.is_some();
                let checked_recently = record
                    .last_checked_at
                    .as_deref()
                    .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                    .is_some_and(|checked| {
                        now.signed_duration_since(checked.to_utc()) < UPDATE_CHECK_INTERVAL
                    });
                (record.enabled && installed && !checked_recently).then_some(*plugin_id)
            })
            .collect::<Vec<_>>();
        for plugin_id in due {
            if let Err(error) = self.install(app, plugin_id).await {
                tracing::warn!(
                    %error,
                    plugin_id = plugin_id.as_str(),
                    "ACP plugin background update was deferred"
                );
            }
        }
    }

    pub(crate) async fn install(
        &self,
        app: &AppHandle,
        plugin_id: AcpPluginId,
    ) -> AppResult<AcpPluginMutationReceipt> {
        emit_telemetry(app, plugin_id, "install_update", "started");
        let _guard = self.inner.mutation.lock().await;
        self.set_phase(plugin_id, AcpPluginInstallationState::Checking)?;
        let result = self.install_locked(app, plugin_id).await;
        self.clear_phase(plugin_id);
        match result {
            Ok(receipt) => {
                emit_telemetry(app, plugin_id, "install_update", "succeeded");
                Ok(receipt)
            }
            Err(error) => {
                let _ = self.record_failure(plugin_id, &error.to_string());
                emit_telemetry(app, plugin_id, "install_update", "failed");
                Err(error)
            }
        }
    }

    async fn install_locked(
        &self,
        app: &AppHandle,
        plugin_id: AcpPluginId,
    ) -> AppResult<AcpPluginMutationReceipt> {
        let runtime = verify_bundled_node(app)?;
        let (catalog_release, manifest_bytes) = self.download_manifest(plugin_id).await?;
        let envelope: SignedAcpPluginManifestV1 = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| AppError::Network("the ACP plugin manifest is invalid".into()))?;
        if envelope.manifest.plugin_id != plugin_id {
            return Err(AppError::Blocked {
                reason: "the ACP plugin manifest changed the requested plugin identity".into(),
            });
        }
        verify_manifest(&envelope)?;
        if envelope.manifest.artifact.url != artifact_url(&catalog_release, plugin_id) {
            return Err(AppError::Blocked {
                reason: "the ACP plugin manifest does not belong to its stable release".into(),
            });
        }
        verify_compatibility(&envelope.manifest, &runtime)?;

        let mut state = self.load_state()?;
        let before = state.plugins.get(&plugin_id).cloned().unwrap_or_default();
        if version_matches(&before.current, &envelope)
            || version_matches(&before.candidate, &envelope)
        {
            let record = state.plugins.entry(plugin_id).or_default();
            record.enabled = true;
            record.failure = None;
            record.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
            self.write_state(&state)?;
            return Ok(AcpPluginMutationReceipt {
                changed: false,
                status: self.project_status(plugin_id, &state)?,
            });
        }

        self.set_phase(plugin_id, AcpPluginInstallationState::Downloading)?;
        let download = self.download_artifact(&envelope).await?;
        self.set_phase(plugin_id, AcpPluginInstallationState::Verifying)?;
        if let Err(error) = verify_artifact(&download, &envelope.manifest) {
            let _ = fs::remove_file(&download);
            return Err(error);
        }

        let stage = self.inner.root.join("staging").join(format!(
            "{}-{}",
            plugin_id.provider_slug(),
            Uuid::new_v4()
        ));
        prepare_new_directory(&stage)?;
        let prepared = (|| -> AppResult<InstalledPluginVersion> {
            let entrypoint_sha256 =
                extract_verified_archive(&download, &stage, &envelope.manifest)?;
            let installed = InstalledPluginVersion {
                version: envelope.manifest.adapter_bundle_version.clone(),
                manifest_sha256: envelope.manifest_sha256.clone(),
                entrypoint_sha256: entrypoint_sha256.clone(),
            };
            write_new_json(
                &stage.join("installed.json"),
                &InstalledPluginMarker {
                    schema_version: RUNTIME_STATE_SCHEMA_VERSION,
                    envelope: envelope.clone(),
                    entrypoint_sha256,
                },
            )?;
            sync_directory(&stage);
            Ok(installed)
        })();
        let installed = match prepared {
            Ok(installed) => installed,
            Err(error) => {
                let _ = remove_owned_tree(&self.inner.root, &stage);
                let _ = fs::remove_file(&download);
                return Err(error);
            }
        };

        let target = self.version_directory(plugin_id, &installed.version);
        if fs::symlink_metadata(&target).is_ok() {
            let existing = self.read_installed_marker(&target)?;
            if existing.envelope.manifest_sha256 != installed.manifest_sha256
                || existing.entrypoint_sha256 != installed.entrypoint_sha256
            {
                let _ = remove_owned_tree(&self.inner.root, &stage);
                let _ = fs::remove_file(&download);
                return Err(AppError::Blocked {
                    reason: "an installed ACP plugin version conflicts with the signed artifact"
                        .into(),
                });
            }
            remove_owned_tree(&self.inner.root, &stage)?;
        } else {
            prepare_directory(target.parent().ok_or_else(|| {
                AppError::Config("the ACP plugin version has no provider directory".into())
            })?)?;
            fs::rename(&stage, &target)?;
            sync_directory(target.parent().expect("provider directory was checked"));
        }
        let _ = fs::remove_file(&download);

        let record = state.plugins.entry(plugin_id).or_default();
        record.enabled = true;
        record.candidate = Some(installed);
        record.failure = None;
        record.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
        self.write_state(&state)?;
        self.prune_unreferenced_versions(plugin_id, &state)?;
        self.set_phase(plugin_id, AcpPluginInstallationState::Staged)?;
        Ok(AcpPluginMutationReceipt {
            changed: true,
            status: self.project_status(plugin_id, &state)?,
        })
    }

    pub(crate) async fn remove(
        &self,
        app: &AppHandle,
        plugin_id: AcpPluginId,
    ) -> AppResult<AcpPluginMutationReceipt> {
        emit_telemetry(app, plugin_id, "remove", "started");
        let _guard = self.inner.mutation.lock().await;
        self.set_phase(plugin_id, AcpPluginInstallationState::Removing)?;
        let result = self.remove_locked(plugin_id);
        self.clear_phase(plugin_id);
        emit_telemetry(
            app,
            plugin_id,
            "remove",
            if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            },
        );
        result
    }

    fn remove_locked(&self, plugin_id: AcpPluginId) -> AppResult<AcpPluginMutationReceipt> {
        let mut state = self.load_state()?;
        let changed = state.plugins.remove(&plugin_id).is_some()
            || fs::symlink_metadata(self.provider_directory(plugin_id)).is_ok();
        let provider = self.provider_directory(plugin_id);
        if fs::symlink_metadata(&provider).is_ok() {
            remove_owned_tree(&self.inner.root, &provider)?;
        }
        self.remove_staging_for(plugin_id)?;
        self.remove_quarantine_for(plugin_id)?;
        let mut quarantine = self.load_quarantine()?;
        quarantine.plugins.remove(&plugin_id);
        self.write_quarantine(&quarantine)?;
        self.write_state(&state)?;
        Ok(AcpPluginMutationReceipt {
            changed,
            status: self.project_status(plugin_id, &state)?,
        })
    }

    pub(crate) fn set_enabled(
        &self,
        plugin_id: AcpPluginId,
        enabled: bool,
    ) -> AppResult<AcpPluginStatus> {
        let mut state = self.load_state()?;
        let record = state.plugins.entry(plugin_id).or_default();
        if enabled && record.current.is_none() && record.candidate.is_none() {
            return Err(AppError::Blocked {
                reason: "install the ACP adapter plugin before enabling it".into(),
            });
        }
        record.enabled = enabled;
        self.write_state(&state)?;
        self.project_status(plugin_id, &state)
    }

    pub(crate) fn launch_plan(
        &self,
        app: &AppHandle,
        plugin_id: AcpPluginId,
    ) -> AppResult<AcpPluginLaunchPlan> {
        let state = self.load_state()?;
        let record = state.plugins.get(&plugin_id).ok_or_else(|| {
            AppError::NotFound(format!("{} ACP plugin", plugin_id.provider_slug()))
        })?;
        if !record.enabled {
            return Err(AppError::Blocked {
                reason: "this ACP adapter plugin is disabled".into(),
            });
        }
        let (installed, candidate) = record
            .candidate
            .as_ref()
            .map(|version| (version, true))
            .or_else(|| record.current.as_ref().map(|version| (version, false)))
            .or_else(|| {
                record
                    .last_known_good
                    .as_ref()
                    .map(|version| (version, false))
            })
            .ok_or_else(|| AppError::NotFound("a ready ACP plugin version".into()))?;
        let directory = self.version_directory(plugin_id, &installed.version);
        let marker = self.read_installed_marker(&directory)?;
        verify_manifest(&marker.envelope)?;
        if marker.envelope.manifest.plugin_id != plugin_id
            || marker.envelope.manifest_sha256 != installed.manifest_sha256
            || marker.entrypoint_sha256 != installed.entrypoint_sha256
        {
            return Err(AppError::Blocked {
                reason: "the installed ACP plugin marker changed after activation".into(),
            });
        }
        let entrypoint =
            checked_stage_file(&directory, &marker.envelope.manifest.adapter_entrypoint)?;
        if sha256_file(&entrypoint)? != installed.entrypoint_sha256 {
            return Err(AppError::Blocked {
                reason: "the installed ACP plugin entrypoint changed after activation".into(),
            });
        }
        verify_content_tree(&directory, &marker.envelope.manifest.content_sha256)?;
        let runtime = verify_bundled_node(app)?;
        verify_compatibility(&marker.envelope.manifest, &runtime)?;
        Ok(AcpPluginLaunchPlan {
            adapter_bundle_version: installed.version.clone(),
            node_executable: runtime.executable,
            node_sha256: runtime.executable_sha256,
            adapter_entrypoint: entrypoint,
            adapter_entrypoint_sha256: installed.entrypoint_sha256.clone(),
            candidate,
        })
    }

    pub(crate) fn record_initialize_success(
        &self,
        app: &AppHandle,
        plugin_id: AcpPluginId,
        version: &str,
    ) -> AppResult<AcpPluginStatus> {
        let mut state = self.load_state()?;
        let record = state.plugins.get_mut(&plugin_id).ok_or_else(|| {
            AppError::NotFound(format!("{} ACP plugin", plugin_id.provider_slug()))
        })?;
        if let Some(candidate) = record.candidate.take() {
            if candidate.version != version {
                record.candidate = Some(candidate);
                return Err(AppError::Blocked {
                    reason: "the ACP plugin success receipt changed candidate version".into(),
                });
            }
            record.current = Some(candidate.clone());
            record.last_known_good = Some(candidate);
        } else if record
            .current
            .as_ref()
            .is_none_or(|current| current.version != version)
        {
            return Err(AppError::Blocked {
                reason: "the ACP plugin success receipt is not active".into(),
            });
        }
        record.failure = None;
        self.write_state(&state)?;
        self.prune_unreferenced_versions(plugin_id, &state)?;
        let status = self.project_status(plugin_id, &state)?;
        emit_telemetry(app, plugin_id, "candidate_initialize", "promoted");
        Ok(status)
    }

    pub(crate) fn record_initialize_failure(
        &self,
        app: &AppHandle,
        plugin_id: AcpPluginId,
        version: &str,
        reason: &str,
    ) -> AppResult<AcpPluginStatus> {
        let mut state = self.load_state()?;
        let candidate = {
            let record = state.plugins.get_mut(&plugin_id).ok_or_else(|| {
                AppError::NotFound(format!("{} ACP plugin", plugin_id.provider_slug()))
            })?;
            take_failed_candidate(record, version, reason)?
        };
        // Persist the candidate deactivation before touching its files. A process-exit
        // race on Windows may delay the quarantine rename, but must never make the
        // failed candidate launchable again or hide the last-known-good fallback.
        self.write_state(&state)?;
        let status = self.project_status(plugin_id, &state)?;
        let Some(candidate) = candidate else {
            emit_telemetry(app, plugin_id, "session_initialize", "failed");
            return Ok(status);
        };
        self.quarantine_version(plugin_id, &candidate, reason)?;
        emit_telemetry(app, plugin_id, "candidate_initialize", "quarantined");
        Ok(status)
    }

    fn quarantine_version(
        &self,
        plugin_id: AcpPluginId,
        version: &InstalledPluginVersion,
        reason: &str,
    ) -> AppResult<()> {
        let source = self.version_directory(plugin_id, &version.version);
        if fs::symlink_metadata(&source).is_ok() {
            let destination_root = self
                .inner
                .root
                .join("quarantine")
                .join(plugin_id.provider_slug());
            prepare_directory(&destination_root)?;
            let destination =
                destination_root.join(format!("{}-{}", version.version, Uuid::new_v4()));
            fs::rename(source, destination)?;
            sync_directory(&destination_root);
        }
        let mut quarantine = self.load_quarantine()?;
        let records = quarantine.plugins.entry(plugin_id).or_default();
        records.push(QuarantinedPluginVersion {
            version: version.version.clone(),
            manifest_sha256: version.manifest_sha256.clone(),
            reason: bounded_failure(reason),
        });
        if records.len() > MAX_QUARANTINE_RECORDS_PER_PLUGIN {
            let remove = records.len() - MAX_QUARANTINE_RECORDS_PER_PLUGIN;
            records.drain(..remove);
        }
        self.write_quarantine(&quarantine)
    }

    fn project_status(
        &self,
        plugin_id: AcpPluginId,
        state: &PersistedRuntimeState,
    ) -> AppResult<AcpPluginStatus> {
        let record = state.plugins.get(&plugin_id).cloned().unwrap_or_default();
        let phase = self
            .inner
            .phases
            .lock()
            .map_err(|_| AppError::Config("the ACP plugin phase registry is unavailable".into()))?
            .get(&plugin_id)
            .copied();
        let state = phase.unwrap_or_else(|| {
            if record.candidate.is_some() {
                AcpPluginInstallationState::Staged
            } else if record.current.is_some() || record.last_known_good.is_some() {
                AcpPluginInstallationState::Ready
            } else if record.failure.is_some() {
                AcpPluginInstallationState::Failed
            } else {
                AcpPluginInstallationState::NotInstalled
            }
        });
        Ok(AcpPluginStatus {
            plugin_id,
            state,
            enabled: record.enabled,
            installed_version: record
                .current
                .as_ref()
                .map(|version| version.version.clone()),
            candidate_version: record
                .candidate
                .as_ref()
                .map(|version| version.version.clone()),
            last_known_good_version: record
                .last_known_good
                .as_ref()
                .map(|version| version.version.clone()),
            failure: record.failure,
        })
    }

    fn record_failure(&self, plugin_id: AcpPluginId, failure: &str) -> AppResult<()> {
        let mut state = self.load_state()?;
        state.plugins.entry(plugin_id).or_default().failure = Some(bounded_failure(failure));
        self.write_state(&state)
    }

    fn set_phase(
        &self,
        plugin_id: AcpPluginId,
        phase: AcpPluginInstallationState,
    ) -> AppResult<()> {
        self.inner
            .phases
            .lock()
            .map_err(|_| AppError::Config("the ACP plugin phase registry is unavailable".into()))?
            .insert(plugin_id, phase);
        Ok(())
    }

    fn clear_phase(&self, plugin_id: AcpPluginId) {
        if let Ok(mut phases) = self.inner.phases.lock() {
            phases.remove(&plugin_id);
        }
    }

    async fn download_manifest(&self, plugin_id: AcpPluginId) -> AppResult<(String, Vec<u8>)> {
        if let Some(tag) = self.cached_catalog_release()? {
            if let Some(bytes) = self.try_download_manifest(&tag, plugin_id).await? {
                return Ok((tag, bytes));
            }
            self.clear_cached_catalog_release(&tag)?;
        }

        let refs = self
            .download_bounded(
                self.inner
                    .client
                    .get(CATALOG_REFS_URL)
                    .header(reqwest::header::ACCEPT, "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28"),
                MAX_CATALOG_REFS_BYTES,
                "catalog index",
                false,
            )
            .await?
            .ok_or_else(|| AppError::Network("the ACP plugin catalog index is missing".into()))?;
        let refs: Vec<GitHubTagRef> = serde_json::from_slice(&refs)
            .map_err(|_| AppError::Network("the ACP plugin catalog index is invalid".into()))?;
        if refs.len() > MAX_CATALOG_REFS {
            return Err(AppError::Network(
                "the ACP plugin catalog index has too many releases".into(),
            ));
        }

        for tag in stable_catalog_tags(refs)
            .into_iter()
            .take(MAX_CATALOG_RELEASE_FALLBACKS)
        {
            if let Some(bytes) = self.try_download_manifest(&tag, plugin_id).await? {
                self.cache_catalog_release(tag.clone())?;
                return Ok((tag, bytes));
            }
        }
        Err(AppError::Network(
            "no published stable ACP plugin release contains this adapter".into(),
        ))
    }

    async fn try_download_manifest(
        &self,
        release_tag: &str,
        plugin_id: AcpPluginId,
    ) -> AppResult<Option<Vec<u8>>> {
        self.download_bounded(
            self.inner.client.get(manifest_url(release_tag, plugin_id)),
            MAX_MANIFEST_BYTES,
            "manifest",
            true,
        )
        .await
    }

    fn cached_catalog_release(&self) -> AppResult<Option<String>> {
        let cached =
            self.inner.catalog_release.lock().map_err(|_| {
                AppError::Config("the ACP plugin catalog cache is unavailable".into())
            })?;
        Ok(cached
            .as_ref()
            .filter(|entry| entry.resolved_at.elapsed() < CATALOG_RESOLUTION_TTL)
            .map(|entry| entry.tag.clone()))
    }

    fn cache_catalog_release(&self, tag: String) -> AppResult<()> {
        *self.inner.catalog_release.lock().map_err(|_| {
            AppError::Config("the ACP plugin catalog cache is unavailable".into())
        })? = Some(CachedCatalogRelease {
            tag,
            resolved_at: Instant::now(),
        });
        Ok(())
    }

    fn clear_cached_catalog_release(&self, tag: &str) -> AppResult<()> {
        let mut cached =
            self.inner.catalog_release.lock().map_err(|_| {
                AppError::Config("the ACP plugin catalog cache is unavailable".into())
            })?;
        if cached.as_ref().is_some_and(|entry| entry.tag == tag) {
            *cached = None;
        }
        Ok(())
    }

    async fn download_bounded(
        &self,
        request: reqwest::RequestBuilder,
        maximum: u64,
        resource: &str,
        allow_not_found: bool,
    ) -> AppResult<Option<Vec<u8>>> {
        let response = request
            .send()
            .await
            .map_err(|_| AppError::Network(format!("the ACP plugin {resource} request failed")))?;
        if allow_not_found && response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(AppError::Network(format!(
                "the ACP plugin {resource} request returned HTTP {}",
                response.status().as_u16()
            )));
        }
        if response
            .content_length()
            .is_some_and(|length| length > maximum)
        {
            return Err(AppError::Network(format!(
                "the ACP plugin {resource} is too large"
            )));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| {
                AppError::Network(format!("the ACP plugin {resource} stream failed"))
            })?;
            if bytes.len().saturating_add(chunk.len()) > maximum as usize {
                return Err(AppError::Network(format!(
                    "the ACP plugin {resource} is too large"
                )));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(AppError::Network(format!(
                "the ACP plugin {resource} is empty"
            )));
        }
        Ok(Some(bytes))
    }

    async fn download_artifact(&self, envelope: &SignedAcpPluginManifestV1) -> AppResult<PathBuf> {
        let path = self.inner.root.join("downloads").join(format!(
            "{}-{}.partial",
            envelope.manifest.plugin_id.provider_slug(),
            Uuid::new_v4()
        ));
        let response = self
            .inner
            .client
            .get(&envelope.manifest.artifact.url)
            .send()
            .await
            .map_err(|_| AppError::Network("the ACP plugin artifact request failed".into()))?;
        if !response.status().is_success() {
            return Err(AppError::Network(format!(
                "the ACP plugin artifact request returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let expected = envelope.manifest.artifact.packed_bytes;
        if response
            .content_length()
            .is_some_and(|length| length != expected)
        {
            return Err(AppError::Network(
                "the ACP plugin artifact length does not match its manifest".into(),
            ));
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.create_new(true).write(true);
        let mut output = options.open(&path).await?;
        let result = async {
            let mut written = 0u64;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    AppError::Network("the ACP plugin artifact stream failed".into())
                })?;
                written = written.checked_add(chunk.len() as u64).ok_or_else(|| {
                    AppError::Network("the ACP plugin artifact length overflowed".into())
                })?;
                if written > expected {
                    return Err(AppError::Network(
                        "the ACP plugin artifact exceeded its signed size".into(),
                    ));
                }
                output.write_all(&chunk).await?;
            }
            output.flush().await?;
            output.sync_all().await?;
            if written != expected {
                return Err(AppError::Network(
                    "the ACP plugin artifact ended before its signed size".into(),
                ));
            }
            Ok(())
        }
        .await;
        drop(output);
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(error);
        }
        Ok(path)
    }

    fn load_state(&self) -> AppResult<PersistedRuntimeState> {
        load_json_or_default(&self.inner.root.join("active.json"))
    }

    fn write_state(&self, state: &PersistedRuntimeState) -> AppResult<()> {
        validate_state(state)?;
        write_json_atomic(&self.inner.root.join("active.json"), state)
    }

    fn load_quarantine(&self) -> AppResult<PersistedQuarantineState> {
        load_json_or_default(&self.inner.root.join("quarantine.json"))
    }

    fn write_quarantine(&self, state: &PersistedQuarantineState) -> AppResult<()> {
        if state.schema_version != RUNTIME_STATE_SCHEMA_VERSION
            || state
                .plugins
                .values()
                .any(|records| records.len() > MAX_QUARANTINE_RECORDS_PER_PLUGIN)
        {
            return Err(AppError::Config(
                "the ACP plugin quarantine state is invalid".into(),
            ));
        }
        write_json_atomic(&self.inner.root.join("quarantine.json"), state)
    }

    fn provider_directory(&self, plugin_id: AcpPluginId) -> PathBuf {
        self.inner.root.join(plugin_id.provider_slug())
    }

    fn version_directory(&self, plugin_id: AcpPluginId, version: &str) -> PathBuf {
        self.provider_directory(plugin_id).join(version)
    }

    fn read_installed_marker(&self, directory: &Path) -> AppResult<InstalledPluginMarker> {
        let marker: InstalledPluginMarker = read_json(&directory.join("installed.json"))?;
        if marker.schema_version != RUNTIME_STATE_SCHEMA_VERSION
            || !marker.envelope.validate_shape()
            || !valid_digest(&marker.entrypoint_sha256)
        {
            return Err(AppError::Blocked {
                reason: "the installed ACP plugin marker is invalid".into(),
            });
        }
        Ok(marker)
    }

    fn prune_unreferenced_versions(
        &self,
        plugin_id: AcpPluginId,
        state: &PersistedRuntimeState,
    ) -> AppResult<()> {
        let Some(record) = state.plugins.get(&plugin_id) else {
            return Ok(());
        };
        let keep = [
            record.current.as_ref(),
            record.candidate.as_ref(),
            record.last_known_good.as_ref(),
        ]
        .into_iter()
        .flatten()
        .map(|version| version.version.as_str())
        .collect::<BTreeSet<_>>();
        let provider = self.provider_directory(plugin_id);
        let entries = match fs::read_dir(&provider) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| AppError::Blocked {
                reason: "an ACP plugin version directory is not Unicode".into(),
            })?;
            if !keep.contains(name) {
                remove_owned_tree(&self.inner.root, &entry.path())?;
            }
        }
        Ok(())
    }

    fn remove_staging_for(&self, plugin_id: AcpPluginId) -> AppResult<()> {
        remove_prefixed_children(
            &self.inner.root,
            &self.inner.root.join("staging"),
            &format!("{}-", plugin_id.provider_slug()),
        )
    }

    fn remove_quarantine_for(&self, plugin_id: AcpPluginId) -> AppResult<()> {
        let path = self
            .inner
            .root
            .join("quarantine")
            .join(plugin_id.provider_slug());
        if fs::symlink_metadata(&path).is_ok() {
            remove_owned_tree(&self.inner.root, &path)?;
        }
        Ok(())
    }
}

fn manifest_url(release_tag: &str, plugin_id: AcpPluginId) -> String {
    format!(
        "https://github.com/json-choi/dopedb/releases/download/{release_tag}/{}.manifest.json",
        plugin_id.provider_slug()
    )
}

fn artifact_url(release_tag: &str, plugin_id: AcpPluginId) -> String {
    format!(
        "https://github.com/json-choi/dopedb/releases/download/{release_tag}/{}.tar.gz",
        plugin_id.provider_slug()
    )
}

fn stable_catalog_tags(refs: Vec<GitHubTagRef>) -> Vec<String> {
    let mut releases = refs
        .into_iter()
        .filter_map(|reference| {
            catalog_release_version(&reference.reference).map(|version| {
                (
                    version,
                    reference.reference["refs/tags/".len()..].to_owned(),
                )
            })
        })
        .collect::<Vec<_>>();
    releases.sort_by_key(|release| std::cmp::Reverse(release.0));
    releases.dedup_by(|left, right| left.1 == right.1);
    releases.into_iter().map(|(_, tag)| tag).collect()
}

fn catalog_release_version(reference: &str) -> Option<(u32, u32, u32, u32)> {
    let value = reference.strip_prefix("refs/tags/acp-bundle-v")?;
    let segments = value.split('.').collect::<Vec<_>>();
    if segments.len() != 4
        || segments[0].len() != 4
        || segments[1].len() != 2
        || segments[2].len() != 2
        || segments
            .iter()
            .any(|segment| segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()))
        || (segments[3].len() > 1 && segments[3].starts_with('0'))
    {
        return None;
    }
    let year = segments[0].parse().ok()?;
    let month = segments[1].parse().ok()?;
    let day = segments[2].parse().ok()?;
    let sequence = segments[3].parse().ok()?;
    if sequence == 0 || chrono::NaiveDate::from_ymd_opt(year as i32, month, day).is_none() {
        return None;
    }
    Some((year, month, day, sequence))
}

fn safe_redirect(attempt: Attempt<'_>) -> reqwest::redirect::Action {
    if attempt.previous().len() >= 5 {
        return attempt.stop();
    }
    match attempt.url().host_str() {
        Some(
            "api.github.com"
            | "github.com"
            | "objects.githubusercontent.com"
            | "release-assets.githubusercontent.com",
        ) => attempt.follow(),
        _ => attempt.stop(),
    }
}

#[cfg(test)]
pub(super) fn assert_catalog_release_contract() {
    let tags = stable_catalog_tags(vec![
        GitHubTagRef {
            reference: "refs/tags/acp-bundle-v2026.08.09.9".into(),
        },
        GitHubTagRef {
            reference: "refs/tags/acp-bundle-v2026.08.09.10".into(),
        },
        GitHubTagRef {
            reference: "refs/tags/acp-bundle-v2026.08.10.1-candidate".into(),
        },
        GitHubTagRef {
            reference: "refs/tags/acp-bundle-v2026.02.30.1".into(),
        },
        GitHubTagRef {
            reference: "refs/tags/app-v0.3.34".into(),
        },
    ]);
    assert_eq!(
        tags,
        vec![
            "acp-bundle-v2026.08.09.10".to_owned(),
            "acp-bundle-v2026.08.09.9".to_owned(),
        ]
    );
    assert_eq!(
        artifact_url(&tags[0], AcpPluginId::Claude),
        "https://github.com/json-choi/dopedb/releases/download/acp-bundle-v2026.08.09.10/claude.tar.gz"
    );
}

fn emit_telemetry(
    app: &AppHandle,
    plugin_id: AcpPluginId,
    operation: &'static str,
    outcome: &'static str,
) {
    let _ = app.emit(
        "agent-plugin:telemetry",
        AcpPluginTelemetry {
            provider: plugin_id.provider_slug(),
            operation,
            outcome,
        },
    );
}

fn version_matches(
    installed: &Option<InstalledPluginVersion>,
    envelope: &SignedAcpPluginManifestV1,
) -> bool {
    installed.as_ref().is_some_and(|installed| {
        installed.version == envelope.manifest.adapter_bundle_version
            && installed.manifest_sha256 == envelope.manifest_sha256
    })
}

fn record_has_ready_fallback(record: &PersistedPluginRecord) -> bool {
    record.candidate.is_none()
        && record.failure.is_some()
        && (record.current.is_some() || record.last_known_good.is_some())
}

fn take_failed_candidate(
    record: &mut PersistedPluginRecord,
    version: &str,
    reason: &str,
) -> AppResult<Option<InstalledPluginVersion>> {
    let Some(candidate) = record.candidate.take() else {
        record.failure = Some(bounded_failure(reason));
        return Ok(None);
    };
    if candidate.version != version {
        record.candidate = Some(candidate);
        return Err(AppError::Blocked {
            reason: "the ACP plugin failure receipt changed candidate version".into(),
        });
    }
    record.failure = Some(bounded_failure(reason));
    Ok(Some(candidate))
}

#[cfg(test)]
pub(super) fn assert_candidate_fallback_contract() {
    let stable = InstalledPluginVersion {
        version: "1.0.0".into(),
        manifest_sha256: "a".repeat(64),
        entrypoint_sha256: "b".repeat(64),
    };
    let candidate = InstalledPluginVersion {
        version: "1.1.0".into(),
        manifest_sha256: "c".repeat(64),
        entrypoint_sha256: "d".repeat(64),
    };
    let mut record = PersistedPluginRecord {
        enabled: true,
        current: Some(stable.clone()),
        candidate: Some(candidate.clone()),
        last_known_good: Some(stable),
        failure: None,
        last_checked_at: None,
    };

    let failed = take_failed_candidate(&mut record, &candidate.version, "startup timed out")
        .expect("the active candidate can be failed")
        .expect("the failed version remains available for quarantine");

    assert_eq!(failed, candidate);
    assert!(record.candidate.is_none());
    assert_eq!(
        record.current.as_ref().map(|value| value.version.as_str()),
        Some("1.0.0")
    );
    assert_eq!(
        record
            .last_known_good
            .as_ref()
            .map(|value| value.version.as_str()),
        Some("1.0.0")
    );
    assert_eq!(record.failure.as_deref(), Some("startup timed out"));
    assert!(record_has_ready_fallback(&record));
}

fn validate_state(state: &PersistedRuntimeState) -> AppResult<()> {
    if state.schema_version != RUNTIME_STATE_SCHEMA_VERSION || state.plugins.len() > 2 {
        return Err(AppError::Config(
            "the ACP plugin activation state is invalid".into(),
        ));
    }
    for record in state.plugins.values() {
        if record.failure.as_ref().is_some_and(|failure| {
            failure.is_empty() || failure.len() > MAX_FAILURE_BYTES || failure.contains('\0')
        }) {
            return Err(AppError::Config(
                "the ACP plugin failure state is invalid".into(),
            ));
        }
        if record
            .last_checked_at
            .as_deref()
            .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
        {
            return Err(AppError::Config(
                "the ACP plugin check timestamp is invalid".into(),
            ));
        }
        for version in [
            record.current.as_ref(),
            record.candidate.as_ref(),
            record.last_known_good.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if semver::Version::parse(&version.version).is_err()
                || !valid_digest(&version.manifest_sha256)
                || !valid_digest(&version.entrypoint_sha256)
            {
                return Err(AppError::Config(
                    "an ACP plugin version state is invalid".into(),
                ));
            }
        }
    }
    Ok(())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_failure(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|character| *character != '\0')
        .collect::<String>();
    if sanitized.len() <= MAX_FAILURE_BYTES {
        return sanitized;
    }
    let mut end = MAX_FAILURE_BYTES;
    while !sanitized.is_char_boundary(end) {
        end -= 1;
    }
    sanitized[..end].to_owned()
}

fn load_json_or_default<T>(path: &Path) -> AppResult<T>
where
    T: DeserializeOwned + Default,
{
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => read_json(path),
        Ok(_) => Err(AppError::Blocked {
            reason: "an ACP plugin state path is not a regular file".into(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.into()),
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> AppResult<T> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > MAX_STATE_BYTES {
        return Err(AppError::Blocked {
            reason: "an ACP plugin state file is invalid".into(),
        });
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    if bytes.is_empty() || bytes.len() > MAX_STATE_BYTES as usize {
        return Err(AppError::Config("the ACP plugin state is too large".into()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Config("the ACP plugin state has no parent".into()))?;
    prepare_directory(parent)?;
    if fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        return Err(AppError::Blocked {
            reason: "refusing to replace a non-file ACP plugin state path".into(),
        });
    }
    let temporary = parent.join(format!(".state-{}.tmp", Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&bytes)?;
        file.sync_all()?;
        atomic_replace(&temporary, path)?;
        sync_directory(parent);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_new_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

fn prepare_new_directory(path: &Path) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Config("the ACP plugin staging path has no parent".into()))?;
    prepare_directory(parent)?;
    fs::create_dir(path)?;
    restrict_directory(path)
}

fn prepare_directory(path: &Path) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => restrict_directory(path),
        Ok(_) => Err(AppError::Blocked {
            reason: format!("refusing unsafe ACP plugin directory {}", path.display()),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| AppError::Config("the ACP plugin directory has no parent".into()))?;
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
            fs::create_dir(path)?;
            restrict_directory(path)
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(windows)]
fn restrict_directory(path: &Path) -> AppResult<()> {
    crate::broker::restrict_path_to_current_user(path)
}

fn remove_prefixed_children(root: &Path, parent: &Path, prefix: &str) -> AppResult<()> {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with(prefix) {
            remove_owned_tree(root, &entry.path())?;
        }
    }
    Ok(())
}

fn remove_owned_tree(root: &Path, path: &Path) -> AppResult<()> {
    if path == root || !path.starts_with(root) {
        return Err(AppError::Blocked {
            reason: "refusing to remove an ACP plugin path outside its root".into(),
        });
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(AppError::Blocked {
            reason: "refusing to follow a link in ACP plugin storage".into(),
        });
    }
    if metadata.file_type().is_file() {
        fs::remove_file(path)?;
        return Ok(());
    }
    if !metadata.file_type().is_dir() {
        return Err(AppError::Blocked {
            reason: "refusing an unknown ACP plugin filesystem object".into(),
        });
    }
    for entry in fs::read_dir(path)? {
        remove_owned_tree(root, &entry?.path())?;
    }
    fs::remove_dir(path)?;
    Ok(())
}

fn sync_directory(path: &Path) {
    if let Ok(directory) = OpenOptions::new().read(true).open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(unix)]
fn atomic_replace(from: &Path, to: &Path) -> AppResult<()> {
    fs::rename(from, to)?;
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }
    let from = wide_null(from.as_os_str());
    let to = wide_null(to.as_os_str());
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
