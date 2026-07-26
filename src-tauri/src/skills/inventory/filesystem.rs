//! Filesystem adapter for fail-closed, bounded Skill inventory inspection.

use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Component, Path};

use dopedb_protocol::{SkillStatusReason, SkillTarget};

use crate::error::{AppError, AppResult};

use super::super::bundle::{normalized_text_sha256, sha256_hex};
use super::super::{MAX_FILE_BYTES, MAX_INVENTORY_BYTES, MAX_INVENTORY_DEPTH, MAX_INVENTORY_FILES};
use super::domain::{EntryKind, ScanFailure, ScannedEntry, TargetInspection, TargetPaths};
use super::ports::InventoryFilesystemPort;

pub(super) struct Filesystem;

impl InventoryFilesystemPort for Filesystem {
    fn target_paths(&self, home: &Path, target: SkillTarget) -> TargetPaths {
        target_paths(home, target)
    }

    fn validate_managed_path(&self, home: &Path, target: &Path) -> Result<(), ScanFailure> {
        validate_managed_path(home, target)
    }

    fn inspect_target(&self, target: &Path) -> TargetInspection {
        inspect_target(target)
    }

    fn target_exists(&self, target: &Path) -> bool {
        target_exists(target)
    }

    fn scan_directory(&self, target: &Path) -> Result<Vec<ScannedEntry>, ScanFailure> {
        scan_directory(target)
    }
}

fn target_paths(home: &Path, target: SkillTarget) -> TargetPaths {
    let (display_name, root_path) = match target {
        SkillTarget::Codex => ("Codex", home.join(".agents").join("skills")),
        SkillTarget::ClaudeCode => ("Claude Code", home.join(".claude").join("skills")),
    };
    TargetPaths {
        display_name,
        target_path: root_path.join("dopedb-cli"),
        root_path,
    }
}

fn inspect_target(path: &Path) -> TargetInspection {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_link_or_reparse(&metadata) => TargetInspection::Symlink,
        Ok(metadata) if !metadata.is_dir() => TargetInspection::NotDirectory {
            repairable: metadata.is_file(),
        },
        Ok(_) => TargetInspection::Directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => TargetInspection::Missing,
        Err(_) => TargetInspection::Failed,
    }
}

fn target_exists(path: &Path) -> bool {
    path.exists()
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
        let relative = portable_relative_path(root, &path)?;

        if metadata.is_dir() {
            entries.push(ScannedEntry {
                path: relative,
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
            path: relative,
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

fn portable_relative_path(root: &Path, path: &Path) -> Result<String, ScanFailure> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| ScanFailure::UnsafePath(SkillStatusReason::InventoryEscapedRoot))?;
    let mut components = Vec::new();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(ScanFailure::UnsafePath(
                SkillStatusReason::InstalledSkillUnsafePath,
            ));
        };
        let component = component.to_str().ok_or(ScanFailure::Invalid(
            SkillStatusReason::InstalledSkillNonUnicodePath,
            true,
        ))?;
        if component.is_empty() || component == "." || component == ".." {
            return Err(ScanFailure::UnsafePath(
                SkillStatusReason::InstalledSkillUnsafePath,
            ));
        }
        components.push(component);
    }
    if components.is_empty() {
        return Err(ScanFailure::UnsafePath(
            SkillStatusReason::InstalledSkillUnsafePath,
        ));
    }
    Ok(components.join("/"))
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

#[cfg(unix)]
fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &fs::Metadata) -> bool {
    false
}

pub(crate) fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
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

pub(crate) fn prepare_root(home: &Path, root: &Path) -> AppResult<()> {
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
