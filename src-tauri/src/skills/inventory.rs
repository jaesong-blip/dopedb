use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use dopedb_protocol::{
    SkillConflict, SkillConflictKind, SkillInstallState, SkillStatusReason, SkillTarget,
    SkillTargetStatus,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

use super::bundle::{normalized_text_sha256, sha256_hex, ManifestFile, SkillBundle};
use super::{MAX_FILE_BYTES, MAX_INVENTORY_BYTES, MAX_INVENTORY_DEPTH, MAX_INVENTORY_FILES};

pub(super) const MARKER_FILE: &str = ".dopedb-managed.json";

#[derive(Debug)]
pub(super) struct Inventory {
    pub status: SkillTargetStatus,
    pub target_path: PathBuf,
    pub root_path: PathBuf,
    pub exists: bool,
    pub repairable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    File,
    Directory,
}

#[derive(Debug)]
struct ScannedEntry {
    path: String,
    kind: EntryKind,
    size: u64,
    executable: bool,
    sha256: Option<String>,
    normalized_text_sha256: Option<String>,
    content: Option<Vec<u8>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedMarker {
    schema_version: u64,
    skill_name: String,
    release_revision: u64,
    package_digest: String,
}

#[derive(Debug)]
enum ScanFailure {
    UnsafePath(SkillStatusReason),
    Invalid(SkillStatusReason, bool),
    Io,
}

pub(super) fn inventory(home: &Path, bundle: &SkillBundle, target: SkillTarget) -> Inventory {
    let (display_name, root_path, target_path) = target_paths(home, target);
    let current_revision = bundle.current.release_revision;
    let invalid = |reason: SkillStatusReason, exists: bool, repairable: bool| Inventory {
        status: SkillTargetStatus {
            target,
            display_name: display_name.into(),
            install_path: target_path.to_string_lossy().into_owned(),
            state: SkillInstallState::Invalid,
            repairable,
            current_revision,
            installed_revision: None,
            installed_package_digest: None,
            inventory_fingerprint: reason_fingerprint(&target_path, reason),
            reason: Some(reason),
            conflicts: Vec::new(),
        },
        target_path: target_path.clone(),
        root_path: root_path.clone(),
        exists,
        repairable,
    };

    if let Err(error) = validate_managed_path(home, &target_path) {
        return match error {
            ScanFailure::UnsafePath(reason) => invalid(reason, target_path.exists(), false),
            ScanFailure::Invalid(reason, repairable) => {
                invalid(reason, target_path.exists(), repairable)
            }
            ScanFailure::Io => invalid(
                SkillStatusReason::InstallPathInspectionFailed,
                target_path.exists(),
                false,
            ),
        };
    }

    let metadata = match fs::symlink_metadata(&target_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Inventory {
                status: SkillTargetStatus {
                    target,
                    display_name: display_name.into(),
                    install_path: target_path.to_string_lossy().into_owned(),
                    state: SkillInstallState::Missing,
                    repairable: true,
                    current_revision,
                    installed_revision: None,
                    installed_package_digest: None,
                    inventory_fingerprint: failure_fingerprint(&target_path, "missing"),
                    reason: None,
                    conflicts: Vec::new(),
                },
                target_path,
                root_path,
                exists: false,
                repairable: true,
            };
        }
        Err(_) => return invalid(SkillStatusReason::InstallPathInspectionFailed, true, false),
    };

    if is_link_or_reparse(&metadata) {
        return invalid(SkillStatusReason::InstallTargetSymlink, true, false);
    }
    if !metadata.is_dir() {
        return invalid(
            SkillStatusReason::InstallTargetNotDirectory,
            true,
            metadata.is_file(),
        );
    }

    let entries = match scan_directory(&target_path) {
        Ok(entries) => entries,
        Err(ScanFailure::UnsafePath(reason)) => return invalid(reason, true, false),
        Err(ScanFailure::Invalid(reason, repairable)) => return invalid(reason, true, repairable),
        Err(ScanFailure::Io) => {
            return invalid(SkillStatusReason::InstalledSkillReadFailed, true, false)
        }
    };
    let fingerprint = entries_fingerprint(&entries);

    let marker = match parse_marker(&entries) {
        Ok(marker) => marker,
        Err(reason) => {
            return Inventory {
                status: SkillTargetStatus {
                    target,
                    display_name: display_name.into(),
                    install_path: target_path.to_string_lossy().into_owned(),
                    state: SkillInstallState::Invalid,
                    repairable: true,
                    current_revision,
                    installed_revision: None,
                    installed_package_digest: None,
                    inventory_fingerprint: fingerprint,
                    reason: Some(reason),
                    conflicts: vec![SkillConflict {
                        path: MARKER_FILE.into(),
                        kind: SkillConflictKind::InvalidProvenance,
                    }],
                },
                target_path,
                root_path,
                exists: true,
                repairable: true,
            };
        }
    };

    if let Some(marker) = marker.as_ref() {
        if marker.schema_version == 1 && marker.skill_name == bundle.current.skill_name {
            if let Some(snapshot) = bundle.snapshots.iter().find(|snapshot| {
                snapshot.release_revision == marker.release_revision
                    && snapshot.package_digest == marker.package_digest
                    && snapshot_matches(&entries, &snapshot.files)
            }) {
                let state = match snapshot.release_revision.cmp(&current_revision) {
                    std::cmp::Ordering::Less => SkillInstallState::ManagedOlder,
                    std::cmp::Ordering::Equal => SkillInstallState::ManagedCurrent,
                    std::cmp::Ordering::Greater => SkillInstallState::NewerKnown,
                };
                return Inventory {
                    status: SkillTargetStatus {
                        target,
                        display_name: display_name.into(),
                        install_path: target_path.to_string_lossy().into_owned(),
                        state,
                        repairable: true,
                        current_revision,
                        installed_revision: Some(snapshot.release_revision),
                        installed_package_digest: Some(snapshot.package_digest.clone()),
                        inventory_fingerprint: fingerprint,
                        reason: None,
                        conflicts: Vec::new(),
                    },
                    target_path,
                    root_path,
                    exists: true,
                    repairable: true,
                };
            }
        }
    }

    let conflicts = conflicts_for_unmanaged(&entries, marker.as_ref(), bundle);
    let (state, installed_revision, installed_package_digest, reason) = if let Some(marker) = marker
    {
        let known = bundle.snapshots.iter().any(|snapshot| {
            snapshot.release_revision == marker.release_revision
                && snapshot.package_digest == marker.package_digest
        });
        if marker.schema_version == 1 && marker.skill_name == bundle.current.skill_name && known {
            (
                SkillInstallState::UserModified,
                Some(marker.release_revision),
                Some(marker.package_digest),
                Some(SkillStatusReason::FilesDifferFromManagedSnapshot),
            )
        } else {
            (
                SkillInstallState::UnknownConflict,
                Some(marker.release_revision),
                Some(marker.package_digest),
                Some(SkillStatusReason::UnknownManagedSnapshot),
            )
        }
    } else {
        (
            SkillInstallState::UnknownConflict,
            None,
            None,
            Some(SkillStatusReason::UnmanagedFiles),
        )
    };
    Inventory {
        status: SkillTargetStatus {
            target,
            display_name: display_name.into(),
            install_path: target_path.to_string_lossy().into_owned(),
            state,
            repairable: true,
            current_revision,
            installed_revision,
            installed_package_digest,
            inventory_fingerprint: fingerprint,
            reason,
            conflicts,
        },
        target_path,
        root_path,
        exists: true,
        repairable: true,
    }
}

pub(super) fn target_paths(home: &Path, target: SkillTarget) -> (&'static str, PathBuf, PathBuf) {
    let (display_name, root) = match target {
        SkillTarget::Codex => ("Codex", home.join(".agents").join("skills")),
        SkillTarget::ClaudeCode => ("Claude Code", home.join(".claude").join("skills")),
    };
    let target_path = root.join("dopedb-cli");
    (display_name, root, target_path)
}

fn validate_managed_path(home: &Path, target: &Path) -> Result<(), ScanFailure> {
    if !home.is_absolute() || !target.starts_with(home) {
        return Err(ScanFailure::UnsafePath(
            SkillStatusReason::InstallTargetOutsideHome,
        ));
    }
    let relative = target
        .strip_prefix(home)
        .map_err(|_| ScanFailure::UnsafePath(SkillStatusReason::InstallTargetOutsideHome))?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ScanFailure::UnsafePath(
            SkillStatusReason::UnsafePathComponent,
        ));
    }

    let mut cursor = home.to_path_buf();
    for component in relative.components() {
        cursor.push(component.as_os_str());
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if is_link_or_reparse(&metadata) => {
                return Err(ScanFailure::UnsafePath(
                    SkillStatusReason::InstallPathSymlink,
                ));
            }
            Ok(metadata) if cursor != target && !metadata.is_dir() => {
                return Err(ScanFailure::Invalid(
                    SkillStatusReason::InstallRootNotDirectory,
                    false,
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(ScanFailure::Io),
        }
    }
    Ok(())
}

fn scan_directory(target: &Path) -> Result<Vec<ScannedEntry>, ScanFailure> {
    let mut entries = Vec::new();
    let mut total_bytes = 0u64;
    scan_level(target, target, 0, &mut entries, &mut total_bytes)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

fn scan_level(
    root: &Path,
    directory: &Path,
    depth: usize,
    entries: &mut Vec<ScannedEntry>,
    total_bytes: &mut u64,
) -> Result<(), ScanFailure> {
    if depth > MAX_INVENTORY_DEPTH {
        return Err(ScanFailure::Invalid(
            SkillStatusReason::InstalledSkillNestingLimit,
            true,
        ));
    }
    let mut children = fs::read_dir(directory)
        .map_err(|_| ScanFailure::Io)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ScanFailure::Io)?;
    children.sort_by_key(|entry| entry.file_name());

    for child in children {
        if entries.len() >= MAX_INVENTORY_FILES {
            return Err(ScanFailure::Invalid(
                SkillStatusReason::InstalledSkillFileCountLimit,
                true,
            ));
        }
        let path = child.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| ScanFailure::Io)?;
        if is_link_or_reparse(&metadata) {
            return Err(ScanFailure::UnsafePath(
                SkillStatusReason::InstalledSkillSymlink,
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| ScanFailure::UnsafePath(SkillStatusReason::InventoryEscapedRoot))?;
        let relative = relative.to_str().ok_or(ScanFailure::Invalid(
            SkillStatusReason::InstalledSkillNonUnicodePath,
            true,
        ))?;
        if relative.contains('\\')
            || relative
                .split('/')
                .any(|component| component.is_empty() || component == "." || component == "..")
        {
            return Err(ScanFailure::UnsafePath(
                SkillStatusReason::InstalledSkillUnsafePath,
            ));
        }

        if metadata.is_dir() {
            entries.push(ScannedEntry {
                path: relative.replace('\\', "/"),
                kind: EntryKind::Directory,
                size: 0,
                executable: false,
                sha256: None,
                normalized_text_sha256: None,
                content: None,
            });
            scan_level(root, &path, depth + 1, entries, total_bytes)?;
            continue;
        }
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            return Err(ScanFailure::Invalid(
                SkillStatusReason::InstalledSkillUnsupportedFile,
                true,
            ));
        }
        *total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or(ScanFailure::Invalid(
                SkillStatusReason::InstalledSkillByteLimit,
                true,
            ))?;
        if *total_bytes > MAX_INVENTORY_BYTES {
            return Err(ScanFailure::Invalid(
                SkillStatusReason::InstalledSkillByteLimit,
                true,
            ));
        }
        let bytes = read_file_no_follow(&path, metadata.len())?;
        entries.push(ScannedEntry {
            path: relative.replace('\\', "/"),
            kind: EntryKind::File,
            size: metadata.len(),
            executable: is_executable(&metadata),
            sha256: Some(sha256_hex(&bytes)),
            normalized_text_sha256: normalized_text_sha256(&bytes),
            content: Some(bytes),
        });
    }
    Ok(())
}

fn read_file_no_follow(path: &Path, expected_size: u64) -> Result<Vec<u8>, ScanFailure> {
    let file = open_no_follow(path)?;
    let metadata = file.metadata().map_err(|_| ScanFailure::Io)?;
    if !metadata.is_file() || metadata.len() != expected_size || metadata.len() > MAX_FILE_BYTES {
        return Err(ScanFailure::Invalid(
            SkillStatusReason::InstalledFileChanged,
            true,
        ));
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .map_err(|_| ScanFailure::Invalid(SkillStatusReason::InstalledFileTooLarge, true))?,
    );
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ScanFailure::Io)?;
    if bytes.len() as u64 != expected_size {
        return Err(ScanFailure::Invalid(
            SkillStatusReason::InstalledFileChanged,
            true,
        ));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> Result<File, ScanFailure> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| ScanFailure::Io)
}

#[cfg(windows)]
fn open_no_follow(path: &Path) -> Result<File, ScanFailure> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| ScanFailure::Io)
}

#[cfg(not(any(unix, windows)))]
fn open_no_follow(path: &Path) -> Result<File, ScanFailure> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| ScanFailure::Io)
}

fn parse_marker(entries: &[ScannedEntry]) -> Result<Option<ManagedMarker>, SkillStatusReason> {
    let Some(entry) = entries.iter().find(|entry| entry.path == MARKER_FILE) else {
        return Ok(None);
    };
    if entry.kind != EntryKind::File {
        return Err(SkillStatusReason::ProvenanceMarkerNotFile);
    }
    let marker = serde_json::from_slice::<ManagedMarker>(
        entry
            .content
            .as_deref()
            .ok_or(SkillStatusReason::ProvenanceMarkerUnreadable)?,
    )
    .map_err(|_| SkillStatusReason::ProvenanceMarkerMalformed)?;
    Ok(Some(marker))
}

fn snapshot_matches(entries: &[ScannedEntry], expected: &[ManifestFile]) -> bool {
    let actual = entries
        .iter()
        .filter(|entry| entry.path != MARKER_FILE)
        .collect::<Vec<_>>();
    if actual.len() != expected.len() {
        return false;
    }
    expected.iter().all(|expected| {
        actual.iter().any(|entry| {
            entry.kind == EntryKind::File
                && entry.path == expected.path
                && entry.size == expected.size
                && entry.executable == expected.executable
                && entry.sha256.as_deref() == Some(&expected.sha256)
                && entry.normalized_text_sha256.as_deref() == Some(&expected.normalized_text_sha256)
        })
    })
}

fn snapshot_conflicts(entries: &[ScannedEntry], expected: &[ManifestFile]) -> Vec<SkillConflict> {
    let actual = entries
        .iter()
        .filter(|entry| entry.path != MARKER_FILE)
        .collect::<Vec<_>>();
    let mut conflicts = Vec::new();
    for expected in expected {
        match actual.iter().find(|entry| entry.path == expected.path) {
            None => conflicts.push(SkillConflict {
                path: expected.path.clone(),
                kind: SkillConflictKind::Missing,
            }),
            Some(entry)
                if entry.kind == EntryKind::File
                    && entry.size == expected.size
                    && entry.executable == expected.executable
                    && entry.sha256.as_deref() == Some(&expected.sha256)
                    && entry.normalized_text_sha256.as_deref()
                        == Some(&expected.normalized_text_sha256) => {}
            Some(_) => conflicts.push(SkillConflict {
                path: expected.path.clone(),
                kind: SkillConflictKind::Modified,
            }),
        }
    }
    for entry in actual {
        if !expected.iter().any(|expected| expected.path == entry.path) {
            conflicts.push(SkillConflict {
                path: entry.path.clone(),
                kind: SkillConflictKind::Unexpected,
            });
        }
    }
    conflicts.sort();
    conflicts
}

fn conflicts_for_unmanaged(
    entries: &[ScannedEntry],
    marker: Option<&ManagedMarker>,
    bundle: &SkillBundle,
) -> Vec<SkillConflict> {
    if let Some(marker) = marker {
        if marker.schema_version == 1 && marker.skill_name == bundle.current.skill_name {
            if let Some(snapshot) = bundle.snapshots.iter().find(|snapshot| {
                snapshot.release_revision == marker.release_revision
                    && snapshot.package_digest == marker.package_digest
            }) {
                return snapshot_conflicts(entries, &snapshot.files);
            }
        }

        let mut conflicts = vec![SkillConflict {
            path: MARKER_FILE.into(),
            kind: SkillConflictKind::InvalidProvenance,
        }];
        if !bundle
            .snapshots
            .iter()
            .any(|snapshot| snapshot_matches(entries, &snapshot.files))
        {
            conflicts.extend(
                entries
                    .iter()
                    .filter(|entry| entry.path != MARKER_FILE)
                    .map(|entry| SkillConflict {
                        path: entry.path.clone(),
                        kind: SkillConflictKind::Unexpected,
                    }),
            );
        }
        conflicts.sort();
        return conflicts;
    }

    let mut conflicts = vec![SkillConflict {
        path: MARKER_FILE.into(),
        kind: SkillConflictKind::Missing,
    }];
    if !bundle
        .snapshots
        .iter()
        .any(|snapshot| snapshot_matches(entries, &snapshot.files))
    {
        conflicts.extend(
            entries
                .iter()
                .filter(|entry| entry.path != MARKER_FILE)
                .map(|entry| SkillConflict {
                    path: entry.path.clone(),
                    kind: SkillConflictKind::Unexpected,
                }),
        );
    }
    conflicts.sort();
    conflicts
}

fn entries_fingerprint(entries: &[ScannedEntry]) -> String {
    let mut hasher = Sha256::new();
    for entry in entries {
        hasher.update(entry.path.as_bytes());
        hasher.update([0]);
        hasher.update(match entry.kind {
            EntryKind::File => b"file".as_slice(),
            EntryKind::Directory => b"directory".as_slice(),
        });
        hasher.update([0]);
        hasher.update(entry.size.to_le_bytes());
        hasher.update([u8::from(entry.executable)]);
        if let Some(digest) = &entry.sha256 {
            hasher.update(digest.as_bytes());
        }
        hasher.update([0xff]);
    }
    hex::encode(hasher.finalize())
}

fn failure_fingerprint(path: &Path, reason: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_os_str().to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(reason.as_bytes());
    hex::encode(hasher.finalize())
}

fn reason_fingerprint(path: &Path, reason: SkillStatusReason) -> String {
    let reason = serde_json::to_string(&reason).unwrap_or_else(|_| "\"unknown\"".into());
    failure_fingerprint(path, &reason)
}

#[cfg(unix)]
fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &fs::Metadata) -> bool {
    false
}

pub(super) fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn create_directory_component(path: &Path) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_link_or_reparse(&metadata) || !metadata.is_dir() => {
            Err(AppError::Blocked {
                reason: "refusing to use a non-directory or symbolic-link Skill root".into(),
            })
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path)?;
            restrict_directory(path)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) fn prepare_root(home: &Path, root: &Path) -> AppResult<()> {
    validate_managed_path(home, &root.join("dopedb-cli")).map_err(|_| AppError::Blocked {
        reason: "the Skill install root failed path validation".into(),
    })?;
    let relative = root.strip_prefix(home).map_err(|_| AppError::Blocked {
        reason: "the Skill install root is outside the user home directory".into(),
    })?;
    let mut cursor = home.to_path_buf();
    for component in relative.components() {
        cursor.push(component.as_os_str());
        create_directory_component(&cursor)?;
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_directory(_path: &Path) -> AppResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use dopedb_protocol::{SkillMutationArguments, SkillTargetExpectation, SkillTargetSelection};
    use tempfile::TempDir;

    use super::*;
    use crate::skills::bundle::SkillBundle;
    use crate::skills::SkillManager;

    fn expected(status: &dopedb_protocol::SkillStatusResult) -> Vec<SkillTargetExpectation> {
        status
            .targets
            .iter()
            .map(|target| SkillTargetExpectation {
                target: target.target,
                inventory_fingerprint: target.inventory_fingerprint.clone(),
            })
            .collect()
    }

    fn install_codex(home: &TempDir) -> SkillManager {
        let manager = SkillManager::for_home(home.path().to_path_buf()).unwrap();
        let before = manager.status(SkillTargetSelection::Codex).unwrap();
        manager
            .install(SkillMutationArguments {
                target: SkillTargetSelection::Codex,
                expected: expected(&before),
            })
            .unwrap();
        manager
    }

    #[test]
    fn missing_targets_use_the_current_official_user_roots() {
        let home = TempDir::new().unwrap();
        let bundle = SkillBundle::load().unwrap();
        let codex = inventory(home.path(), &bundle, SkillTarget::Codex);
        let claude = inventory(home.path(), &bundle, SkillTarget::ClaudeCode);
        assert_eq!(codex.status.state, SkillInstallState::Missing);
        assert!(codex.target_path.ends_with(".agents/skills/dopedb-cli"));
        assert!(claude.target_path.ends_with(".claude/skills/dopedb-cli"));
    }

    #[cfg(unix)]
    #[test]
    fn target_symlink_fails_closed() {
        use std::os::unix::fs::symlink;

        let home = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let root = home.path().join(".agents").join("skills");
        fs::create_dir_all(&root).unwrap();
        symlink(outside.path(), root.join("dopedb-cli")).unwrap();
        let bundle = SkillBundle::load().unwrap();
        let status = inventory(home.path(), &bundle, SkillTarget::Codex);
        assert_eq!(status.status.state, SkillInstallState::Invalid);
        assert!(!status.repairable);
    }

    #[cfg(unix)]
    #[test]
    fn nested_symlink_fails_closed() {
        use std::os::unix::fs::symlink;

        let home = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let target = home.path().join(".agents/skills/dopedb-cli");
        fs::create_dir_all(&target).unwrap();
        symlink(outside.path(), target.join("references")).unwrap();
        let bundle = SkillBundle::load().unwrap();
        let status = inventory(home.path(), &bundle, SkillTarget::Codex);
        assert_eq!(status.status.state, SkillInstallState::Invalid);
        assert!(!status.repairable);
    }

    #[test]
    fn bounded_scan_rejects_too_many_files() {
        let home = TempDir::new().unwrap();
        let target = home.path().join(".agents/skills/dopedb-cli");
        fs::create_dir_all(&target).unwrap();
        for index in 0..=MAX_INVENTORY_FILES {
            fs::write(target.join(format!("{index}.txt")), b"x").unwrap();
        }
        let bundle = SkillBundle::load().unwrap();
        let status = inventory(home.path(), &bundle, SkillTarget::Codex);
        assert_eq!(status.status.state, SkillInstallState::Invalid);
        assert!(status.repairable);
    }

    #[test]
    fn bounded_scan_rejects_too_many_bytes() {
        let home = TempDir::new().unwrap();
        let target = home.path().join(".agents/skills/dopedb-cli");
        fs::create_dir_all(&target).unwrap();
        let bytes = vec![b'x'; usize::try_from(MAX_FILE_BYTES).unwrap()];
        for index in 0..=MAX_INVENTORY_BYTES / MAX_FILE_BYTES {
            fs::write(target.join(format!("{index}.txt")), &bytes).unwrap();
        }
        let bundle = SkillBundle::load().unwrap();
        let status = inventory(home.path(), &bundle, SkillTarget::Codex);
        assert_eq!(status.status.state, SkillInstallState::Invalid);
        assert!(status.repairable);
    }

    #[test]
    fn bounded_scan_rejects_excessive_nesting() {
        let home = TempDir::new().unwrap();
        let mut target = home.path().join(".agents/skills/dopedb-cli");
        fs::create_dir_all(&target).unwrap();
        for index in 0..=MAX_INVENTORY_DEPTH {
            target = target.join(format!("level-{index}"));
        }
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("file.txt"), b"x").unwrap();
        let bundle = SkillBundle::load().unwrap();
        let status = inventory(home.path(), &bundle, SkillTarget::Codex);
        assert_eq!(status.status.state, SkillInstallState::Invalid);
        assert!(status.repairable);
    }

    #[test]
    fn fixture_states_distinguish_current_older_modified_and_unknown() {
        let home = TempDir::new().unwrap();
        let manager = install_codex(&home);
        let current = manager.status(SkillTargetSelection::Codex).unwrap();
        assert_eq!(current.targets[0].state, SkillInstallState::ManagedCurrent);
        assert!(current.targets[0].conflicts.is_empty());

        let mut later_bundle = SkillBundle::load().unwrap();
        later_bundle.current.release_revision += 1;
        let older = inventory(home.path(), &later_bundle, SkillTarget::Codex);
        assert_eq!(older.status.state, SkillInstallState::ManagedOlder);
        assert!(older.status.conflicts.is_empty());

        let installed_path = PathBuf::from(&current.targets[0].install_path);
        fs::write(installed_path.join("SKILL.md"), b"user edit\n").unwrap();
        let modified = manager.status(SkillTargetSelection::Codex).unwrap();
        assert_eq!(modified.targets[0].state, SkillInstallState::UserModified);
        assert_eq!(
            modified.targets[0].conflicts,
            vec![SkillConflict {
                path: "SKILL.md".into(),
                kind: SkillConflictKind::Modified,
            }]
        );

        fs::remove_file(installed_path.join(MARKER_FILE)).unwrap();
        let unknown = manager.status(SkillTargetSelection::Codex).unwrap();
        assert_eq!(unknown.targets[0].state, SkillInstallState::UnknownConflict);
        assert!(unknown.targets[0].conflicts.contains(&SkillConflict {
            path: MARKER_FILE.into(),
            kind: SkillConflictKind::Missing,
        }));
    }

    #[test]
    fn exact_official_bytes_without_a_known_marker_remain_unknown() {
        let home = TempDir::new().unwrap();
        let bundle = SkillBundle::load().unwrap();
        let target = home.path().join(".agents/skills/dopedb-cli");
        fs::create_dir_all(&target).unwrap();
        let install = &bundle.current.install_files[0];
        fs::write(
            target.join(&install.path),
            install.content.as_deref().unwrap(),
        )
        .unwrap();

        let status = inventory(home.path(), &bundle, SkillTarget::Codex);
        assert_eq!(status.status.state, SkillInstallState::UnknownConflict);
        assert!(status.repairable);
        assert_eq!(
            status.status.conflicts,
            vec![SkillConflict {
                path: MARKER_FILE.into(),
                kind: SkillConflictKind::Missing,
            }]
        );
    }
}
