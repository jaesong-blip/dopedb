//! Compare-and-swap execution claims and lifecycle transitions.

use super::*;

impl OperationRepository {
    /// Move a non-execution lifecycle state. Entering `executing` is deliberately
    /// excluded; only `claim_execution` may perform that compare-and-swap.
    pub(crate) async fn transition(
        &self,
        operation_id: Uuid,
        runtime_id: Uuid,
        target: OperationState,
        details: &Value,
    ) -> AppResult<OperationRecord> {
        if target == OperationState::Executing {
            return Err(AppError::Config(
                "execution must be entered through the atomic claim API".into(),
            ));
        }
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        let current = fetch_operation_tx(&mut tx, operation_id).await?;
        ensure_runtime(&current, runtime_id)?;
        let updated = self
            .transition_tx(&mut tx, &current, target, details, Utc::now())
            .await?;
        tx.commit().await?;
        Ok(updated)
    }

    /// Atomically claim the exact payload previously shown to the caller. Only one
    /// contender can change `ready|approved` into `executing`.
    pub(crate) async fn claim_execution(
        &self,
        operation_id: Uuid,
        runtime_id: Uuid,
        now: DateTime<Utc>,
    ) -> AppResult<OperationRecord> {
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        let current = fetch_operation_tx(&mut tx, operation_id).await?;
        ensure_runtime(&current, runtime_id)?;
        if !matches!(
            current.state,
            OperationState::Ready | OperationState::Approved
        ) {
            return Err(operation_conflict(
                "the operation is not in an executable state",
            ));
        }
        if current.state == OperationState::Ready && current.kind.may_mutate_target() {
            return Err(operation_conflict(
                "a target-mutating operation cannot execute without exact approval",
            ));
        }
        if current
            .expires_at
            .is_some_and(|expires_at| expires_at <= now)
        {
            self.transition_tx(
                &mut tx,
                &current,
                OperationState::Expired,
                &json!({"reason": "operation_expired"}),
                now,
            )
            .await?;
            tx.commit().await?;
            return Err(operation_conflict("the operation has expired"));
        }
        if current.state == OperationState::Approved {
            let has_exact_approval: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM operation_approvals
                    WHERE operation_id = ?1
                      AND payload_hash = ?2
                      AND decision = 'approved'
                      AND policy_revision = ?3
                      AND (expires_at IS NULL OR expires_at > ?4)
                )",
            )
            .bind(current.id.to_string())
            .bind(&current.payload_hash)
            .bind(&current.policy_revision)
            .bind(timestamp(now))
            .fetch_one(&mut *tx)
            .await?;
            if !has_exact_approval {
                return Err(operation_conflict(
                    "the operation has no current exact approval",
                ));
            }
        }

        let updated = self
            .transition_tx(
                &mut tx,
                &current,
                OperationState::Executing,
                &json!({"payloadHash": &current.payload_hash}),
                now,
            )
            .await?;
        tx.commit().await?;
        Ok(updated)
    }

    /// Rebind an already-executing resumable job after its external checkpoint has
    /// been validated. Ordinary operations can never use this path, and the exact
    /// immutable payload hash must still match the job projection.
    pub(crate) async fn rebind_resumable_execution(
        &self,
        operation_id: Uuid,
        runtime_id: Uuid,
        expected_payload_hash: &str,
    ) -> AppResult<OperationRecord> {
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        let current = fetch_operation_tx(&mut tx, operation_id).await?;
        if current.state != OperationState::Executing || !current.kind.is_resumable_job() {
            return Err(operation_conflict(
                "only an executing resumable job can reclaim its operation",
            ));
        }
        if current.payload_hash != expected_payload_hash {
            return Err(operation_conflict(
                "the resumable job payload hash changed before reclaim",
            ));
        }
        let previous_runtime_id = current.runtime_id;
        let now = Utc::now();
        let update = sqlx::query(
            "UPDATE operations SET runtime_id = ?1, updated_at = ?2
             WHERE id = ?3 AND state = 'executing' AND payload_hash = ?4",
        )
        .bind(runtime_id.to_string())
        .bind(timestamp(now))
        .bind(operation_id.to_string())
        .bind(expected_payload_hash)
        .execute(&mut *tx)
        .await?;
        if update.rows_affected() != 1 {
            return Err(operation_conflict(
                "resumable job operation changed during reclaim",
            ));
        }
        self.append_event_tx(
            &mut tx,
            operation_id,
            OperationEventKind::Progress,
            OperationState::Executing,
            &json!({
                "checkpointValidated": true,
                "previousRuntimeId": previous_runtime_id,
                "runtimeId": runtime_id,
            }),
            now,
        )
        .await?;
        let rebound = fetch_operation_tx(&mut tx, operation_id).await?;
        tx.commit().await?;
        Ok(rebound)
    }

    /// Rebind a persisted import/export plan that never started. Its immutable
    /// payload hash and approval remain unchanged; only the process-local runtime
    /// owner changes so a queued job survives an app restart.
    pub(crate) async fn rebind_pending_job(
        &self,
        operation_id: Uuid,
        runtime_id: Uuid,
        expected_payload_hash: &str,
    ) -> AppResult<OperationRecord> {
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        let current = fetch_operation_tx(&mut tx, operation_id).await?;
        if !current.kind.is_resumable_job()
            || !matches!(
                current.state,
                OperationState::PendingApproval | OperationState::Ready | OperationState::Approved
            )
        {
            return Err(operation_conflict(
                "only a queued import/export plan can change runtime owner",
            ));
        }
        if current.payload_hash != expected_payload_hash {
            return Err(operation_conflict(
                "the queued job payload hash changed before reclaim",
            ));
        }
        let previous_runtime_id = current.runtime_id;
        let now = Utc::now();
        let update = sqlx::query(
            "UPDATE operations SET runtime_id = ?1, updated_at = ?2
             WHERE id = ?3 AND state = ?4 AND payload_hash = ?5",
        )
        .bind(runtime_id.to_string())
        .bind(timestamp(now))
        .bind(operation_id.to_string())
        .bind(state_str(current.state))
        .bind(expected_payload_hash)
        .execute(&mut *tx)
        .await?;
        if update.rows_affected() != 1 {
            return Err(operation_conflict(
                "queued job operation changed during reclaim",
            ));
        }
        self.append_event_tx(
            &mut tx,
            operation_id,
            OperationEventKind::Progress,
            current.state,
            &json!({
                "pendingJobRebound": true,
                "previousRuntimeId": previous_runtime_id,
                "runtimeId": runtime_id,
            }),
            now,
        )
        .await?;
        let rebound = fetch_operation_tx(&mut tx, operation_id).await?;
        tx.commit().await?;
        Ok(rebound)
    }

    /// Transfer only the process owner of a durably paused job. This does not
    /// issue an execution grant or claim that the external checkpoint is valid;
    /// the Job Engine must still call `rebind_resumable_execution` after verifying
    /// the current file and catalog fingerprints immediately before resume.
    pub(crate) async fn rebind_paused_job(
        &self,
        operation_id: Uuid,
        runtime_id: Uuid,
        expected_payload_hash: &str,
    ) -> AppResult<OperationRecord> {
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        let current = fetch_operation_tx(&mut tx, operation_id).await?;
        if current.state != OperationState::Executing || !current.kind.is_resumable_job() {
            return Err(operation_conflict(
                "only an executing paused job can change runtime owner",
            ));
        }
        if current.payload_hash != expected_payload_hash {
            return Err(operation_conflict(
                "the paused job payload hash changed before runtime transfer",
            ));
        }
        let previous_runtime_id = current.runtime_id;
        let now = Utc::now();
        let update = sqlx::query(
            "UPDATE operations SET runtime_id = ?1, updated_at = ?2
             WHERE id = ?3 AND state = 'executing' AND payload_hash = ?4",
        )
        .bind(runtime_id.to_string())
        .bind(timestamp(now))
        .bind(operation_id.to_string())
        .bind(expected_payload_hash)
        .execute(&mut *tx)
        .await?;
        if update.rows_affected() != 1 {
            return Err(operation_conflict(
                "paused job operation changed during runtime transfer",
            ));
        }
        self.append_event_tx(
            &mut tx,
            operation_id,
            OperationEventKind::Progress,
            OperationState::Executing,
            &json!({
                "checkpointValidation": "pending",
                "previousRuntimeId": previous_runtime_id,
                "runtimeId": runtime_id,
            }),
            now,
        )
        .await?;
        let rebound = fetch_operation_tx(&mut tx, operation_id).await?;
        tx.commit().await?;
        Ok(rebound)
    }
}
