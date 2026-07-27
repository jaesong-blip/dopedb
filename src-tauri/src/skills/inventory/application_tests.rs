use std::cell::RefCell;
use std::path::{Path, PathBuf};

use dopedb_protocol::{SkillInstallState, SkillStatusReason, SkillTarget};

use super::domain::{ScanFailure, ScannedEntry, TargetInspection, TargetPaths};
use super::ports::InventoryFilesystemPort;
use crate::skills::bundle::SkillBundle;

struct MockFilesystem {
    paths: TargetPaths,
    validation: Result<(), ScanFailure>,
    inspection: TargetInspection,
    exists: bool,
    scan: Result<Vec<ScannedEntry>, ScanFailure>,
    calls: RefCell<Vec<&'static str>>,
}

impl MockFilesystem {
    fn directory() -> Self {
        Self {
            paths: TargetPaths {
                display_name: "Codex",
                root_path: PathBuf::from("/mock/.agents/skills"),
                target_path: PathBuf::from("/mock/.agents/skills/dopedb-cli"),
            },
            validation: Ok(()),
            inspection: TargetInspection::Directory,
            exists: true,
            scan: Ok(Vec::new()),
            calls: RefCell::new(Vec::new()),
        }
    }
}

impl InventoryFilesystemPort for MockFilesystem {
    fn target_paths(&self, _home: &Path, _target: SkillTarget) -> TargetPaths {
        self.calls.borrow_mut().push("target_paths");
        self.paths.clone()
    }

    fn validate_managed_path(&self, _home: &Path, _target: &Path) -> Result<(), ScanFailure> {
        self.calls.borrow_mut().push("validate_managed_path");
        self.validation.clone()
    }

    fn inspect_target(&self, _target: &Path) -> TargetInspection {
        self.calls.borrow_mut().push("inspect_target");
        self.inspection
    }

    fn target_exists(&self, _target: &Path) -> bool {
        self.calls.borrow_mut().push("target_exists");
        self.exists
    }

    fn scan_directory(&self, _target: &Path) -> Result<Vec<ScannedEntry>, ScanFailure> {
        self.calls.borrow_mut().push("scan_directory");
        self.scan.clone()
    }
}

#[test]
fn application_scans_only_after_the_port_validates_a_directory_target() {
    let filesystem = MockFilesystem::directory();
    let bundle = SkillBundle::load().unwrap();

    let status =
        super::application::inventory(&filesystem, Path::new("/mock"), &bundle, SkillTarget::Codex);

    assert_eq!(status.status.state, SkillInstallState::UnknownConflict);
    assert_eq!(
        *filesystem.calls.borrow(),
        vec![
            "target_paths",
            "validate_managed_path",
            "inspect_target",
            "scan_directory",
        ]
    );
}

#[test]
fn application_uses_the_port_existence_result_for_validation_failures() {
    let mut filesystem = MockFilesystem::directory();
    filesystem.validation = Err(ScanFailure::UnsafePath(
        SkillStatusReason::InstallPathSymlink,
    ));
    filesystem.exists = false;
    let bundle = SkillBundle::load().unwrap();

    let status =
        super::application::inventory(&filesystem, Path::new("/mock"), &bundle, SkillTarget::Codex);

    assert_eq!(status.status.state, SkillInstallState::Invalid);
    assert_eq!(
        status.status.reason,
        Some(SkillStatusReason::InstallPathSymlink)
    );
    assert!(!status.exists);
    assert!(!status.repairable);
    assert_eq!(
        *filesystem.calls.borrow(),
        vec!["target_paths", "validate_managed_path", "target_exists"]
    );
}

#[test]
fn application_stops_before_scanning_when_the_target_is_missing() {
    let mut filesystem = MockFilesystem::directory();
    filesystem.inspection = TargetInspection::Missing;
    let bundle = SkillBundle::load().unwrap();

    let status =
        super::application::inventory(&filesystem, Path::new("/mock"), &bundle, SkillTarget::Codex);

    assert_eq!(status.status.state, SkillInstallState::Missing);
    assert!(!status.exists);
    assert_eq!(
        *filesystem.calls.borrow(),
        vec!["target_paths", "validate_managed_path", "inspect_target"]
    );
}
