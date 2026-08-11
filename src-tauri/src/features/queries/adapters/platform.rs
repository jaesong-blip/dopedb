//! Shared local platform dependencies for desktop and Terminal SQL adapters.

use crate::connection::ConnectionManager;
use crate::features::queries::ManualTransactionRuntime;
use crate::operations::OperationRuntime;
use crate::store::Store;

use super::desktop_stream_lifecycle::DesktopStreamCleanupRuntime;
use super::desktop_stream_registry::DesktopSqlStreamRegistry;

/// Concrete local adapter shared by all SQL Query use cases.
#[derive(Clone)]
pub(crate) struct QueryPlatformAdapter {
    pub(super) store: Store,
    pub(super) connections: ConnectionManager,
    pub(super) operation: OperationRuntime,
    pub(super) desktop_streams: DesktopSqlStreamRegistry,
    pub(super) desktop_stream_cleanup: DesktopStreamCleanupRuntime,
    pub(super) manual_transactions: ManualTransactionRuntime,
}

impl QueryPlatformAdapter {
    pub(crate) fn new(
        store: Store,
        connections: ConnectionManager,
        operation: OperationRuntime,
        desktop_streams: DesktopSqlStreamRegistry,
        desktop_stream_cleanup: DesktopStreamCleanupRuntime,
        manual_transactions: ManualTransactionRuntime,
    ) -> Self {
        Self {
            store,
            connections,
            operation,
            desktop_streams,
            desktop_stream_cleanup,
            manual_transactions,
        }
    }
}
