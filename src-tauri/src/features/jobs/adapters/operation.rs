//! Durable Operation runtime adapter for Job use cases.

use serde_json::Value;

use crate::error::AppResult;
use crate::kernel::identity::OperationId;
use crate::operations::{
    ClaimedOperation, NewOperation, OperationPlanDisposition, OperationRecord, OperationRuntime,
};

use super::super::ports::JobOperationPort;

impl JobOperationPort for OperationRuntime {
    type Claim = ClaimedOperation;

    async fn plan(
        &self,
        operation: NewOperation,
        disposition: OperationPlanDisposition,
    ) -> AppResult<OperationRecord> {
        OperationRuntime::plan(self, operation, disposition).await
    }

    async fn get(&self, operation_id: OperationId) -> AppResult<OperationRecord> {
        OperationRuntime::get(self, operation_id.into()).await
    }

    async fn claim(&self, operation_id: OperationId) -> AppResult<Self::Claim> {
        OperationRuntime::claim(self, operation_id.into()).await
    }

    async fn resume_job_claim(
        &self,
        operation_id: OperationId,
        expected_payload_hash: &str,
    ) -> AppResult<Self::Claim> {
        OperationRuntime::resume_job_claim(self, operation_id.into(), expected_payload_hash).await
    }

    async fn rebind_pending_job(
        &self,
        operation_id: OperationId,
        expected_payload_hash: &str,
    ) -> AppResult<OperationRecord> {
        OperationRuntime::rebind_pending_job(self, operation_id.into(), expected_payload_hash).await
    }

    async fn rebind_paused_job(
        &self,
        operation_id: OperationId,
        expected_payload_hash: &str,
    ) -> AppResult<OperationRecord> {
        OperationRuntime::rebind_paused_job(self, operation_id.into(), expected_payload_hash).await
    }

    async fn fail_interrupted_export(
        &self,
        operation_id: OperationId,
        expected_payload_hash: &str,
    ) -> AppResult<OperationRecord> {
        OperationRuntime::fail_interrupted_export(self, operation_id.into(), expected_payload_hash)
            .await
    }

    async fn succeed(
        &self,
        operation_id: OperationId,
        details: &Value,
    ) -> AppResult<OperationRecord> {
        OperationRuntime::succeed(self, operation_id.into(), details).await
    }

    async fn fail(&self, operation_id: OperationId, details: &Value) -> AppResult<OperationRecord> {
        OperationRuntime::fail(self, operation_id.into(), details).await
    }

    async fn confirm_cancelled(
        &self,
        operation_id: OperationId,
        details: &Value,
    ) -> AppResult<OperationRecord> {
        OperationRuntime::confirm_cancelled(self, operation_id.into(), details).await
    }

    async fn cancel_before_execution(
        &self,
        operation_id: OperationId,
        details: &Value,
    ) -> AppResult<OperationRecord> {
        OperationRuntime::cancel_before_execution(self, operation_id.into(), details).await
    }

    async fn mark_outcome_unknown(
        &self,
        operation_id: OperationId,
        details: &Value,
    ) -> AppResult<OperationRecord> {
        OperationRuntime::mark_outcome_unknown(self, operation_id.into(), details).await
    }
}
