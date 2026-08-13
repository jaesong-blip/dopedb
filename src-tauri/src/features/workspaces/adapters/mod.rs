//! Concrete workspace adapters.

pub(crate) mod control_plane;
mod local;

pub(crate) use control_plane::HostedWorkspaceControlPlane;
pub(crate) use local::{
    ConnectionWorkspaceRuntime, ProcessWorkspaceConfiguration, SqliteWorkspaceRepository,
    SystemWorkspaceSshProfile,
};
