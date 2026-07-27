//! Runtime restart recovery and transactional transition primitive.

use super::*;

impl OperationRepository {
    /// Recover only operations owned by older runtimes. Mutations with an uncertain
    /// commit become `outcome_unknown`; resumable jobs remain untouched until their
    /// checkpoint is independently validated.
    pub(crate) async fn recover_previous_runtimes(
        &self,
        current_runtime_id: Uuid,
    ) -> AppResult<RestartRecoveryReport> {
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query(
            "SELECT * FROM operations
             WHERE runtime_id <> ?1
               AND state NOT IN (
                   'rejected', 'expired', 'cancelled', 'succeeded', 'failed',
                   'outcome_unknown'
               )
             ORDER BY created_at ASC, id ASC",
        )
        .bind(current_runtime_id.to_string())
        .fetch_all(&mut *tx)
        .await?;
        let mut report = RestartRecoveryReport::default();
        for row in rows {
            let operation = row_to_operation(&row)?;
            match restart_recovery(operation.kind, operation.state) {
                RestartRecovery::KeepTerminal => {}
                RestartRecovery::Expire => {
                    self.transition_tx(
                        &mut tx,
                        &operation,
                        OperationState::Expired,
                        &json!({"reason": "runtime_restarted"}),
                        Utc::now(),
                    )
                    .await?;
                    report.expired.push(operation.id);
                }
                RestartRecovery::MarkFailed => {
                    self.transition_tx(
                        &mut tx,
                        &operation,
                        OperationState::Failed,
                        &json!({"reason": "runtime_interrupted_before_receipt"}),
                        Utc::now(),
                    )
                    .await?;
                    report.failed.push(operation.id);
                }
                RestartRecovery::OutcomeUnknown => {
                    self.transition_tx(
                        &mut tx,
                        &operation,
                        OperationState::OutcomeUnknown,
                        &json!({"reason": "target_commit_status_unknown_after_restart"}),
                        Utc::now(),
                    )
                    .await?;
                    report.outcome_unknown.push(operation.id);
                }
                RestartRecovery::ValidateJobCheckpoint => {
                    report.checkpoint_validation_required.push(operation.id);
                }
            }
        }
        tx.commit().await?;
        Ok(report)
    }

    pub(super) async fn transition_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        current: &OperationRecord,
        target: OperationState,
        details: &Value,
        now: DateTime<Utc>,
    ) -> AppResult<OperationRecord> {
        ensure_transition(current.state, target)
            .map_err(|error| operation_conflict(&error.to_string()))?;
        let now_text = timestamp(now);
        let terminal = target.is_terminal();
        let result = sqlx::query(
            "UPDATE operations
             SET state = ?1,
                 updated_at = ?2,
                 started_at = CASE WHEN ?1 = 'executing' THEN ?2 ELSE started_at END,
                 finished_at = CASE WHEN ?3 THEN ?2 ELSE finished_at END
             WHERE id = ?4
               AND state = ?5
               AND payload_hash = ?6
               AND (?1 <> 'executing' OR expires_at IS NULL OR expires_at > ?2)",
        )
        .bind(state_str(target))
        .bind(&now_text)
        .bind(terminal)
        .bind(current.id.to_string())
        .bind(state_str(current.state))
        .bind(&current.payload_hash)
        .execute(&mut **tx)
        .await?;
        if result.rows_affected() != 1 {
            return Err(operation_conflict(
                "the operation state changed before it could be updated",
            ));
        }
        self.append_event_tx(
            tx,
            current.id,
            transition_event_kind(target),
            target,
            details,
            now,
        )
        .await?;
        fetch_operation_tx(tx, current.id).await
    }
}
