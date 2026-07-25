//! Immutable authority captured by one in-app Terminal session.
//!
//! The capability belongs to the kernel rather than a feature service because query,
//! document, dashboard, operation, and connection slices all validate the same pin.

use uuid::Uuid;

use crate::kernel::identity::{AccountScopeId, ConnectionId, WorkspaceId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalAuthority {
    pub(crate) terminal_session_id: Uuid,
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) account_scope: AccountScopeId,
    pub(crate) scope_generation: i64,
    pub(crate) connection_id: ConnectionId,
    pub(crate) connection_revision: i64,
    pub(crate) client_protocol_version: u16,
}
