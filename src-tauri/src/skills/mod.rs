//! Offline, version-matched Skill bundle and owner-local installation manager.

mod bundle;
mod installer;
mod inventory;

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use dopedb_protocol::{
    SkillMutationArguments, SkillMutationResult, SkillStatusResult, SkillTargetSelection,
    SkillsGetResult, SkillsListResult,
};
use serde::Serialize;

use crate::error::{AppError, AppResult};

use bundle::SkillBundle;
use installer::MutationKind;
use inventory::inventory;

pub(super) const MAX_FILE_BYTES: u64 = 256 * 1024;
pub(super) const MAX_INVENTORY_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_INVENTORY_FILES: usize = 32;
pub(super) const MAX_INVENTORY_DEPTH: usize = 4;
const MAX_SELF_TEST_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillSelfTestReceipt {
    pub app_version: String,
    pub release_revision: u64,
    pub guide_bytes: u64,
}

struct SkillManagerInner {
    home: PathBuf,
    bundle: SkillBundle,
    mutation_lock: Mutex<()>,
}

#[derive(Clone)]
pub(crate) struct SkillManager {
    inner: Arc<SkillManagerInner>,
}

impl SkillManager {
    pub fn new() -> AppResult<Self> {
        let home = dirs::home_dir()
            .ok_or_else(|| AppError::Config("no user home directory is available".into()))?;
        Self::from_home(home)
    }

    fn from_home(home: PathBuf) -> AppResult<Self> {
        if !home.is_absolute() {
            return Err(AppError::Config(
                "the user home directory is not absolute".into(),
            ));
        }
        Ok(Self {
            inner: Arc::new(SkillManagerInner {
                home,
                bundle: SkillBundle::load()?,
                mutation_lock: Mutex::new(()),
            }),
        })
    }

    pub fn list(&self) -> SkillsListResult {
        self.inner.bundle.list()
    }

    pub fn guide(&self, name: &str, full: bool) -> AppResult<SkillsGetResult> {
        self.inner.bundle.guide(name, full)
    }

    pub fn status(&self, target: SkillTargetSelection) -> AppResult<SkillStatusResult> {
        let _guard = self
            .inner
            .mutation_lock
            .lock()
            .map_err(|_| AppError::Config("the Skill inventory lock is unavailable".into()))?;
        Ok(self.status_unlocked(target))
    }

    fn status_unlocked(&self, target: SkillTargetSelection) -> SkillStatusResult {
        SkillStatusResult {
            skill: self.inner.bundle.summary(),
            targets: target
                .targets()
                .into_iter()
                .map(|target| inventory(&self.inner.home, &self.inner.bundle, target).status)
                .collect(),
        }
    }

    pub fn install(&self, arguments: SkillMutationArguments) -> AppResult<SkillMutationResult> {
        installer::mutate(self, arguments, MutationKind::Install)
    }

    pub fn repair(&self, arguments: SkillMutationArguments) -> AppResult<SkillMutationResult> {
        installer::mutate(self, arguments, MutationKind::Repair)
    }

    pub fn remove(&self, arguments: SkillMutationArguments) -> AppResult<SkillMutationResult> {
        installer::mutate(self, arguments, MutationKind::Remove)
    }

    pub fn self_test_cli(&self, binary: &std::path::Path) -> AppResult<SkillSelfTestReceipt> {
        let output = Command::new(binary)
            .args(["skills", "get", "dopedb-cli", "--json"])
            .output()?;
        if !output.status.success()
            || output.stdout.is_empty()
            || output.stdout.len() > MAX_SELF_TEST_OUTPUT_BYTES
        {
            return Err(AppError::Config(
                "the bundled CLI Skill self-test did not complete successfully".into(),
            ));
        }
        let result: SkillsGetResult = serde_json::from_slice(&output.stdout)?;
        let expected = self.inner.bundle.guide("dopedb-cli", false)?;
        if result.skill != expected.skill || result.guide != expected.guide {
            return Err(AppError::Config(
                "the bundled CLI guide does not match the app Skill bundle".into(),
            ));
        }
        Ok(SkillSelfTestReceipt {
            app_version: result.skill.app_version,
            release_revision: result.skill.release_revision,
            guide_bytes: u64::try_from(result.guide.len())
                .map_err(|_| AppError::Config("the Skill guide size is invalid".into()))?,
        })
    }
}

#[cfg(test)]
pub(crate) fn assert_skill_installation_contract() {
    use dopedb_protocol::{
        SkillConflictKind, SkillInstallState, SkillMutationArguments, SkillStatusResult,
        SkillTarget, SkillTargetExpectation, SkillTargetSelection,
    };
    use serde_json::json;
    use std::fs;

    const REVISION_18_STUB: &str = "---\nname: dopedb-cli\ndescription: Use the local DopeDB Desktop runtime safely through the version-matched dopedb CLI.\n---\n\nBefore using DopeDB, run:\ndopedb skills get dopedb-cli\n";

    fn mutation(
        target: SkillTargetSelection,
        status: &SkillStatusResult,
    ) -> SkillMutationArguments {
        SkillMutationArguments {
            target,
            expected: status
                .targets
                .iter()
                .map(|item| SkillTargetExpectation {
                    target: item.target,
                    inventory_fingerprint: item.inventory_fingerprint.clone(),
                })
                .collect(),
        }
    }

    fn target_path(home: &std::path::Path, target: SkillTarget) -> PathBuf {
        match target {
            SkillTarget::Codex => home.join(".agents/skills/dopedb-cli"),
            SkillTarget::ClaudeCode => home.join(".claude/skills/dopedb-cli"),
        }
    }

    fn write_marker(path: &std::path::Path, revision: u64, digest: &str) {
        fs::write(
            path.join(inventory::MARKER_FILE),
            serde_json::to_vec_pretty(&json!({
                "schemaVersion": 1,
                "skillName": "dopedb-cli",
                "releaseRevision": revision,
                "packageDigest": digest,
            }))
            .expect("serialize managed Skill marker"),
        )
        .expect("write managed Skill marker");
    }

    let home = tempfile::tempdir().expect("create isolated Skill home");
    let manager =
        SkillManager::from_home(home.path().to_path_buf()).expect("load embedded Skill bundle");
    let missing = manager
        .status(SkillTargetSelection::All)
        .expect("inspect clean profile");
    assert!(missing
        .targets
        .iter()
        .all(|target| target.state == SkillInstallState::Missing));

    let installed = manager
        .install(mutation(SkillTargetSelection::All, &missing))
        .expect("install Codex and Claude Code in one mutation");
    assert_eq!(
        installed.changed_targets,
        vec![SkillTarget::Codex, SkillTarget::ClaudeCode]
    );
    assert!(installed.status.targets.iter().all(|target| {
        target.state == SkillInstallState::ManagedCurrent
            && target.installed_revision == Some(installed.status.skill.release_revision)
            && target.installed_package_digest.as_deref()
                == Some(installed.status.skill.package_digest.as_str())
    }));

    let codex_path = target_path(home.path(), SkillTarget::Codex);
    let older = manager
        .inner
        .bundle
        .snapshots
        .iter()
        .find(|snapshot| snapshot.release_revision == 18)
        .expect("embedded revision 18 fixture");
    fs::write(codex_path.join("SKILL.md"), REVISION_18_STUB)
        .expect("seed older managed discovery stub");
    write_marker(&codex_path, older.release_revision, &older.package_digest);
    let older_status = manager
        .status(SkillTargetSelection::Codex)
        .expect("classify older managed copy");
    assert_eq!(
        older_status.targets[0].state,
        SkillInstallState::ManagedOlder
    );
    let updated = manager
        .install(mutation(SkillTargetSelection::Codex, &older_status))
        .expect("update exact older inventory");
    assert_eq!(updated.changed_targets, vec![SkillTarget::Codex]);
    assert_eq!(
        updated.status.targets[0].state,
        SkillInstallState::ManagedCurrent
    );

    write_marker(
        &codex_path,
        updated.status.skill.release_revision + 1,
        &"f".repeat(64),
    );
    let newer = manager
        .status(SkillTargetSelection::Codex)
        .expect("classify verified newer marker");
    assert_eq!(newer.targets[0].state, SkillInstallState::NewerKnown);
    assert!(manager
        .install(mutation(SkillTargetSelection::Codex, &newer))
        .is_err());

    manager
        .repair(mutation(SkillTargetSelection::Codex, &newer))
        .expect("explicitly repair newer fixture");
    fs::write(codex_path.join("SKILL.md"), "user changed\n").expect("change managed Skill bytes");
    fs::write(codex_path.join("unexpected.md"), "unexpected\n").expect("add unexpected Skill file");
    let modified = manager
        .status(SkillTargetSelection::Codex)
        .expect("classify modified managed copy");
    assert_eq!(modified.targets[0].state, SkillInstallState::UserModified);
    assert!(modified.targets[0]
        .conflicts
        .iter()
        .any(|conflict| conflict.kind == SkillConflictKind::Modified));
    assert!(modified.targets[0]
        .conflicts
        .iter()
        .any(|conflict| conflict.kind == SkillConflictKind::Unexpected));
    assert!(manager
        .install(mutation(SkillTargetSelection::Codex, &modified))
        .is_err());

    let repaired = manager
        .repair(mutation(SkillTargetSelection::Codex, &modified))
        .expect("explicitly repair modified fixture");
    write_marker(
        &codex_path,
        repaired.status.skill.release_revision,
        &"0".repeat(64),
    );
    let unknown = manager
        .status(SkillTargetSelection::Codex)
        .expect("classify forged marker");
    assert_eq!(unknown.targets[0].state, SkillInstallState::UnknownConflict);
    assert!(manager
        .install(mutation(SkillTargetSelection::Codex, &unknown))
        .is_err());

    manager
        .repair(mutation(SkillTargetSelection::Codex, &unknown))
        .expect("explicitly repair forged marker fixture");
    fs::write(codex_path.join(inventory::MARKER_FILE), b"not-json")
        .expect("corrupt managed marker");
    let invalid = manager
        .status(SkillTargetSelection::Codex)
        .expect("classify malformed marker");
    assert_eq!(invalid.targets[0].state, SkillInstallState::Invalid);
    assert!(manager
        .install(mutation(SkillTargetSelection::Codex, &invalid))
        .is_err());

    let current = manager
        .repair(mutation(SkillTargetSelection::Codex, &invalid))
        .expect("repair malformed marker fixture")
        .status;
    fs::write(codex_path.join("SKILL.md"), "changed after inventory\n")
        .expect("race exact inventory expectation");
    assert!(manager
        .install(mutation(SkillTargetSelection::Codex, &current))
        .is_err());
}
