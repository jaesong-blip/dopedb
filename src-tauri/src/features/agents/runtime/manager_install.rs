//! ACP plugin catalog resolution, download, and installed-version management.

use super::*;

impl AcpPluginManager {
    pub(super) async fn download_manifest(
        &self,
        plugin_id: AcpPluginId,
    ) -> AppResult<(String, Vec<u8>)> {
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

    pub(super) async fn try_download_manifest(
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

    pub(super) fn cached_catalog_release(&self) -> AppResult<Option<String>> {
        let cached =
            self.inner.catalog_release.lock().map_err(|_| {
                AppError::Config("the ACP plugin catalog cache is unavailable".into())
            })?;
        Ok(cached
            .as_ref()
            .filter(|entry| entry.resolved_at.elapsed() < CATALOG_RESOLUTION_TTL)
            .map(|entry| entry.tag.clone()))
    }

    pub(super) fn cache_catalog_release(&self, tag: String) -> AppResult<()> {
        *self.inner.catalog_release.lock().map_err(|_| {
            AppError::Config("the ACP plugin catalog cache is unavailable".into())
        })? = Some(CachedCatalogRelease {
            tag,
            resolved_at: Instant::now(),
        });
        Ok(())
    }

    pub(super) fn clear_cached_catalog_release(&self, tag: &str) -> AppResult<()> {
        let mut cached =
            self.inner.catalog_release.lock().map_err(|_| {
                AppError::Config("the ACP plugin catalog cache is unavailable".into())
            })?;
        if cached.as_ref().is_some_and(|entry| entry.tag == tag) {
            *cached = None;
        }
        Ok(())
    }

    pub(super) async fn download_bounded(
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

    pub(super) async fn download_artifact(
        &self,
        envelope: &SignedAcpPluginManifestV1,
    ) -> AppResult<PathBuf> {
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

    pub(super) fn load_state(&self) -> AppResult<PersistedRuntimeState> {
        load_json_or_default(&self.inner.root.join("active.json"))
    }

    pub(super) fn write_state(&self, state: &PersistedRuntimeState) -> AppResult<()> {
        validate_state(state)?;
        write_json_atomic(&self.inner.root.join("active.json"), state)
    }

    pub(super) fn load_quarantine(&self) -> AppResult<PersistedQuarantineState> {
        load_json_or_default(&self.inner.root.join("quarantine.json"))
    }

    pub(super) fn write_quarantine(&self, state: &PersistedQuarantineState) -> AppResult<()> {
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

    pub(super) fn provider_directory(&self, plugin_id: AcpPluginId) -> PathBuf {
        self.inner.root.join(plugin_id.provider_slug())
    }

    pub(super) fn version_directory(&self, plugin_id: AcpPluginId, version: &str) -> PathBuf {
        self.provider_directory(plugin_id).join(version)
    }

    pub(super) fn read_installed_marker(
        &self,
        directory: &Path,
    ) -> AppResult<InstalledPluginMarker> {
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

    pub(super) fn prune_unreferenced_versions(
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

    pub(super) fn remove_staging_for(&self, plugin_id: AcpPluginId) -> AppResult<()> {
        remove_prefixed_children(
            &self.inner.root,
            &self.inner.root.join("staging"),
            &format!("{}-", plugin_id.provider_slug()),
        )
    }

    pub(super) fn remove_quarantine_for(&self, plugin_id: AcpPluginId) -> AppResult<()> {
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
