//! Memory-only provenance handles for Terminal-owned successful query runs.
//!
//! Query history remains durable for the desktop UI, but an Agent dashboard
//! command may use a run only from the exact live Terminal session that produced
//! it. Restarting the app intentionally invalidates these capabilities.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::TerminalAuthority;

const RUN_CAPABILITY_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_RUN_CAPABILITIES: usize = 4_096;

#[derive(Debug, Clone, Copy)]
struct RunCapability {
    terminal_session_id: Uuid,
    connection_id: Uuid,
    expires_at: Instant,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct TerminalQueryRunRegistry {
    runs: Arc<Mutex<HashMap<Uuid, RunCapability>>>,
}

impl TerminalQueryRunRegistry {
    pub(crate) fn register(
        &self,
        query_run_id: Uuid,
        terminal_session_id: Uuid,
        connection_id: Uuid,
    ) {
        let mut runs = self
            .runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        runs.retain(|_, capability| capability.expires_at > now);
        if runs.len() >= MAX_RUN_CAPABILITIES {
            if let Some(oldest) = runs
                .iter()
                .min_by_key(|(_, capability)| capability.expires_at)
                .map(|(id, _)| *id)
            {
                runs.remove(&oldest);
            }
        }
        runs.insert(
            query_run_id,
            RunCapability {
                terminal_session_id,
                connection_id,
                expires_at: now + RUN_CAPABILITY_TTL,
            },
        );
    }

    pub(crate) fn authorize(
        &self,
        query_run_id: Uuid,
        authority: &TerminalAuthority,
    ) -> AppResult<()> {
        let mut runs = self
            .runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        let Some(capability) = runs.get(&query_run_id).copied() else {
            return Err(run_not_authorized());
        };
        if capability.expires_at <= now {
            runs.remove(&query_run_id);
            return Err(run_not_authorized());
        }
        if capability.terminal_session_id != authority.terminal_session_id
            || capability.connection_id != authority.connection_id
        {
            return Err(run_not_authorized());
        }
        Ok(())
    }
}

fn run_not_authorized() -> AppError {
    AppError::Blocked {
        reason: "query run does not belong to this live Terminal session".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority() -> TerminalAuthority {
        TerminalAuthority {
            terminal_session_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            account_scope: "personal".into(),
            scope_generation: 1,
            connection_id: Uuid::new_v4(),
            connection_revision: 1,
            client_protocol_version: 1,
        }
    }

    #[test]
    fn query_run_is_bound_to_one_terminal_and_connection() {
        let registry = TerminalQueryRunRegistry::default();
        let owner = authority();
        let run_id = Uuid::new_v4();
        registry.register(run_id, owner.terminal_session_id, owner.connection_id);
        registry.authorize(run_id, &owner).unwrap();

        let mut other_terminal = owner.clone();
        other_terminal.terminal_session_id = Uuid::new_v4();
        assert!(registry.authorize(run_id, &other_terminal).is_err());

        let mut other_connection = owner;
        other_connection.connection_id = Uuid::new_v4();
        assert!(registry.authorize(run_id, &other_connection).is_err());
    }
}
