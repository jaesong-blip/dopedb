//! Append-only operation event ledger and hash-chain verification.

use super::*;

impl OperationRepository {
    /// Record bounded progress without changing the current projection state.
    pub(crate) async fn append_progress(
        &self,
        operation_id: Uuid,
        runtime_id: Uuid,
        details: &Value,
    ) -> AppResult<OperationEventRecord> {
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        let current = fetch_operation_tx(&mut tx, operation_id).await?;
        ensure_runtime(&current, runtime_id)?;
        if current.state != OperationState::Executing {
            return Err(operation_conflict(
                "progress can only be recorded for an executing operation",
            ));
        }
        let event = self
            .append_event_tx(
                &mut tx,
                operation_id,
                OperationEventKind::Progress,
                current.state,
                details,
                Utc::now(),
            )
            .await?;
        tx.commit().await?;
        Ok(event)
    }

    pub(crate) async fn events(&self, operation_id: Uuid) -> AppResult<Vec<OperationEventRecord>> {
        let rows = sqlx::query(
            "SELECT * FROM operation_events
             WHERE operation_id = ?1
             ORDER BY sequence ASC",
        )
        .bind(operation_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_event).collect()
    }

    /// Verify sequence continuity, every hash link, canonical event JSON, and the
    /// agreement between the ledger tail and the current projection.
    pub(crate) async fn verify_event_chain(&self, operation_id: Uuid) -> AppResult<bool> {
        let _guard = self.write_lock.lock().await;
        let projection = self.get(operation_id).await?;
        let events = self.events(operation_id).await?;
        if events.is_empty() {
            return Ok(false);
        }
        let mut previous_hash: Option<&str> = None;
        for (index, event) in events.iter().enumerate() {
            if event.sequence != (index as i64) + 1
                || event.prev_hash.as_deref() != previous_hash
                || (index == 0
                    && (event.kind != OperationEventKind::Planned
                        || event.state != OperationState::Planned))
            {
                return Ok(false);
            }
            let event_json = canonical_json(&event.details)?;
            let expected = event_hash(EventHashInput {
                event_id: event.id,
                operation_id: event.operation_id,
                sequence: event.sequence,
                kind: event.kind,
                state: event.state,
                event_json: &event_json,
                created_at: event.created_at,
                prev_hash: event.prev_hash.as_deref(),
            })?;
            if expected != event.hash {
                return Ok(false);
            }
            previous_hash = Some(&event.hash);
        }
        Ok(events
            .last()
            .is_some_and(|event| event.state == projection.state))
    }

    pub(super) async fn append_event_tx(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        operation_id: Uuid,
        kind: OperationEventKind,
        state: OperationState,
        details: &Value,
        created_at: DateTime<Utc>,
    ) -> AppResult<OperationEventRecord> {
        let details_json = canonical_json(details)?;
        if details_json.len() > MAX_RESPONSE_BYTES {
            return Err(AppError::Config(
                "operation event details exceed the local control-message limit".into(),
            ));
        }
        let tail = sqlx::query(
            "SELECT sequence, hash FROM operation_events
             WHERE operation_id = ?1
             ORDER BY sequence DESC
             LIMIT 1",
        )
        .bind(operation_id.to_string())
        .fetch_optional(&mut **tx)
        .await?;
        let (sequence, prev_hash) = match tail {
            Some(row) => {
                let sequence: i64 = row.try_get("sequence")?;
                let next = sequence.checked_add(1).ok_or_else(|| {
                    AppError::Config("operation event sequence overflowed".into())
                })?;
                (next, Some(row.try_get::<String, _>("hash")?))
            }
            None => (1, None),
        };
        let event_id = Uuid::new_v4();
        let hash = event_hash(EventHashInput {
            event_id,
            operation_id,
            sequence,
            kind,
            state,
            event_json: &details_json,
            created_at,
            prev_hash: prev_hash.as_deref(),
        })?;
        let created_at_text = timestamp(created_at);
        sqlx::query(
            "INSERT INTO operation_events (
                id, operation_id, sequence, event_kind, state, event_json,
                created_at, prev_hash, hash
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .bind(event_id.to_string())
        .bind(operation_id.to_string())
        .bind(sequence)
        .bind(event_kind_str(kind))
        .bind(state_str(state))
        .bind(&details_json)
        .bind(&created_at_text)
        .bind(&prev_hash)
        .bind(&hash)
        .execute(&mut **tx)
        .await?;
        Ok(OperationEventRecord {
            id: event_id,
            operation_id,
            sequence,
            kind,
            state,
            details: serde_json::from_str(&details_json)?,
            created_at,
            prev_hash,
            hash,
        })
    }
}
