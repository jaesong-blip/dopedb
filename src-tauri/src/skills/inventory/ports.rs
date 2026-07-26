//! Inventory filesystem port expressed only in domain values and path inputs.

use std::path::Path;

use dopedb_protocol::SkillTarget;

use super::domain::{ScanFailure, ScannedEntry, TargetInspection, TargetPaths};

pub(super) trait InventoryFilesystemPort {
    fn target_paths(&self, home: &Path, target: SkillTarget) -> TargetPaths;
    fn validate_managed_path(&self, home: &Path, target: &Path) -> Result<(), ScanFailure>;
    fn inspect_target(&self, target: &Path) -> TargetInspection;
    fn target_exists(&self, target: &Path) -> bool;
    fn scan_directory(&self, target: &Path) -> Result<Vec<ScannedEntry>, ScanFailure>;
}
