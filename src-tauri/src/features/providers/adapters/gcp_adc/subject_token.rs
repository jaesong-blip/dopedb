//! No-follow, bounded ADC and WIF subject-token file handling.

use std::fs::{File, OpenOptions};
use std::io::{Read, Take, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use zeroize::Zeroizing;

use crate::error::AppResult;

use super::{blocked, MAX_ADC_BYTES};

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod cleanup;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use cleanup::CapabilityRoot;

/// Snapshot of a WIF subject-token file. The fixed gcloud command is allowed
/// to run only after the no-follow file has been read, and its exact bytes and
/// file identity are checked again before the bearer can prove target access.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SubjectTokenGuard {
    path: PathBuf,
    digest: [u8; 32],
    length: u64,
    identity: SubjectTokenFileIdentity,
}

/// Private, process-owned files handed to gcloud. The caller-controlled ADC
/// and subject-token paths are never present in the child environment.
pub(crate) struct GcloudSnapshot {
    directory: Option<TempDir>,
    adc_path: PathBuf,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    capability_root: CapabilityRoot,
}

#[derive(Clone, PartialEq, Eq)]
struct SubjectTokenFileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

/// Opens the final path component without following it, then validates the
/// *opened handle* before and after the bounded read.
pub(crate) fn read_adc_document(path: &Path) -> AppResult<Value> {
    let file = open_no_follow(path)?;
    let before = file
        .metadata()
        .map_err(|_| blocked("GCP ADC credential is unavailable"))?;
    if !before.is_file() || before.len() > MAX_ADC_BYTES {
        return Err(blocked("GCP ADC credential is invalid"));
    }
    let bytes = read_bounded(file, MAX_ADC_BYTES)?;
    let path_changed = match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() != before.len()
        }
        Err(_) => true,
    };
    if bytes.len() as u64 != before.len() || path_changed {
        return Err(blocked("GCP ADC credential is invalid"));
    }
    serde_json::from_slice(&bytes).map_err(|_| blocked("GCP ADC credential is invalid"))
}

pub(crate) fn external_subject_token_guard(value: &Value) -> AppResult<Option<SubjectTokenGuard>> {
    let object = value
        .as_object()
        .ok_or_else(|| blocked("GCP ADC credential is invalid"))?;
    if object.get("type").and_then(Value::as_str) != Some("external_account") {
        return Ok(None);
    }
    let source = object
        .get("credential_source")
        .and_then(Value::as_object)
        .ok_or_else(|| blocked("GCP WIF credential is invalid"))?;
    let path = source
        .get("file")
        .and_then(Value::as_str)
        .filter(|path| Path::new(path).is_absolute())
        .map(PathBuf::from)
        .ok_or_else(|| blocked("GCP WIF credential is invalid"))?;
    let (bytes, length, identity) = read_safe_subject_token(&path)?;
    let digest = Sha256::digest(&bytes).into();
    drop(bytes);
    Ok(Some(SubjectTokenGuard {
        path,
        digest,
        length,
        identity,
    }))
}

impl SubjectTokenGuard {
    fn snapshot_bytes(&self) -> AppResult<Zeroizing<Vec<u8>>> {
        let (bytes, length, identity) = read_safe_subject_token(&self.path)?;
        let matches = length == self.length
            && Sha256::digest(&bytes).as_slice() == self.digest
            && identity == self.identity;
        if matches {
            Ok(bytes)
        } else {
            drop(bytes);
            Err(blocked("GCP WIF credential changed during snapshot"))
        }
    }
}

impl GcloudSnapshot {
    pub(crate) fn materialize(
        adc_path: &Path,
        expected_document: &Value,
        subject: Option<&SubjectTokenGuard>,
    ) -> AppResult<Self> {
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (adc_path, expected_document, subject);
            Err(blocked("GCP ADC snapshot is unavailable"))
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let mut document = read_adc_document(adc_path)?;
            if &document != expected_document {
                return Err(blocked("GCP ADC credential changed during snapshot"));
            }
            let directory = tempfile::Builder::new()
                .prefix("dopedb-gcp-")
                .tempdir()
                .map_err(|_| blocked("GCP ADC snapshot is unavailable"))?;
            establish_private_directory(directory.path())?;
            let capability_root = CapabilityRoot::open(directory.path())?;
            let snapshot_adc = match materialize_files(directory.path(), &mut document, subject) {
                Ok(path) => path,
                Err(error) => {
                    // A partial ADC/subject write may already contain secret
                    // material. Apply the identical bounded descriptor-first
                    // disposal path used after gcloud, including its guarded
                    // standard-library fallback, before returning the write
                    // failure to the caller.
                    let _ = dispose_snapshot_root(&capability_root, directory);
                    return Err(error);
                }
            };
            Ok(Self {
                directory: Some(directory),
                adc_path: snapshot_adc,
                capability_root,
            })
        }
    }

    pub(crate) fn adc_path(&self) -> &Path {
        &self.adc_path
    }

    pub(crate) fn config_directory(&self) -> &Path {
        self.directory
            .as_ref()
            .map(TempDir::path)
            .unwrap_or_else(|| unreachable!("snapshot path is unavailable after cleanup"))
    }

    /// Adds the ephemeral bearer consumed only by a subsequent official gcloud
    /// command. It shares the descriptor-rooted snapshot cleanup and never
    /// enters persistent application configuration.
    pub(crate) fn materialize_access_token(&self, token: &[u8]) -> AppResult<PathBuf> {
        if token.is_empty()
            || token.len() > 64 * 1024
            || token.iter().any(|byte| !byte.is_ascii_graphic())
        {
            return Err(blocked("GCP ADC credential was rejected"));
        }
        let path = self.config_directory().join("access-token");
        write_private(&path, token)?;
        Ok(path)
    }

    /// Removes every process-owned gcloud artifact after the child has exited.
    /// Two descriptor-rooted attempts run first. Only while the pathname is
    /// still proven to be this opened private root may the Rust standard
    /// library's symlink-safe recursive removal act as a last resort.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(crate) fn cleanup(&mut self) -> AppResult<()> {
        let directory = self
            .directory
            .take()
            .ok_or_else(|| blocked("GCP ADC snapshot cleanup failed"))?;
        dispose_snapshot_root(&self.capability_root, directory)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub(crate) fn cleanup(&mut self) -> AppResult<()> {
        Err(blocked("GCP ADC snapshot cleanup is unavailable"))
    }
}

/// Disposes a private temp root without ever path-walking an attacker-swapped
/// replacement. `TempDir::close` is only reached after the parent descriptor
/// proves that its visible name still resolves to the original opened inode.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn dispose_snapshot_root(capability_root: &CapabilityRoot, directory: TempDir) -> AppResult<()> {
    if capability_root.cleanup_and_remove().is_ok() {
        let _ = directory.keep();
        return Ok(());
    }
    if !capability_root.root_is_current() {
        // The descriptor no longer names the original root. Keep the TempDir
        // disarmed rather than risk touching a replacement. Callers fail
        // closed; no bearer/token can progress from this state.
        let _ = directory.keep();
        return Err(blocked("GCP ADC snapshot cleanup failed"));
    }
    // Rust's Unix recursive remover does not follow the internal symlink
    // fixture exercised in `gcp_adc_tests`; this remains a last resort after
    // two descriptor-rooted attempts only.
    directory
        .close()
        .map_err(|_| blocked("GCP ADC snapshot cleanup failed"))
}

fn materialize_files(
    directory: &Path,
    document: &mut Value,
    subject: Option<&SubjectTokenGuard>,
) -> AppResult<PathBuf> {
    if let Some(subject) = subject {
        let subject_path = directory.join("subject-token");
        let subject_bytes = subject.snapshot_bytes()?;
        write_private(&subject_path, &subject_bytes)?;
        drop(subject_bytes);
        let source = document
            .get_mut("credential_source")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| blocked("GCP WIF credential is invalid"))?;
        source.insert(
            "file".into(),
            Value::String(subject_path.to_string_lossy().into_owned()),
        );
    }
    let serialized = Zeroizing::new(
        serde_json::to_vec(document).map_err(|_| blocked("GCP ADC credential is invalid"))?,
    );
    let snapshot_adc = directory.join("application_default_credentials.json");
    write_private(&snapshot_adc, &serialized)?;
    drop(serialized);
    Ok(snapshot_adc)
}

impl Drop for GcloudSnapshot {
    fn drop(&mut self) {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let _ = self.cleanup();
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| blocked("GCP ADC snapshot is unavailable"))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| blocked("GCP ADC snapshot is unavailable"))
}

fn establish_private_directory(path: &Path) -> AppResult<()> {
    let before =
        std::fs::symlink_metadata(path).map_err(|_| blocked("GCP ADC snapshot is unavailable"))?;
    if before.file_type().is_symlink() || !before.is_dir() {
        return Err(blocked("GCP ADC snapshot is unavailable"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| blocked("GCP ADC snapshot is unavailable"))?;
    }
    let after =
        std::fs::symlink_metadata(path).map_err(|_| blocked("GCP ADC snapshot is unavailable"))?;
    if after.file_type().is_symlink() || !after.is_dir() {
        return Err(blocked("GCP ADC snapshot is unavailable"));
    }
    Ok(())
}

fn open_no_follow(path: &Path) -> AppResult<File> {
    if !path.is_absolute() {
        return Err(blocked("GCP ADC credential is invalid"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
        .open(path)
        .map_err(|_| blocked("GCP ADC credential is unavailable"))
}

fn read_bounded(file: File, limit: u64) -> AppResult<Vec<u8>> {
    let mut reader: Take<File> = file.take(limit.saturating_add(1));
    let mut bytes = Vec::with_capacity(limit.min(4096) as usize);
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| blocked("GCP ADC credential is unavailable"))?;
    if bytes.len() as u64 > limit {
        return Err(blocked("GCP ADC credential is invalid"));
    }
    Ok(bytes)
}

fn read_safe_subject_token(
    path: &Path,
) -> AppResult<(Zeroizing<Vec<u8>>, u64, SubjectTokenFileIdentity)> {
    let file = open_no_follow(path)?;
    let metadata = file
        .metadata()
        .map_err(|_| blocked("GCP WIF credential is unavailable"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ADC_BYTES {
        return Err(blocked("GCP WIF credential is invalid"));
    }
    let bytes = Zeroizing::new(read_bounded(file, MAX_ADC_BYTES)?);
    if bytes.len() as u64 != metadata.len()
        || bytes.iter().any(|byte| *byte == 0 || !byte.is_ascii())
    {
        return Err(blocked("GCP WIF credential is invalid"));
    }
    let path_metadata =
        std::fs::symlink_metadata(path).map_err(|_| blocked("GCP WIF credential is invalid"))?;
    if path_metadata.file_type().is_symlink()
        || !path_metadata.is_file()
        || path_metadata.len() != metadata.len()
    {
        return Err(blocked("GCP WIF credential is invalid"));
    }
    Ok((
        bytes,
        metadata.len(),
        SubjectTokenFileIdentity {
            #[cfg(unix)]
            device: subject_device(&metadata),
            #[cfg(unix)]
            inode: subject_inode(&metadata),
        },
    ))
}

#[cfg(unix)]
fn subject_device(metadata: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.dev()
}

#[cfg(unix)]
fn subject_inode(metadata: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.ino()
}
