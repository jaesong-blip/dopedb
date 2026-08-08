//! Feature-scoped SQLite repository implementations owned by the local store.

mod catalog;
mod connections;
mod dashboards;
mod funnel_dashboards;
mod history;
mod knowledge;
mod reports;
mod safety;
mod signals;
mod workspaces;

pub(super) use safety::{ensure_safety_row, sync_safety_allow_writes};
pub(crate) use signals::LocalSignalMetricSample;
pub(super) use workspaces::{
    account_scope_from_parts, bump_active_scope_generation, parse_scope_generation,
    repair_active_scope_on_open,
};
