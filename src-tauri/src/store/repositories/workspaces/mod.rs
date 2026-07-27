//! Workspace persistence grouped by account sync, selection, and scope invariants.

mod accounts;
mod scope;
mod selection;

pub(in crate::store) use scope::{
    account_scope_from_parts, bump_active_scope_generation, parse_scope_generation,
    repair_active_scope_on_open,
};
