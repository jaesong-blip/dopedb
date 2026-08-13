//! Project Knowledge composition boundary.

pub(crate) mod adapters;
pub(crate) mod application;
pub(crate) mod domain;
pub(crate) mod extractor;
mod facade;
pub(crate) mod ports;
pub(crate) mod runtime;
pub(crate) mod transport;

pub(crate) type KnowledgeFeature = facade::KnowledgeFeature<
    adapters::SqliteKnowledgeRepository,
    adapters::HostedKnowledgeAuthority,
>;

pub(crate) fn compose(
    repository: adapters::SqliteKnowledgeRepository,
    authority: adapters::HostedKnowledgeAuthority,
) -> KnowledgeFeature {
    facade::KnowledgeFeature::new(repository, authority)
}
