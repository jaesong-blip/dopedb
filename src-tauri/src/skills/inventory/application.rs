//! Inventory application use case composed against the filesystem port.

use std::path::Path;

use dopedb_protocol::SkillTarget;

use super::super::bundle::SkillBundle;
use super::domain;
use super::ports::InventoryFilesystemPort;
use super::status::{self, Inventory};

pub(super) fn inventory<P: InventoryFilesystemPort>(
    filesystem: &P,
    home: &Path,
    bundle: &SkillBundle,
    target: SkillTarget,
) -> Inventory {
    let paths = filesystem.target_paths(home, target);
    let current_revision = bundle.current.release_revision;

    if let Err(error) = filesystem.validate_managed_path(home, &paths.target_path) {
        let exists = filesystem.target_exists(&paths.target_path);
        return status::path_validation_failure(paths, target, current_revision, error, exists);
    }

    let inspection = filesystem.inspect_target(&paths.target_path);
    if let Some(inventory) =
        status::target_inspection(paths.clone(), target, current_revision, inspection)
    {
        return inventory;
    }

    match filesystem.scan_directory(&paths.target_path) {
        Ok(entries) => status::from_domain_decision(
            paths,
            target,
            current_revision,
            domain::status_from_entries(bundle, entries),
        ),
        Err(error) => status::scan_failure(paths, target, current_revision, error),
    }
}
