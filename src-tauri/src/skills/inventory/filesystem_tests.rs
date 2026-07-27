use std::fs;

use dopedb_protocol::{SkillInstallState, SkillTarget};
use tempfile::TempDir;

use super::inventory;
use crate::skills::bundle::SkillBundle;
use crate::skills::{
    MAX_FILE_BYTES, MAX_INVENTORY_BYTES, MAX_INVENTORY_DEPTH, MAX_INVENTORY_FILES,
};

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
