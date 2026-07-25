//! Concrete local adapters for Job application ports.

pub(super) mod authority;
pub(super) mod catalog;
pub(super) mod filesystem;
pub(super) mod format;
pub(super) mod generator;
pub(super) mod ledger;
mod operation;
pub(super) mod worker;
