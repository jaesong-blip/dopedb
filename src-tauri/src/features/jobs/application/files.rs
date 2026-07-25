use std::path::PathBuf;

use crate::error::{AppError, AppResult};
use crate::features::jobs::{JobFileCapability, JobFileDirection, JobFormat, JobInputInspection};
use crate::kernel::identity::{ConnectionId, JobArtifactId, JobFileCapabilityId};

use super::super::ports::{
    JobAuthorityGuard, JobAuthorityPort, JobCatalogPort, JobExecutionPort, JobFilePort,
    JobGeneratorPort, JobLedgerPort, JobOperationPort, JobPermission, NewCapability,
};
use super::JobUseCases;

impl<L, A, F, C, O, E, G> JobUseCases<L, A, F, C, O, E, G>
where
    L: JobLedgerPort,
    A: JobAuthorityPort,
    F: JobFilePort,
    C: JobCatalogPort,
    O: JobOperationPort,
    E: JobExecutionPort<O::Claim>,
    G: JobGeneratorPort,
{
    pub(crate) async fn register_input(
        &self,
        connection_id: ConnectionId,
        path: PathBuf,
    ) -> AppResult<JobFileCapability> {
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let canonical = self.files.snapshot_input(path).await?;
        let snapshot_path = canonical.path.clone();
        let result = self
            .ledger
            .create_capability(
                guard.authority(),
                NewCapability {
                    connection_id,
                    direction: JobFileDirection::Input,
                    path: canonical.path,
                    display_name: canonical.display_name,
                    size_bytes: Some(canonical.size_bytes),
                    modified_at: canonical.modified_at,
                    source_sha256: canonical.source_sha256,
                    expires_at: self.generator.capability_expires_at(),
                },
            )
            .await;
        if result.is_err() {
            let _ = self.files.remove_private_input(snapshot_path).await;
        }
        result
    }

    pub(crate) async fn register_output(
        &self,
        connection_id: ConnectionId,
        path: PathBuf,
    ) -> AppResult<JobFileCapability> {
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let canonical = self.files.prepare_output(path).await?;
        self.ledger
            .create_capability(
                guard.authority(),
                NewCapability {
                    connection_id,
                    direction: JobFileDirection::Output,
                    path: canonical.path,
                    display_name: canonical.display_name,
                    size_bytes: None,
                    modified_at: None,
                    source_sha256: None,
                    expires_at: self.generator.capability_expires_at(),
                },
            )
            .await
    }

    pub(crate) async fn inspect_input(
        &self,
        connection_id: ConnectionId,
        capability_id: JobFileCapabilityId,
        format: JobFormat,
    ) -> AppResult<JobInputInspection> {
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        let capability = self
            .ledger
            .resolve_capability(
                guard.authority(),
                capability_id,
                JobFileDirection::Input,
                None,
            )
            .await?;
        let path = capability.path;
        let engine = guard.authority().engine;
        let expected_hash = capability
            .source_sha256
            .ok_or_else(|| AppError::Config("input capability has no source hash".into()))?;
        self.files
            .inspect_input(path, format, engine, expected_hash)
            .await
    }

    pub(crate) async fn artifact_path(
        &self,
        connection_id: ConnectionId,
        artifact_id: JobArtifactId,
    ) -> AppResult<PathBuf> {
        let guard = self
            .authority
            .authorize(connection_id, JobPermission::Read)
            .await?;
        self.ledger
            .artifact_path(guard.authority(), artifact_id)
            .await
    }
}
