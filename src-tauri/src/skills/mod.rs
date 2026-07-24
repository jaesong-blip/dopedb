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

    #[cfg(test)]
    pub fn for_home(home: PathBuf) -> AppResult<Self> {
        Self::from_home(home)
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
mod tests {
    use dopedb_protocol::SkillTargetSelection;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn status_is_offline_and_does_not_create_install_roots() {
        let home = TempDir::new().unwrap();
        let manager = SkillManager::for_home(home.path().to_path_buf()).unwrap();
        let status = manager.status(SkillTargetSelection::All).unwrap();
        assert_eq!(status.targets.len(), 2);
        assert!(!home.path().join(".agents").exists());
        assert!(!home.path().join(".claude").exists());
    }
}
