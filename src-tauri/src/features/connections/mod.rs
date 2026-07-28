//! Saved connection feature composition.

mod adapters;
mod application;
mod domain;
mod ports;
pub(crate) mod transport;

use std::sync::Arc;

use crate::connection::ConnectionManager;
use crate::store::Store;

pub(crate) use adapters::system_connection_credentials;
use adapters::{
    RuntimeConnectionAuthority, SqliteConnectionRepository, SystemAdHocConnection,
    SystemDriverRegistry,
};
pub(crate) use application::{
    ConnectionProfileTestRequest, ConnectionUpsertRequest, ConnectionUseCases,
};
pub(crate) use domain::{
    AgentConnectionSummary, CliConnectionResolutionError, DriverCapability, DriverDescriptor,
    DriverInstallMode, DriverInstallState, MAX_CONNECTION_CREDENTIAL_BYTES,
};
pub(crate) use ports::ConnectionCredentialVault;

pub(crate) type ConnectionsFeature = ConnectionUseCases<
    SqliteConnectionRepository,
    RuntimeConnectionAuthority,
    SystemDriverRegistry,
    SystemAdHocConnection,
    dyn ConnectionCredentialVault,
>;

pub(crate) fn compose(
    store: Store,
    connections: ConnectionManager,
    credentials: Arc<dyn ConnectionCredentialVault>,
) -> ConnectionsFeature {
    ConnectionUseCases::new(
        SqliteConnectionRepository::new(store),
        RuntimeConnectionAuthority::new(connections),
        SystemDriverRegistry,
        SystemAdHocConnection,
        credentials,
    )
}
