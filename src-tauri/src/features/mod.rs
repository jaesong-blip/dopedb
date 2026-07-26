//! Feature-owned application slices.
//!
//! Each feature keeps its domain rules and use cases independent from Tauri, SQLx,
//! and other platform adapters. This module is also the composition boundary that
//! wires concrete adapters into those use cases.

pub(crate) mod agents;
pub(crate) mod catalog;
pub(crate) mod connections;
pub(crate) mod dashboards;
pub(crate) mod erd;
pub(crate) mod jobs;
mod platform_flags;
pub(crate) mod queries;
pub(crate) mod schema_editor;
pub(crate) mod sql_documents;
pub(crate) mod terminals;
pub(crate) mod workspaces;

pub use platform_flags::{FeatureFlag, FeatureFlags};
