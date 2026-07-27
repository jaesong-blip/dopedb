//! Bounded Skill inventory split into status policy and filesystem inspection.

mod application;
mod domain;
mod filesystem;
mod ports;
mod status;

#[cfg(test)]
mod application_tests;
#[cfg(test)]
mod filesystem_tests;
#[cfg(test)]
mod status_tests;

pub(super) use domain::MARKER_FILE;
pub(super) use filesystem::{is_link_or_reparse, prepare_root};
pub(super) use status::Inventory;

pub(super) fn inventory(
    home: &std::path::Path,
    bundle: &super::bundle::SkillBundle,
    target: dopedb_protocol::SkillTarget,
) -> Inventory {
    application::inventory(&filesystem::Filesystem, home, bundle, target)
}
