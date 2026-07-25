//! Metadata catalog vertical slice.

pub(crate) mod adapters;
mod application;
#[cfg(test)]
mod application_tests;
pub(crate) mod domain;
mod ports;
pub(crate) mod transport;

use crate::connection::ConnectionManager;
use crate::store::Store;

use adapters::ScopedCatalogGateway;
pub(crate) use application::CatalogUseCases;
pub(crate) use domain::{
    Catalog, CatalogReadPolicy, Column, DatabaseObject, ForeignKey, Index, Table,
};
pub(crate) use dopedb_protocol::catalog::CatalogSnapshot;

pub(crate) type CatalogFeature = CatalogUseCases<ScopedCatalogGateway>;

pub(crate) fn compose(store: Store, connections: ConnectionManager) -> CatalogFeature {
    CatalogUseCases::new(ScopedCatalogGateway::new(store, connections))
}
