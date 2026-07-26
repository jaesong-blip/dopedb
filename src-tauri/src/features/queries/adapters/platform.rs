//! Shared local platform dependencies for desktop and Terminal SQL adapters.

use crate::connection::ConnectionManager;
use crate::operations::OperationRuntime;
use crate::store::Store;

use super::provenance::TerminalQueryRunRegistry;

/// Concrete local adapter shared by all SQL Query use cases.
#[derive(Clone)]
pub(crate) struct QueryPlatformAdapter {
    pub(super) store: Store,
    pub(super) connections: ConnectionManager,
    pub(super) operation: OperationRuntime,
    pub(super) terminal_runs: TerminalQueryRunRegistry,
}

impl QueryPlatformAdapter {
    pub(crate) fn new(
        store: Store,
        connections: ConnectionManager,
        operation: OperationRuntime,
        terminal_runs: TerminalQueryRunRegistry,
    ) -> Self {
        Self {
            store,
            connections,
            operation,
            terminal_runs,
        }
    }
}
