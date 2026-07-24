use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use dopedb_protocol::{
    SkillBackup, SkillInstallState, SkillMutationArguments, SkillMutationResult, SkillStatusResult,
    SkillTarget,
};
use serde::Serialize;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::inventory::{inventory, is_link_or_reparse, prepare_root, Inventory, MARKER_FILE};
use super::SkillManager;

#[derive(Debug, Clone, Copy)]
pub(super) enum MutationKind {
    Install,
    Repair,
    Remove,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedMarker<'a> {
    schema_version: u64,
    skill_name: &'a str,
    release_revision: u64,
    package_digest: &'a str,
}

pub(super) fn mutate(
    manager: &SkillManager,
    arguments: SkillMutationArguments,
    kind: MutationKind,
) -> AppResult<SkillMutationResult> {
    let _guard = manager
        .inner
        .mutation_lock
        .lock()
        .map_err(|_| AppError::Config("the Skill mutation lock is unavailable".into()))?;
    let targets = arguments.target.targets();
    let inventories = targets
        .iter()
        .copied()
        .map(|target| {
            (
                target,
                inventory(&manager.inner.home, &manager.inner.bundle, target),
            )
        })
        .collect::<BTreeMap<_, _>>();
    validate_expectations(&targets, &inventories, &arguments)?;
    validate_actions(kind, &inventories)?;

    let mut changed_targets = Vec::new();
    let mut backups = Vec::new();
    for target in targets.iter().copied() {
        let before = inventories
            .get(&target)
            .ok_or_else(|| AppError::Config("the Skill target inventory is missing".into()))?;
        let current = inventory(&manager.inner.home, &manager.inner.bundle, target);
        if current.status.inventory_fingerprint != before.status.inventory_fingerprint {
            return Err(AppError::Blocked {
                reason: format!(
                    "{} Skill files changed after inventory; refresh status and try again",
                    before.status.display_name
                ),
            });
        }

        match kind {
            MutationKind::Install => match before.status.state {
                SkillInstallState::Missing => {
                    replace_target(manager, before, false)?;
                    changed_targets.push(target);
                }
                SkillInstallState::ManagedOlder => {
                    replace_target(manager, before, false)?;
                    changed_targets.push(target);
                }
                SkillInstallState::ManagedCurrent => {}
                _ => unreachable!("action states are prevalidated"),
            },
            MutationKind::Repair => match before.status.state {
                SkillInstallState::ManagedCurrent => {}
                _ => {
                    let backup = replace_target(manager, before, true)?.ok_or_else(|| {
                        AppError::Config("the repaired Skill did not produce a backup".into())
                    })?;
                    changed_targets.push(target);
                    backups.push(SkillBackup {
                        target,
                        path: backup.to_string_lossy().into_owned(),
                    });
                }
            },
            MutationKind::Remove => match before.status.state {
                SkillInstallState::Missing => {}
                _ => {
                    remove_managed_target(before)?;
                    changed_targets.push(target);
                }
            },
        }
    }

    Ok(SkillMutationResult {
        status: SkillStatusResult {
            skill: manager.inner.bundle.summary(),
            targets: targets
                .into_iter()
                .map(|target| inventory(&manager.inner.home, &manager.inner.bundle, target).status)
                .collect(),
        },
        changed_targets,
        backups,
    })
}

fn validate_expectations(
    targets: &[SkillTarget],
    inventories: &BTreeMap<SkillTarget, Inventory>,
    arguments: &SkillMutationArguments,
) -> AppResult<()> {
    let expected_targets = arguments
        .expected
        .iter()
        .map(|expected| expected.target)
        .collect::<BTreeSet<_>>();
    if expected_targets.len() != arguments.expected.len()
        || expected_targets != targets.iter().copied().collect()
    {
        return Err(AppError::Blocked {
            reason:
                "the Skill mutation does not contain one exact inventory expectation per target"
                    .into(),
        });
    }
    for expectation in &arguments.expected {
        let actual = inventories
            .get(&expectation.target)
            .ok_or_else(|| AppError::Config("the Skill target inventory is missing".into()))?;
        if expectation.inventory_fingerprint != actual.status.inventory_fingerprint {
            return Err(AppError::Blocked {
                reason: format!(
                    "{} Skill files changed; refresh status before modifying them",
                    actual.status.display_name
                ),
            });
        }
    }
    Ok(())
}

fn validate_actions(
    kind: MutationKind,
    inventories: &BTreeMap<SkillTarget, Inventory>,
) -> AppResult<()> {
    for inventory in inventories.values() {
        let allowed = match kind {
            MutationKind::Install => matches!(
                inventory.status.state,
                SkillInstallState::Missing
                    | SkillInstallState::ManagedCurrent
                    | SkillInstallState::ManagedOlder
            ),
            MutationKind::Repair => {
                inventory.status.state != SkillInstallState::Missing && inventory.repairable
            }
            MutationKind::Remove => matches!(
                inventory.status.state,
                SkillInstallState::Missing
                    | SkillInstallState::ManagedCurrent
                    | SkillInstallState::ManagedOlder
                    | SkillInstallState::NewerKnown
            ),
        };
        if !allowed {
            let action = match kind {
                MutationKind::Install => "install or update",
                MutationKind::Repair => "repair",
                MutationKind::Remove => "remove",
            };
            return Err(AppError::Blocked {
                reason: format!(
                    "cannot {action} the {} Skill while its state is {:?}",
                    inventory.status.display_name, inventory.status.state
                ),
            });
        }
    }
    Ok(())
}

fn replace_target(
    manager: &SkillManager,
    before: &Inventory,
    keep_backup: bool,
) -> AppResult<Option<PathBuf>> {
    prepare_root(&manager.inner.home, &before.root_path)?;
    let stage = before
        .root_path
        .join(format!(".dopedb-cli-stage-{}", Uuid::new_v4()));
    fs::create_dir(&stage)?;
    restrict_directory(&stage)?;

    let prepared = prepare_stage(manager, &stage);
    if let Err(error) = prepared {
        let _ = remove_path_safely(&stage);
        return Err(error);
    }

    let backup = before
        .root_path
        .join(format!(".dopedb-cli-backup-{}", Uuid::new_v4()));
    let had_target = fs::symlink_metadata(&before.target_path).is_ok();
    if had_target {
        fs::rename(&before.target_path, &backup)?;
    }
    if let Err(error) = fs::rename(&stage, &before.target_path) {
        if had_target {
            let _ = fs::rename(&backup, &before.target_path);
        }
        let _ = remove_path_safely(&stage);
        return Err(error.into());
    }
    sync_directory(&before.root_path);

    if had_target && keep_backup {
        Ok(Some(backup))
    } else {
        if had_target {
            remove_path_safely(&backup)?;
        }
        Ok(None)
    }
}

fn prepare_stage(manager: &SkillManager, stage: &Path) -> AppResult<()> {
    for source in &manager.inner.bundle.current.install_files {
        let relative = Path::new(&source.path);
        let target = stage.join(relative);
        if !target.starts_with(stage) {
            return Err(AppError::Blocked {
                reason: "an embedded Skill file escaped its staging directory".into(),
            });
        }
        if let Some(parent) = target.parent() {
            create_stage_directories(stage, parent)?;
        }
        let content = source.content.as_deref().ok_or_else(|| {
            AppError::Config("an embedded Skill install file has no content".into())
        })?;
        write_new_file(&target, content.as_bytes(), source.executable)?;
    }

    let marker = ManagedMarker {
        schema_version: 1,
        skill_name: &manager.inner.bundle.current.skill_name,
        release_revision: manager.inner.bundle.current.release_revision,
        package_digest: &manager.inner.bundle.current.package_digest,
    };
    let mut marker_bytes = serde_json::to_vec_pretty(&marker)?;
    marker_bytes.push(b'\n');
    write_new_file(&stage.join(MARKER_FILE), &marker_bytes, false)?;
    sync_directory(stage);
    Ok(())
}

fn create_stage_directories(stage: &Path, parent: &Path) -> AppResult<()> {
    let relative = parent.strip_prefix(stage).map_err(|_| AppError::Blocked {
        reason: "an embedded Skill directory escaped its staging root".into(),
    })?;
    let mut cursor = stage.to_path_buf();
    for component in relative.components() {
        cursor.push(component.as_os_str());
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
            Ok(_) => {
                return Err(AppError::Blocked {
                    reason: "an embedded Skill directory is not safe to create".into(),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&cursor)?;
                restrict_directory(&cursor)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn write_new_file(path: &Path, bytes: &[u8], executable: bool) -> AppResult<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    restrict_file(path, executable)?;
    Ok(())
}

fn remove_managed_target(before: &Inventory) -> AppResult<()> {
    if !before.exists {
        return Ok(());
    }
    let tombstone = before
        .root_path
        .join(format!(".dopedb-cli-remove-{}", Uuid::new_v4()));
    fs::rename(&before.target_path, &tombstone)?;
    sync_directory(&before.root_path);
    remove_path_safely(&tombstone)
}

fn remove_path_safely(path: &Path) -> AppResult<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if is_link_or_reparse(&metadata) || metadata.is_file() {
        fs::remove_file(path)?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "refusing to remove an unsupported Skill path type".into(),
        });
    }
    for entry in fs::read_dir(path)? {
        remove_path_safely(&entry?.path())?;
    }
    fs::remove_dir(path)?;
    Ok(())
}

fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
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

#[cfg(unix)]
fn restrict_file(path: &Path, executable: bool) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = if executable { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path, _executable: bool) -> AppResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use dopedb_protocol::{SkillInstallState, SkillTargetExpectation, SkillTargetSelection};
    use tempfile::TempDir;

    use super::*;
    use crate::skills::SkillManager;

    fn expected(status: &SkillStatusResult) -> Vec<SkillTargetExpectation> {
        status
            .targets
            .iter()
            .map(|target| SkillTargetExpectation {
                target: target.target,
                inventory_fingerprint: target.inventory_fingerprint.clone(),
            })
            .collect()
    }

    #[test]
    fn install_is_atomic_current_and_remove_accepts_only_known_bytes() {
        let home = TempDir::new().unwrap();
        let manager = SkillManager::for_home(home.path().to_path_buf()).unwrap();
        let before = manager.status(SkillTargetSelection::Codex).unwrap();
        let installed = manager
            .install(SkillMutationArguments {
                target: SkillTargetSelection::Codex,
                expected: expected(&before),
            })
            .unwrap();
        assert_eq!(
            installed.status.targets[0].state,
            SkillInstallState::ManagedCurrent
        );
        assert!(installed.status.targets[0]
            .install_path
            .ends_with(".agents/skills/dopedb-cli"));

        let removed = manager
            .remove(SkillMutationArguments {
                target: SkillTargetSelection::Codex,
                expected: expected(&installed.status),
            })
            .unwrap();
        assert_eq!(removed.status.targets[0].state, SkillInstallState::Missing);
    }

    #[test]
    fn user_modified_install_is_preserved_and_repair_creates_a_backup() {
        let home = TempDir::new().unwrap();
        let manager = SkillManager::for_home(home.path().to_path_buf()).unwrap();
        let before = manager.status(SkillTargetSelection::Codex).unwrap();
        let installed = manager
            .install(SkillMutationArguments {
                target: SkillTargetSelection::Codex,
                expected: expected(&before),
            })
            .unwrap();
        let path = PathBuf::from(&installed.status.targets[0].install_path).join("SKILL.md");
        fs::write(&path, b"user content\n").unwrap();

        let modified = manager.status(SkillTargetSelection::Codex).unwrap();
        assert_eq!(modified.targets[0].state, SkillInstallState::UserModified);
        assert!(manager
            .install(SkillMutationArguments {
                target: SkillTargetSelection::Codex,
                expected: expected(&modified),
            })
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"user content\n");

        let repaired = manager
            .repair(SkillMutationArguments {
                target: SkillTargetSelection::Codex,
                expected: expected(&modified),
            })
            .unwrap();
        assert_eq!(repaired.backups.len(), 1);
        assert_eq!(
            fs::read(PathBuf::from(&repaired.backups[0].path).join("SKILL.md")).unwrap(),
            b"user content\n"
        );
        assert_eq!(
            repaired.status.targets[0].state,
            SkillInstallState::ManagedCurrent
        );
    }

    #[test]
    fn stale_inventory_fingerprint_blocks_every_mutation() {
        let home = TempDir::new().unwrap();
        let manager = SkillManager::for_home(home.path().to_path_buf()).unwrap();
        let before = manager.status(SkillTargetSelection::ClaudeCode).unwrap();
        let target = PathBuf::from(&before.targets[0].install_path);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), b"foreign\n").unwrap();
        assert!(manager
            .install(SkillMutationArguments {
                target: SkillTargetSelection::ClaudeCode,
                expected: expected(&before),
            })
            .is_err());
        assert_eq!(fs::read(target.join("SKILL.md")).unwrap(), b"foreign\n");
    }

    #[test]
    fn unknown_files_are_preserved_until_explicit_repair() {
        let home = TempDir::new().unwrap();
        let manager = SkillManager::for_home(home.path().to_path_buf()).unwrap();
        let target = home.path().join(".agents/skills/dopedb-cli");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("notes.md"), b"keep me\n").unwrap();

        let unknown = manager.status(SkillTargetSelection::Codex).unwrap();
        assert_eq!(unknown.targets[0].state, SkillInstallState::UnknownConflict);
        let arguments = SkillMutationArguments {
            target: SkillTargetSelection::Codex,
            expected: expected(&unknown),
        };
        assert!(manager.install(arguments.clone()).is_err());
        assert!(manager.remove(arguments.clone()).is_err());
        assert_eq!(fs::read(target.join("notes.md")).unwrap(), b"keep me\n");

        let repaired = manager.repair(arguments).unwrap();
        assert_eq!(repaired.backups.len(), 1);
        assert_eq!(
            fs::read(PathBuf::from(&repaired.backups[0].path).join("notes.md")).unwrap(),
            b"keep me\n"
        );
        assert_eq!(
            repaired.status.targets[0].state,
            SkillInstallState::ManagedCurrent
        );
    }
}
