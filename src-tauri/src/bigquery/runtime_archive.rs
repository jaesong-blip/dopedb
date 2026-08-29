//! Bounded BigQuery SDK archive extraction and layout validation.

use super::*;

#[cfg(target_os = "macos")]
pub(super) fn extract_sdk(archive_path: &Path, stage: &Path) -> AppResult<()> {
    let archive = File::open(archive_path)?;
    let decoder = GzDecoder::new(archive);
    let mut archive = tar::Archive::new(decoder);
    let mut state = ExtractionState::default();
    for entry in archive
        .entries()
        .map_err(|_| archive_error("the Google Cloud CLI archive index is invalid"))?
    {
        let mut entry =
            entry.map_err(|_| archive_error("a Google Cloud CLI archive entry is invalid"))?;
        let relative = entry
            .path()
            .map_err(|_| archive_error("a Google Cloud CLI archive path is invalid"))?
            .into_owned();
        state.observe(&relative, entry.size())?;
        let destination = stage.join(&relative);
        let kind = entry.header().entry_type();
        if kind.is_symlink() && skippable_sdk_symlink(&relative) {
            continue;
        }
        if kind.is_dir() {
            create_owned_directories(stage, &destination)?;
            continue;
        }
        if !kind.is_file() {
            return Err(archive_error(
                "the Google Cloud CLI archive contains an unsupported link or device entry",
            ));
        }
        copy_archive_file(stage, &destination, entry.size(), &mut entry)?;
    }
    validate_sdk_layout(stage)
}

#[cfg(windows)]
pub(super) fn extract_sdk(archive_path: &Path, stage: &Path) -> AppResult<()> {
    let archive = File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(archive)
        .map_err(|_| archive_error("the Google Cloud CLI zip index is invalid"))?;
    let mut state = ExtractionState::default();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| archive_error("a Google Cloud CLI zip entry is invalid"))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| archive_error("a Google Cloud CLI zip path is unsafe"))?
            .to_path_buf();
        state.observe(&relative, entry.size())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
        {
            return Err(archive_error(
                "the Google Cloud CLI zip contains a symbolic link",
            ));
        }
        let destination = stage.join(&relative);
        if entry.is_dir() {
            create_owned_directories(stage, &destination)?;
            continue;
        }
        copy_archive_file(stage, &destination, entry.size(), &mut entry)?;
    }
    validate_sdk_layout(stage)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(super) fn extract_sdk(_archive_path: &Path, _stage: &Path) -> AppResult<()> {
    Err(AppError::Config(
        "automatic Google Cloud CLI preparation is not supported on this platform".into(),
    ))
}

#[derive(Default)]
struct ExtractionState {
    entries: usize,
    unpacked_bytes: u64,
    paths: BTreeSet<String>,
}

impl ExtractionState {
    fn observe(&mut self, relative: &Path, bytes: u64) -> AppResult<()> {
        validate_relative_path(relative)?;
        self.entries = self.entries.saturating_add(1);
        if self.entries > MAX_ARCHIVE_ENTRIES {
            return Err(archive_error(
                "the Google Cloud CLI archive contains too many entries",
            ));
        }
        if bytes > MAX_ARCHIVE_FILE_BYTES {
            return Err(archive_error(
                "a Google Cloud CLI archive file exceeds its safety limit",
            ));
        }
        self.unpacked_bytes = self
            .unpacked_bytes
            .checked_add(bytes)
            .ok_or_else(|| archive_error("the Google Cloud CLI archive size overflowed"))?;
        if self.unpacked_bytes > MAX_UNPACKED_BYTES {
            return Err(archive_error(
                "the Google Cloud CLI archive exceeds its unpacked safety limit",
            ));
        }
        let collision = relative
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        if !self.paths.insert(collision) {
            return Err(archive_error(
                "the Google Cloud CLI archive contains duplicate paths",
            ));
        }
        Ok(())
    }
}

pub(super) fn copy_archive_file<R: Read>(
    stage: &Path,
    destination: &Path,
    size: u64,
    source: &mut R,
) -> AppResult<()> {
    if !destination.starts_with(stage) {
        return Err(archive_error(
            "a Google Cloud CLI archive path escaped staging",
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| archive_error("a Google Cloud CLI archive file has no parent"))?;
    create_owned_directories(stage, parent)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let copied = io::copy(&mut source.take(size.saturating_add(1)), &mut output)?;
    if copied != size {
        return Err(archive_error(
            "a Google Cloud CLI archive file did not match its declared size",
        ));
    }
    output.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = destination
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                matches!(
                    name,
                    "gcloud" | "bq" | "gsutil" | "docker-credential-gcloud"
                )
            });
        fs::set_permissions(
            destination,
            fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
        )?;
    }
    Ok(())
}

pub(super) fn validate_relative_path(relative: &Path) -> AppResult<()> {
    let text = relative.to_string_lossy();
    let depth = relative.components().count();
    #[cfg(windows)]
    let contains_foreign_separator = false;
    #[cfg(not(windows))]
    let contains_foreign_separator = text.contains('\\');
    if text.is_empty()
        || text.len() > MAX_ARCHIVE_PATH_BYTES
        || depth == 0
        || depth > MAX_ARCHIVE_DEPTH
        || contains_foreign_separator
        || text.contains(':')
        || text.chars().any(unsafe_path_character)
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || relative
            .components()
            .next()
            .and_then(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            })
            != Some("google-cloud-sdk")
        || relative.file_name().and_then(|name| name.to_str()) == Some("installed.json")
    {
        return Err(archive_error(
            "the Google Cloud CLI archive contains an unsafe path",
        ));
    }
    Ok(())
}

pub(super) fn unsafe_path_character(value: char) -> bool {
    value.is_control()
        || matches!(
            value,
            '\u{061c}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
                | '\u{feff}'
        )
}

#[cfg(target_os = "macos")]
pub(super) fn skippable_sdk_symlink(relative: &Path) -> bool {
    let path = relative.to_string_lossy();
    path.starts_with("google-cloud-sdk/platform/gsutil/third_party/")
        && (path.contains("/docs/") || path.contains("/tests/certs/"))
}

pub(super) fn validate_sdk_layout(stage: &Path) -> AppResult<()> {
    let sdk = stage.join("google-cloud-sdk");
    let gcloud = sdk.join("bin").join(if cfg!(windows) {
        "gcloud.cmd"
    } else {
        "gcloud"
    });
    let bq = sdk
        .join("bin")
        .join(if cfg!(windows) { "bq.cmd" } else { "bq" });
    checked_regular_file(&gcloud, MAX_ARCHIVE_FILE_BYTES)?;
    checked_regular_file(&bq, MAX_ARCHIVE_FILE_BYTES)?;
    Ok(())
}
