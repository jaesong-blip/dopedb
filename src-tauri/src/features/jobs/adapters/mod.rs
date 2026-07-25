//! Concrete Job Engine adapters.
//!
//! Application code may depend on these only at the composition boundary until the
//! remaining port extraction checkpoint is complete.

pub(super) mod format;
pub(super) mod ledger;
pub(super) mod worker;
