//! Memory-only dashboard provenance for successful Terminal query runs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::kernel::identity::{ConnectionId, QueryRunId, TerminalSessionId};
use crate::kernel::sync::lock_unpoisoned;
use crate::kernel::TerminalAuthority;

use crate::features::queries::ports::{
    QueryRunAuthorizationError, QueryRunAuthorizationPort, QueryRunProvenancePort,
};

const RUN_CAPABILITY_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_RUN_CAPABILITIES: usize = 4_096;

#[derive(Debug, Clone, Copy)]
struct RunCapability {
    terminal_session_id: TerminalSessionId,
    connection_id: ConnectionId,
    expires_at: Instant,
}

/// One runtime-local writer for Terminal query-run dashboard capabilities.
#[derive(Debug, Clone, Default)]
pub(crate) struct TerminalQueryRunRegistry {
    runs: Arc<Mutex<HashMap<QueryRunId, RunCapability>>>,
}

impl QueryRunProvenancePort for TerminalQueryRunRegistry {
    fn register(
        &self,
        query_run_id: QueryRunId,
        terminal_session_id: TerminalSessionId,
        connection_id: ConnectionId,
    ) {
        self.register_at(
            query_run_id,
            terminal_session_id,
            connection_id,
            Instant::now(),
        );
    }
}

impl QueryRunAuthorizationPort for TerminalQueryRunRegistry {
    fn authorize(
        &self,
        query_run_id: QueryRunId,
        authority: &TerminalAuthority,
    ) -> Result<(), QueryRunAuthorizationError> {
        self.authorize_at(query_run_id, authority, Instant::now())
    }
}

impl TerminalQueryRunRegistry {
    fn register_at(
        &self,
        query_run_id: QueryRunId,
        terminal_session_id: TerminalSessionId,
        connection_id: ConnectionId,
        now: Instant,
    ) {
        let mut runs = lock_unpoisoned(&self.runs);
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

    fn authorize_at(
        &self,
        query_run_id: QueryRunId,
        authority: &TerminalAuthority,
        now: Instant,
    ) -> Result<(), QueryRunAuthorizationError> {
        let mut runs = lock_unpoisoned(&self.runs);
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

fn run_not_authorized() -> QueryRunAuthorizationError {
    QueryRunAuthorizationError::NotAuthorized
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::identity::{AccountScopeId, WorkspaceId};
    use uuid::Uuid;

    fn authority() -> TerminalAuthority {
        TerminalAuthority {
            terminal_session_id: TerminalSessionId::from(Uuid::new_v4()),
            workspace_id: WorkspaceId::from(Uuid::new_v4()),
            account_scope: AccountScopeId::new("personal").unwrap(),
            scope_generation: 1,
            connection_id: ConnectionId::from(Uuid::new_v4()),
            connection_revision: 1,
            client_protocol_version: 1,
        }
    }

    #[test]
    fn query_run_is_bound_to_one_terminal_and_connection() {
        let registry = TerminalQueryRunRegistry::default();
        let owner = authority();
        let run_id = QueryRunId::from(Uuid::new_v4());
        QueryRunProvenancePort::register(
            &registry,
            run_id,
            owner.terminal_session_id,
            owner.connection_id,
        );
        QueryRunAuthorizationPort::authorize(&registry, run_id, &owner).unwrap();
        let mut other_terminal = owner.clone();
        other_terminal.terminal_session_id = TerminalSessionId::from(Uuid::new_v4());
        assert!(QueryRunAuthorizationPort::authorize(&registry, run_id, &other_terminal).is_err());
        let mut other_connection = owner.clone();
        other_connection.connection_id = ConnectionId::from(Uuid::new_v4());
        assert!(
            QueryRunAuthorizationPort::authorize(&registry, run_id, &other_connection).is_err()
        );
    }

    #[test]
    fn expired_capability_is_removed_without_waiting_for_a_wall_clock() {
        let registry = TerminalQueryRunRegistry::default();
        let owner = authority();
        let run_id = QueryRunId::from(Uuid::new_v4());
        let now = Instant::now();
        registry.register_at(run_id, owner.terminal_session_id, owner.connection_id, now);

        assert!(registry
            .authorize_at(
                run_id,
                &owner,
                now + RUN_CAPABILITY_TTL - Duration::from_nanos(1)
            )
            .is_ok());
        assert!(registry
            .authorize_at(run_id, &owner, now + RUN_CAPABILITY_TTL)
            .is_err());
        assert!(!registry
            .runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&run_id));
    }

    #[test]
    fn capacity_evicts_the_oldest_capability_deterministically() {
        let registry = TerminalQueryRunRegistry::default();
        let owner = authority();
        let now = Instant::now();
        let first = QueryRunId::from(Uuid::new_v4());
        let mut newest = first;
        for offset in 0..MAX_RUN_CAPABILITIES {
            let run_id = if offset == 0 {
                first
            } else {
                QueryRunId::from(Uuid::new_v4())
            };
            registry.register_at(
                run_id,
                owner.terminal_session_id,
                owner.connection_id,
                now + Duration::from_secs(offset as u64),
            );
            newest = run_id;
        }
        let replacement = QueryRunId::from(Uuid::new_v4());
        let check_at = now + Duration::from_secs(MAX_RUN_CAPABILITIES as u64);
        registry.register_at(
            replacement,
            owner.terminal_session_id,
            owner.connection_id,
            check_at,
        );

        assert!(registry.authorize_at(first, &owner, check_at).is_err());
        assert!(registry.authorize_at(newest, &owner, check_at).is_ok());
        assert!(registry.authorize_at(replacement, &owner, check_at).is_ok());
    }
}
