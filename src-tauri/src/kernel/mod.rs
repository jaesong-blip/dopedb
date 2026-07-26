//! Small cross-feature domain primitives with no platform dependencies.

pub(crate) mod agent_policy;
pub(crate) mod identity;
mod terminal_authority;

pub(crate) use terminal_authority::TerminalAuthority;
