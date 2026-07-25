//! Durable import/export job feature.

mod adapters;
mod application;
pub(crate) mod domain;
mod state_machine;
pub(crate) mod transport;
mod validation;

pub(crate) use application::JobUseCases;
pub(crate) use domain::{
    CreateJobRequest, Job, JobArtifact, JobChangedEvent, JobDetail, JobErrorPolicy,
    JobFieldMapping, JobFileCapability, JobFileDirection, JobFormat, JobInputInspection, JobKind,
    JobPlan, JobProposal, JobState, JobValidation,
};
pub(crate) use state_machine::JobTransition;
pub(crate) use validation::{
    summaries, valid_sha256_fingerprint, validate_mapping_sources, validate_plan,
    validate_required_target_columns,
};
