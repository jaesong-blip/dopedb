//! Pure policy that maps inventory domain results to the public Skill status.

use std::path::PathBuf;

use dopedb_protocol::{SkillInstallState, SkillStatusReason, SkillTarget, SkillTargetStatus};

use super::domain::{self, InventoryDecision, ScanFailure, TargetInspection, TargetPaths};

#[derive(Debug)]
pub(crate) struct Inventory {
    pub(crate) status: SkillTargetStatus,
    pub(crate) target_path: PathBuf,
    pub(crate) root_path: PathBuf,
    pub(crate) exists: bool,
    pub(crate) repairable: bool,
}

pub(super) fn missing(paths: TargetPaths, target: SkillTarget, current_revision: u64) -> Inventory {
    let fingerprint = domain::failure_fingerprint(&paths.target_path, "missing");
    from_decision(
        paths,
        target,
        current_revision,
        false,
        InventoryDecision {
            state: SkillInstallState::Missing,
            repairable: true,
            installed_revision: None,
            installed_package_digest: None,
            inventory_fingerprint: fingerprint,
            reason: None,
            conflicts: Vec::new(),
        },
    )
}

pub(super) fn invalid(
    paths: TargetPaths,
    target: SkillTarget,
    current_revision: u64,
    reason: SkillStatusReason,
    exists: bool,
    repairable: bool,
) -> Inventory {
    let fingerprint = domain::reason_fingerprint(&paths.target_path, reason);
    from_decision(
        paths,
        target,
        current_revision,
        exists,
        InventoryDecision {
            state: SkillInstallState::Invalid,
            repairable,
            installed_revision: None,
            installed_package_digest: None,
            inventory_fingerprint: fingerprint,
            reason: Some(reason),
            conflicts: Vec::new(),
        },
    )
}

pub(super) fn from_domain_decision(
    paths: TargetPaths,
    target: SkillTarget,
    current_revision: u64,
    decision: InventoryDecision,
) -> Inventory {
    from_decision(paths, target, current_revision, true, decision)
}

pub(super) fn target_inspection(
    paths: TargetPaths,
    target: SkillTarget,
    current_revision: u64,
    inspection: TargetInspection,
) -> Option<Inventory> {
    match inspection {
        TargetInspection::Missing => Some(missing(paths, target, current_revision)),
        TargetInspection::Symlink => Some(invalid(
            paths,
            target,
            current_revision,
            SkillStatusReason::InstallTargetSymlink,
            true,
            false,
        )),
        TargetInspection::NotDirectory { repairable } => Some(invalid(
            paths,
            target,
            current_revision,
            SkillStatusReason::InstallTargetNotDirectory,
            true,
            repairable,
        )),
        TargetInspection::Directory => None,
        TargetInspection::Failed => Some(invalid(
            paths,
            target,
            current_revision,
            SkillStatusReason::InstallPathInspectionFailed,
            true,
            false,
        )),
    }
}

pub(super) fn path_validation_failure(
    paths: TargetPaths,
    target: SkillTarget,
    current_revision: u64,
    error: ScanFailure,
    exists: bool,
) -> Inventory {
    match error {
        ScanFailure::UnsafePath(reason) => {
            invalid(paths, target, current_revision, reason, exists, false)
        }
        ScanFailure::Invalid(reason, repairable) => {
            invalid(paths, target, current_revision, reason, exists, repairable)
        }
        ScanFailure::Io => invalid(
            paths,
            target,
            current_revision,
            SkillStatusReason::InstallPathInspectionFailed,
            exists,
            false,
        ),
    }
}

pub(super) fn scan_failure(
    paths: TargetPaths,
    target: SkillTarget,
    current_revision: u64,
    error: ScanFailure,
) -> Inventory {
    match error {
        ScanFailure::UnsafePath(reason) => {
            invalid(paths, target, current_revision, reason, true, false)
        }
        ScanFailure::Invalid(reason, repairable) => {
            invalid(paths, target, current_revision, reason, true, repairable)
        }
        ScanFailure::Io => invalid(
            paths,
            target,
            current_revision,
            SkillStatusReason::InstalledSkillReadFailed,
            true,
            false,
        ),
    }
}

fn from_decision(
    paths: TargetPaths,
    target: SkillTarget,
    current_revision: u64,
    exists: bool,
    decision: InventoryDecision,
) -> Inventory {
    Inventory {
        status: SkillTargetStatus {
            target,
            display_name: paths.display_name.into(),
            install_path: paths.target_path.to_string_lossy().into_owned(),
            state: decision.state,
            repairable: decision.repairable,
            current_revision,
            installed_revision: decision.installed_revision,
            installed_package_digest: decision.installed_package_digest,
            inventory_fingerprint: decision.inventory_fingerprint,
            reason: decision.reason,
            conflicts: decision.conflicts,
        },
        target_path: paths.target_path,
        root_path: paths.root_path,
        exists,
        repairable: decision.repairable,
    }
}
