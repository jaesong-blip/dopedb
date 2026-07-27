//! Planning insertion and immutable operation lookup.

use super::*;

impl OperationRepository {
    pub(crate) async fn insert_planned(
        &self,
        runtime_id: Uuid,
        operation: NewOperation,
    ) -> AppResult<OperationRecord> {
        let prepared = PreparedOperation::new(runtime_id, operation)?;
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;

        if let Some(row) = sqlx::query(
            "SELECT * FROM operations
             WHERE workspace_id = ?1
               AND actor_kind = ?2
               AND actor_id = ?3
               AND idempotency_key = ?4",
        )
        .bind(prepared.operation.workspace_id.to_string())
        .bind(actor_kind_str(prepared.operation.actor.kind))
        .bind(&prepared.operation.actor.id)
        .bind(&prepared.operation.idempotency_key)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing = row_to_operation(&row)?;
            if prepared.matches(&existing) {
                tx.commit().await?;
                return Ok(existing);
            }
            return Err(operation_conflict(
                "the idempotency key is already bound to a different immutable operation",
            ));
        }

        let created_at = Utc::now();
        let created_at_text = timestamp(created_at);
        sqlx::query(
            "INSERT INTO operations (
                id, runtime_id, workspace_id, account_scope, connection_id,
                connection_revision, terminal_session_id, actor_kind, actor_id,
                actor_provenance_json, operation_kind, payload_schema_version,
                payload_json, payload_hash, schema_fingerprint, risk_level,
                preview_json, policy_snapshot_json, policy_revision, state,
                single_use, idempotency_key, expires_at, started_at, finished_at,
                created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, 'planned', ?20, ?21, ?22,
                NULL, NULL, ?23, ?23
             )",
        )
        .bind(prepared.operation.id.to_string())
        .bind(prepared.runtime_id.to_string())
        .bind(prepared.operation.workspace_id.to_string())
        .bind(&prepared.operation.account_scope)
        .bind(prepared.operation.connection_id.to_string())
        .bind(prepared.operation.connection_revision)
        .bind(
            prepared
                .operation
                .terminal_session_id
                .map(|id| id.to_string()),
        )
        .bind(actor_kind_str(prepared.operation.actor.kind))
        .bind(&prepared.operation.actor.id)
        .bind(&prepared.actor_provenance_json)
        .bind(operation_kind_str(prepared.operation.kind))
        .bind(i64::from(prepared.operation.payload_schema_version))
        .bind(prepared.payload.json())
        .bind(prepared.payload.sha256())
        .bind(&prepared.operation.schema_fingerprint)
        .bind(risk_level_str(prepared.operation.risk_level))
        .bind(&prepared.preview_json)
        .bind(&prepared.policy_snapshot_json)
        .bind(&prepared.operation.policy_revision)
        .bind(prepared.operation.single_use)
        .bind(&prepared.operation.idempotency_key)
        .bind(prepared.operation.expires_at.map(timestamp))
        .bind(&created_at_text)
        .execute(&mut *tx)
        .await?;

        self.append_event_tx(
            &mut tx,
            prepared.operation.id,
            OperationEventKind::Planned,
            OperationState::Planned,
            &json!({
                "payloadHash": prepared.payload.sha256(),
                "riskLevel": risk_level_str(prepared.operation.risk_level),
            }),
            created_at,
        )
        .await?;
        let record = fetch_operation_tx(&mut tx, prepared.operation.id).await?;
        tx.commit().await?;
        Ok(record)
    }

    pub(crate) async fn find(&self, operation_id: Uuid) -> AppResult<Option<OperationRecord>> {
        let row = sqlx::query("SELECT * FROM operations WHERE id = ?1")
            .bind(operation_id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(row_to_operation).transpose()
    }

    pub(crate) async fn get(&self, operation_id: Uuid) -> AppResult<OperationRecord> {
        self.find(operation_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("operation {operation_id}")))
    }
}
