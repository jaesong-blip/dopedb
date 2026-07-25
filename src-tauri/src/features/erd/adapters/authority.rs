//! Scope-pinned connection authority for ERD persistence.

use crate::connection::{ConnectionAccess, ConnectionContext, ConnectionManager};
use crate::error::{AppError, AppResult};
use crate::kernel::identity::{AccountScopeId, ConnectionId, WorkspaceConnectionId, WorkspaceId};

use super::super::ports::{ErdAuthority, ErdAuthorityGuard, ErdAuthorityPort};

#[derive(Clone)]
pub(in crate::features::erd) struct ConnectionErdAuthority {
    connections: ConnectionManager,
}

impl ConnectionErdAuthority {
    pub(in crate::features::erd) fn new(connections: ConnectionManager) -> Self {
        Self { connections }
    }
}

pub(in crate::features::erd) struct ConnectionErdGuard {
    authority: ErdAuthority,
    _context: ConnectionContext,
}

impl ErdAuthorityGuard for ConnectionErdGuard {
    fn authority(&self) -> &ErdAuthority {
        &self.authority
    }
}

impl ErdAuthorityPort for ConnectionErdAuthority {
    type Guard = ConnectionErdGuard;

    async fn authorize(&self, connection_id: ConnectionId) -> AppResult<Self::Guard> {
        let context = self
            .connections
            .pin(connection_id.into(), ConnectionAccess::Read)
            .await?;
        let pin = context.pin();
        let account_scope = AccountScopeId::new(pin.scope.account_scope.storage_key())
            .ok_or_else(|| AppError::Config("active ERD account scope is invalid".into()))?;
        Ok(ConnectionErdGuard {
            authority: ErdAuthority {
                resource: WorkspaceConnectionId {
                    workspace_id: WorkspaceId::from(pin.scope.workspace_id),
                    connection_id,
                },
                account_scope,
            },
            _context: context,
        })
    }
}
