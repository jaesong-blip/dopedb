//! Pure inventory status, managed-marker, snapshot, and fingerprint rules.

use std::path::{Path, PathBuf};

use dopedb_protocol::{SkillConflict, SkillConflictKind, SkillInstallState, SkillStatusReason};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::super::bundle::{ManifestFile, SkillBundle};

pub(crate) const MARKER_FILE: &str = ".dopedb-managed.json";

#[derive(Debug, Clone)]
pub(super) struct TargetPaths {
    pub(super) display_name: &'static str,
    pub(super) root_path: PathBuf,
    pub(super) target_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TargetInspection {
    Missing,
    Symlink,
    NotDirectory { repairable: bool },
    Directory,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone)]
pub(super) struct ScannedEntry {
    pub(super) path: String,
    pub(super) kind: EntryKind,
    pub(super) size: u64,
    pub(super) executable: bool,
    pub(super) sha256: Option<String>,
    pub(super) normalized_text_sha256: Option<String>,
    pub(super) content: Option<Vec<u8>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedMarker {
    schema_version: u64,
    skill_name: String,
    release_revision: u64,
    package_digest: String,
}

#[derive(Debug, Clone)]
pub(super) enum ScanFailure {
    UnsafePath(SkillStatusReason),
    Invalid(SkillStatusReason, bool),
    Io,
}

#[derive(Debug)]
pub(super) struct InventoryDecision {
    pub(super) state: SkillInstallState,
    pub(super) repairable: bool,
    pub(super) installed_revision: Option<u64>,
    pub(super) installed_package_digest: Option<String>,
    pub(super) inventory_fingerprint: String,
    pub(super) reason: Option<SkillStatusReason>,
    pub(super) conflicts: Vec<SkillConflict>,
}

pub(super) fn status_from_entries(
    bundle: &SkillBundle,
    entries: Vec<ScannedEntry>,
) -> InventoryDecision {
    let current_revision = bundle.current.release_revision;
    let fingerprint = entries_fingerprint(&entries);
    let marker = match parse_marker(&entries) {
        Ok(marker) => marker,
        Err(reason) => {
            return InventoryDecision {
                state: SkillInstallState::Invalid,
                repairable: true,
                installed_revision: None,
                installed_package_digest: None,
                inventory_fingerprint: fingerprint,
                reason: Some(reason),
                conflicts: vec![SkillConflict {
                    path: MARKER_FILE.into(),
                    kind: SkillConflictKind::InvalidProvenance,
                }],
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
                return InventoryDecision {
                    state,
                    repairable: true,
                    installed_revision: Some(snapshot.release_revision),
                    installed_package_digest: Some(snapshot.package_digest.clone()),
                    inventory_fingerprint: fingerprint,
                    reason: None,
                    conflicts: Vec::new(),
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
    InventoryDecision {
        state,
        repairable: true,
        installed_revision,
        installed_package_digest,
        inventory_fingerprint: fingerprint,
        reason,
        conflicts,
    }
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

pub(super) fn failure_fingerprint(path: &Path, reason: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_os_str().to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(reason.as_bytes());
    hex::encode(hasher.finalize())
}

pub(super) fn reason_fingerprint(path: &Path, reason: SkillStatusReason) -> String {
    let reason = serde_json::to_string(&reason).unwrap_or_else(|_| "\"unknown\"".into());
    failure_fingerprint(path, &reason)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::TargetPaths;

    #[test]
    fn target_paths_remain_pure_domain_values() {
        let paths = TargetPaths {
            display_name: "Codex",
            root_path: PathBuf::from("/home/test/.agents/skills"),
            target_path: PathBuf::from("/home/test/.agents/skills/dopedb-cli"),
        };

        assert_eq!(paths.display_name, "Codex");
        assert!(paths.target_path.starts_with(&paths.root_path));
    }
}
