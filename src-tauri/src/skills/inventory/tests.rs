use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

use dopedb_protocol::{
    SkillConflict, SkillConflictKind, SkillInstallState, SkillMutationArguments, SkillStatusReason,
    SkillTarget, SkillTargetExpectation, SkillTargetSelection,
};
use tempfile::TempDir;

use super::domain::MARKER_FILE;
use super::domain::{ScanFailure, ScannedEntry, TargetInspection, TargetPaths};
use super::inventory;
use super::ports::InventoryFilesystemPort;
use crate::skills::bundle::SkillBundle;
use crate::skills::{
    SkillManager, MAX_FILE_BYTES, MAX_INVENTORY_BYTES, MAX_INVENTORY_DEPTH, MAX_INVENTORY_FILES,
};

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

#[test]
fn missing_targets_use_the_current_official_user_roots() {
    let home = TempDir::new().unwrap();
    let bundle = SkillBundle::load().unwrap();
    let codex = inventory(home.path(), &bundle, dopedb_protocol::SkillTarget::Codex);
    let claude = inventory(
        home.path(),
        &bundle,
        dopedb_protocol::SkillTarget::ClaudeCode,
    );
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
    let status = inventory(home.path(), &bundle, dopedb_protocol::SkillTarget::Codex);
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
    let status = inventory(home.path(), &bundle, dopedb_protocol::SkillTarget::Codex);
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
    let status = inventory(home.path(), &bundle, dopedb_protocol::SkillTarget::Codex);
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
    let status = inventory(home.path(), &bundle, dopedb_protocol::SkillTarget::Codex);
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
    let status = inventory(home.path(), &bundle, dopedb_protocol::SkillTarget::Codex);
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
    let older = inventory(
        home.path(),
        &later_bundle,
        dopedb_protocol::SkillTarget::Codex,
    );
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

    let status = inventory(home.path(), &bundle, dopedb_protocol::SkillTarget::Codex);
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
