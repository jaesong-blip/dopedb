//! Account-aware workspace feature.

pub(crate) mod adapters;
mod application;
pub(crate) mod domain;
mod ports;
pub(crate) mod transport;

use std::sync::Arc;

use crate::connection::ConnectionManager;
use crate::features::connections::ConnectionCredentialVault;
use crate::store::Store;

use adapters::{
    ConnectionWorkspaceRuntime, HostedWorkspaceControlPlane, ProcessWorkspaceConfiguration,
    SqliteWorkspaceRepository,
};
pub(crate) use application::{
    WorkspaceConnectionCopyRequest, WorkspaceConnectionUpdateRequest,
    WorkspaceCredentialBindingRequest, WorkspaceUseCases,
};
pub(crate) use domain::{
    DashboardOutboxOperation, DashboardPushResult, PendingDashboardMutation, RemoteDashboard,
    RemoteWorkspace, Workspace, WorkspaceAccountMembership, WorkspaceAuthAccount,
    WorkspaceAuthState, WorkspaceAuthUser, WorkspaceAuthorityFingerprint, WorkspaceDashboardState,
    WorkspaceDeviceAuthorization, WorkspaceFeatureState, WorkspaceKind, WorkspaceLifecycleState,
    WorkspaceLoginPoll, WorkspaceLoginPollStatus, WorkspacePullPage, WorkspaceRole,
};

pub(crate) type WorkspacesFeature = WorkspaceUseCases<
    SqliteWorkspaceRepository,
    ConnectionWorkspaceRuntime,
    HostedWorkspaceControlPlane,
    dyn ConnectionCredentialVault,
    ProcessWorkspaceConfiguration,
>;

pub(crate) fn compose(
    store: Store,
    connections: ConnectionManager,
    credentials: Arc<dyn ConnectionCredentialVault>,
) -> WorkspacesFeature {
    WorkspaceUseCases::new(
        SqliteWorkspaceRepository::new(store),
        ConnectionWorkspaceRuntime::new(connections),
        HostedWorkspaceControlPlane,
        credentials,
        ProcessWorkspaceConfiguration,
    )
}
