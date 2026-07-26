//! Cross-feature limits for short-lived, Terminal-originated Agent capabilities.

use std::time::Duration;

/// Lifetime of one immutable Agent plan before it must be recreated.
pub(crate) const QUERY_PLAN_TTL: Duration = Duration::from_secs(30);

/// Hard result cap for Agent reads, independent of per-connection settings.
pub(crate) const MAX_AGENT_ROWS: u64 = 1_000;
