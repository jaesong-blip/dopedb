//! Persistent SQL document feature composition.

mod adapters;
mod application;
mod domain;
mod ports;
pub(crate) mod transport;

use crate::connection::ConnectionManager;
use crate::store::Store;

use adapters::{
    ConnectionSqlDocumentAuthority, SqliteSqlDocumentRepository, SystemSqlDocumentGenerator,
};
pub(crate) use application::{
    CreateSqlDocumentRequest, SaveSqlDocumentOutcome, SaveSqlDocumentRequest, SqlDocumentUseCases,
};
pub(crate) use domain::{SqlDocument, SqlDocumentRevision};

pub(crate) type SqlDocumentsFeature = SqlDocumentUseCases<
    SqliteSqlDocumentRepository,
    ConnectionSqlDocumentAuthority,
    SystemSqlDocumentGenerator,
>;

pub(crate) fn compose(store: Store, connections: ConnectionManager) -> SqlDocumentsFeature {
    SqlDocumentUseCases::new(
        SqliteSqlDocumentRepository::new(store),
        ConnectionSqlDocumentAuthority::new(connections),
        SystemSqlDocumentGenerator,
    )
}
