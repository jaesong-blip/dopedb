use std::fs;
use std::path::PathBuf;

use dopedb_protocol::{
    SkillConflict, SkillConflictKind, SkillInstallState, SkillMutationArguments,
    SkillTargetExpectation, SkillTargetSelection,
};
use tempfile::TempDir;

use super::domain::MARKER_FILE;
use super::inventory;
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
