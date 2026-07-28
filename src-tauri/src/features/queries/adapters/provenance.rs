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
