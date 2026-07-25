//! SQLite projection and append-only ledger adapter for durable import/export jobs.

mod capabilities;
mod events;
mod mapping;
mod records;
mod recovery;
mod transitions;

#[cfg(test)]
mod ledger_tests;

use std::path::{Path, PathBuf};

use crate::error::AppResult;
use crate::features::jobs::{Job, JobArtifact, JobFileCapability, JobFileDirection, JobState};
use crate::kernel::identity::{JobArtifactId, JobFileCapabilityId, JobId};
use crate::store::Store;

use super::super::ports::{
    Checkpoint, JobAuthority, JobLedgerPort, JobRecord, NewCapability, NewJob, ResolvedCapability,
};

#[derive(Clone)]
pub(in crate::features::jobs) struct JobRepository {
    pub(super) store: Store,
}

impl JobRepository {
    pub(in crate::features::jobs) fn new(store: Store) -> Self {
        Self { store }
    }
}

impl JobLedgerPort for JobRepository {
    async fn create_capability(
        &self,
        authority: &JobAuthority,
        capability: NewCapability,
    ) -> AppResult<JobFileCapability> {
        capabilities::create_capability(self, authority, capability).await
    }

    async fn resolve_capability(
        &self,
        authority: &JobAuthority,
        capability_id: JobFileCapabilityId,
        direction: JobFileDirection,
        job_id: Option<JobId>,
    ) -> AppResult<ResolvedCapability> {
        capabilities::resolve_capability(self, authority, capability_id, direction, job_id).await
    }

    async fn retire_input_capability(&self, job_id: JobId) -> AppResult<Option<PathBuf>> {
        capabilities::retire_input_capability(self, job_id).await
    }

    async fn retire_expired_input_capabilities(&self) -> AppResult<Vec<PathBuf>> {
        capabilities::retire_expired_input_capabilities(self).await
    }

    async fn active_input_capability_paths(&self) -> AppResult<Vec<PathBuf>> {
        capabilities::active_input_capability_paths(self).await
    }

    async fn insert_job(&self, authority: &JobAuthority, new: NewJob) -> AppResult<JobRecord> {
        records::insert_job(self, authority, new).await
    }

    async fn list(&self, authority: &JobAuthority) -> AppResult<Vec<Job>> {
        records::list(self, authority).await
    }

    async fn detail(
        &self,
        authority: &JobAuthority,
        job_id: JobId,
    ) -> AppResult<(Job, Vec<JobArtifact>)> {
        records::detail(self, authority, job_id).await
    }

    async fn get_scoped(&self, authority: &JobAuthority, job_id: JobId) -> AppResult<JobRecord> {
        records::get_scoped(self, authority, job_id).await
    }

    async fn get_unscoped(&self, job_id: JobId) -> AppResult<JobRecord> {
        records::get_unscoped(self, job_id).await
    }

    async fn queued_records(&self) -> AppResult<Vec<JobRecord>> {
        records::queued_records(self).await
    }

    async fn paused_records(&self) -> AppResult<Vec<JobRecord>> {
        records::paused_records(self).await
    }

    async fn claim_running(&self, authority: &JobAuthority, job_id: JobId) -> AppResult<JobRecord> {
        transitions::claim_running(self, authority, job_id).await
    }

    async fn update_progress(
        &self,
        job_id: JobId,
        rows_processed: u64,
        bytes_processed: u64,
        checkpoint: Option<Checkpoint>,
    ) -> AppResult<JobRecord> {
        transitions::update_progress(self, job_id, rows_processed, bytes_processed, checkpoint)
            .await
    }

    async fn update_totals(
        &self,
        job_id: JobId,
        rows_total: Option<u64>,
        bytes_total: Option<u64>,
    ) -> AppResult<JobRecord> {
        transitions::update_totals(self, job_id, rows_total, bytes_total).await
    }

    async fn latest_checkpoint(&self, job_id: JobId) -> AppResult<Option<Checkpoint>> {
        transitions::latest_checkpoint(self, job_id).await
    }

    async fn request_pause(&self, job_id: JobId) -> AppResult<JobRecord> {
        transitions::request_pause(self, job_id).await
    }

    async fn finish_pause(&self, job_id: JobId) -> AppResult<JobRecord> {
        transitions::finish_pause(self, job_id).await
    }

    async fn rollback_initial_start(&self, job_id: JobId) -> AppResult<JobRecord> {
        transitions::rollback_initial_start(self, job_id).await
    }

    async fn request_cancel(&self, job_id: JobId) -> AppResult<JobRecord> {
        transitions::request_cancel(self, job_id).await
    }

    async fn finish(
        &self,
        job_id: JobId,
        state: JobState,
        error_code: Option<&str>,
        redacted_error: Option<&str>,
    ) -> AppResult<JobRecord> {
        transitions::finish(self, job_id, state, error_code, redacted_error).await
    }

    async fn finish_queued(
        &self,
        job_id: JobId,
        state: JobState,
        error_code: &str,
        redacted_error: &str,
    ) -> AppResult<JobRecord> {
        transitions::finish_queued(self, job_id, state, error_code, redacted_error).await
    }

    async fn fail_paused(
        &self,
        job_id: JobId,
        error_code: &str,
        redacted_error: &str,
    ) -> AppResult<JobRecord> {
        transitions::fail_paused(self, job_id, error_code, redacted_error).await
    }

    async fn record_artifact(
        &self,
        job_id: JobId,
        artifact_type: &str,
        path: &Path,
        size_bytes: u64,
        sha256: &str,
    ) -> AppResult<()> {
        capabilities::record_artifact(self, job_id, artifact_type, path, size_bytes, sha256).await
    }

    async fn artifact_path(
        &self,
        authority: &JobAuthority,
        artifact_id: JobArtifactId,
    ) -> AppResult<PathBuf> {
        capabilities::artifact_path(self, authority, artifact_id).await
    }

    async fn recover_interrupted(&self) -> AppResult<Vec<JobRecord>> {
        recovery::recover_interrupted(self).await
    }
}
