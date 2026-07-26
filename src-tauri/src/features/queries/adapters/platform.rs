//! Shared local platform dependencies for desktop and Terminal SQL adapters.

use crate::connection::ConnectionManager;
use crate::operations::OperationRuntime;
use crate::store::Store;

use super::desktop_stream_lifecycle::DesktopStreamCleanupRuntime;
use super::desktop_stream_registry::DesktopSqlStreamRegistry;
use super::provenance::TerminalQueryRunRegistry;

/// Concrete local adapter shared by all SQL Query use cases.
#[derive(Clone)]
pub(crate) struct QueryPlatformAdapter {
    pub(super) store: Store,
    pub(super) connections: ConnectionManager,
    pub(super) operation: OperationRuntime,
    pub(super) terminal_runs: TerminalQueryRunRegistry,
    pub(super) desktop_streams: DesktopSqlStreamRegistry,
    pub(super) desktop_stream_cleanup: DesktopStreamCleanupRuntime,
}

impl QueryPlatformAdapter {
    pub(crate) fn new(
        store: Store,
        connections: ConnectionManager,
        operation: OperationRuntime,
        terminal_runs: TerminalQueryRunRegistry,
        desktop_streams: DesktopSqlStreamRegistry,
        desktop_stream_cleanup: DesktopStreamCleanupRuntime,
    ) -> Self {
        Self {
            store,
            connections,
            operation,
            terminal_runs,
            desktop_streams,
            desktop_stream_cleanup,
        }
    }
}
