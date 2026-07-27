//! Operation row projection, canonical payload validation, and event hashing.

use super::*;

pub(super) struct PreparedOperation {
    pub(super) runtime_id: Uuid,
    pub(super) operation: NewOperation,
    pub(super) payload: CanonicalJson,
    pub(super) actor_provenance_json: String,
    pub(super) preview_json: String,
    pub(super) policy_snapshot_json: String,
}

impl PreparedOperation {
    pub(super) fn new(runtime_id: Uuid, operation: NewOperation) -> AppResult<Self> {
        validate_new_operation(&operation)?;
        let payload = CanonicalJson::from_value(&operation.payload)?;
        if payload.json().len() > MAX_REQUEST_BYTES {
            return Err(AppError::Config(
                "operation payload exceeds the local control-message limit".into(),
            ));
        }
        let actor_provenance_json =
            canonical_json(&serde_json::to_value(&operation.actor.provenance)?)?;
        let preview_json = canonical_json(&operation.preview)?;
        let policy_snapshot_json = canonical_json(&operation.policy_snapshot)?;
        let metadata_bytes = actor_provenance_json
            .len()
            .saturating_add(preview_json.len())
            .saturating_add(policy_snapshot_json.len());
        if metadata_bytes > MAX_RESPONSE_BYTES {
            return Err(AppError::Config(
                "operation metadata exceeds the local control-message limit".into(),
            ));
        }
        Ok(Self {
            runtime_id,
            operation,
            payload,
            actor_provenance_json,
            preview_json,
            policy_snapshot_json,
        })
    }

    pub(super) fn matches(&self, existing: &OperationRecord) -> bool {
        existing.runtime_id == self.runtime_id
            && existing.workspace_id == self.operation.workspace_id
            && existing.account_scope == self.operation.account_scope
            && existing.connection_id == self.operation.connection_id
            && existing.connection_revision == self.operation.connection_revision
            && existing.terminal_session_id == self.operation.terminal_session_id
            && existing.actor == self.operation.actor
            && existing.kind == self.operation.kind
            && existing.payload_schema_version == self.operation.payload_schema_version
            && existing.payload_hash == self.payload.sha256()
            && existing.schema_fingerprint == self.operation.schema_fingerprint
            && existing.risk_level == self.operation.risk_level
            && existing.preview == self.operation.preview
            && existing.policy_snapshot == self.operation.policy_snapshot
            && existing.policy_revision == self.operation.policy_revision
            && existing.single_use == self.operation.single_use
            && existing.idempotency_key == self.operation.idempotency_key
            && existing.expires_at == self.operation.expires_at
    }
}

pub(super) fn validate_new_operation(operation: &NewOperation) -> AppResult<()> {
    for (name, value) in [
        ("account scope", operation.account_scope.as_str()),
        ("actor id", operation.actor.id.as_str()),
        (
            "actor origin surface",
            operation.actor.provenance.origin_surface.as_str(),
        ),
        ("policy revision", operation.policy_revision.as_str()),
        ("idempotency key", operation.idempotency_key.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(AppError::Config(format!(
                "operation {name} cannot be empty"
            )));
        }
    }
    if operation.connection_revision < 1 {
        return Err(AppError::Config(
            "operation connection revision must be positive".into(),
        ));
    }
    if operation.payload_schema_version == 0 {
        return Err(AppError::Config(
            "operation payload schema version must be positive".into(),
        ));
    }
    if operation
        .schema_fingerprint
        .as_deref()
        .is_some_and(|value| {
            value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    {
        return Err(AppError::Config(
            "operation schema fingerprint must be lowercase SHA-256".into(),
        ));
    }
    Ok(())
}

pub(super) async fn fetch_operation_tx(
    tx: &mut Transaction<'_, Sqlite>,
    operation_id: Uuid,
) -> AppResult<OperationRecord> {
    let row = sqlx::query("SELECT * FROM operations WHERE id = ?1")
        .bind(operation_id.to_string())
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("operation {operation_id}")))?;
    row_to_operation(&row)
}

pub(super) fn row_to_operation(row: &sqlx::sqlite::SqliteRow) -> AppResult<OperationRecord> {
    let payload_json: String = row.try_get("payload_json")?;
    let payload_hash: String = row.try_get("payload_hash")?;
    let payload = CanonicalJson::from_stored(&payload_json, &payload_hash)?.into_value()?;
    let actor_provenance_json: String = row.try_get("actor_provenance_json")?;
    let actor_provenance_value = parse_canonical_json(&actor_provenance_json)?;
    let actor_provenance: OperationActorProvenance =
        serde_json::from_value(actor_provenance_value)?;
    let preview: Value = parse_canonical_json(row.try_get("preview_json")?)?;
    let policy_snapshot: Value = parse_canonical_json(row.try_get("policy_snapshot_json")?)?;

    Ok(OperationRecord {
        id: parse_uuid(row.try_get("id")?, "operation id")?,
        runtime_id: parse_uuid(row.try_get("runtime_id")?, "operation runtime id")?,
        workspace_id: parse_uuid(row.try_get("workspace_id")?, "operation workspace id")?,
        account_scope: row.try_get("account_scope")?,
        connection_id: parse_uuid(row.try_get("connection_id")?, "operation connection id")?,
        connection_revision: row.try_get("connection_revision")?,
        terminal_session_id: row
            .try_get::<Option<String>, _>("terminal_session_id")?
            .map(|value| parse_uuid(value, "operation terminal session id"))
            .transpose()?,
        actor: OperationActor {
            kind: parse_actor_kind(row.try_get::<String, _>("actor_kind")?.as_str())
                .ok_or_else(|| AppError::Config("invalid stored operation actor kind".into()))?,
            id: row.try_get("actor_id")?,
            provenance: actor_provenance,
        },
        kind: parse_operation_kind(row.try_get::<String, _>("operation_kind")?.as_str())
            .ok_or_else(|| AppError::Config("invalid stored operation kind".into()))?,
        payload_schema_version: u32::try_from(row.try_get::<i64, _>("payload_schema_version")?)
            .map_err(|_| AppError::Config("invalid operation payload schema version".into()))?,
        payload,
        payload_hash,
        schema_fingerprint: row.try_get("schema_fingerprint")?,
        risk_level: parse_risk_level(row.try_get::<String, _>("risk_level")?.as_str())
            .ok_or_else(|| AppError::Config("invalid stored operation risk level".into()))?,
        preview,
        policy_snapshot,
        policy_revision: row.try_get("policy_revision")?,
        state: parse_state(row.try_get::<String, _>("state")?.as_str())
            .ok_or_else(|| AppError::Config("invalid stored operation state".into()))?,
        single_use: parse_bool(row.try_get("single_use")?, "operation single_use")?,
        idempotency_key: row.try_get("idempotency_key")?,
        expires_at: parse_optional_timestamp(row.try_get("expires_at")?, "operation expiry")?,
        started_at: parse_optional_timestamp(row.try_get("started_at")?, "operation start")?,
        finished_at: parse_optional_timestamp(row.try_get("finished_at")?, "operation finish")?,
        created_at: parse_timestamp(row.try_get("created_at")?, "operation creation")?,
        updated_at: parse_timestamp(row.try_get("updated_at")?, "operation update")?,
    })
}

pub(super) fn row_to_approval(row: &sqlx::sqlite::SqliteRow) -> AppResult<OperationApprovalRecord> {
    Ok(OperationApprovalRecord {
        id: parse_uuid(row.try_get("id")?, "operation approval id")?,
        operation_id: parse_uuid(
            row.try_get("operation_id")?,
            "operation approval operation id",
        )?,
        payload_hash: row.try_get("payload_hash")?,
        approver: OperationApprover {
            kind: parse_actor_kind(row.try_get::<String, _>("approver_kind")?.as_str())
                .ok_or_else(|| AppError::Config("invalid stored operation approver kind".into()))?,
            id: row.try_get("approver_id")?,
        },
        decision: parse_approval_decision(row.try_get::<String, _>("decision")?.as_str())
            .ok_or_else(|| AppError::Config("invalid stored operation approval decision".into()))?,
        reason: row.try_get("reason")?,
        policy_revision: row.try_get("policy_revision")?,
        created_at: parse_timestamp(row.try_get("created_at")?, "operation approval creation")?,
        expires_at: parse_optional_timestamp(
            row.try_get("expires_at")?,
            "operation approval expiry",
        )?,
    })
}

pub(super) fn row_to_event(row: &sqlx::sqlite::SqliteRow) -> AppResult<OperationEventRecord> {
    let event_json: String = row.try_get("event_json")?;
    Ok(OperationEventRecord {
        id: parse_uuid(row.try_get("id")?, "operation event id")?,
        operation_id: parse_uuid(row.try_get("operation_id")?, "operation event operation id")?,
        sequence: row.try_get("sequence")?,
        kind: parse_event_kind(row.try_get::<String, _>("event_kind")?.as_str())
            .ok_or_else(|| AppError::Config("invalid stored operation event kind".into()))?,
        state: parse_state(row.try_get::<String, _>("state")?.as_str())
            .ok_or_else(|| AppError::Config("invalid stored operation event state".into()))?,
        details: parse_canonical_json(&event_json)?,
        created_at: parse_timestamp(row.try_get("created_at")?, "operation event creation")?,
        prev_hash: row.try_get("prev_hash")?,
        hash: row.try_get("hash")?,
    })
}

pub(super) fn parse_canonical_json(json: &str) -> AppResult<Value> {
    let value: Value = serde_json::from_str(json)?;
    if canonical_json(&value)? != json {
        return Err(AppError::Config(
            "stored operation JSON is not canonical".into(),
        ));
    }
    Ok(value)
}

pub(super) fn parse_uuid(value: String, field: &str) -> AppResult<Uuid> {
    Uuid::parse_str(&value)
        .map_err(|_| AppError::Config(format!("invalid {field} in local operation store")))
}

pub(super) fn parse_bool(value: i64, field: &str) -> AppResult<bool> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(AppError::Config(format!(
            "invalid {field} in local operation store"
        ))),
    }
}

pub(super) fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Nanos, true)
}

pub(super) fn parse_timestamp(value: String, field: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| AppError::Config(format!("invalid {field} timestamp")))
}

pub(super) fn parse_optional_timestamp(
    value: Option<String>,
    field: &str,
) -> AppResult<Option<DateTime<Utc>>> {
    value.map(|value| parse_timestamp(value, field)).transpose()
}

pub(super) fn ensure_runtime(operation: &OperationRecord, runtime_id: Uuid) -> AppResult<()> {
    if operation.runtime_id == runtime_id {
        Ok(())
    } else {
        Err(operation_conflict(
            "the operation belongs to a previous application runtime",
        ))
    }
}

pub(super) fn transition_event_kind(target: OperationState) -> OperationEventKind {
    match target {
        OperationState::Planned | OperationState::Ready => OperationEventKind::Planned,
        OperationState::PendingApproval => OperationEventKind::ApprovalRequested,
        OperationState::Approved => OperationEventKind::Approved,
        OperationState::Rejected => OperationEventKind::Rejected,
        OperationState::Expired => OperationEventKind::Expired,
        OperationState::Cancelled => OperationEventKind::Cancelled,
        OperationState::Executing => OperationEventKind::ExecutionStarted,
        OperationState::Succeeded => OperationEventKind::Succeeded,
        OperationState::Failed => OperationEventKind::Failed,
        OperationState::OutcomeUnknown => OperationEventKind::OutcomeUnknown,
    }
}

pub(super) struct EventHashInput<'a> {
    pub(super) event_id: Uuid,
    pub(super) operation_id: Uuid,
    pub(super) sequence: i64,
    pub(super) kind: OperationEventKind,
    pub(super) state: OperationState,
    pub(super) event_json: &'a str,
    pub(super) created_at: DateTime<Utc>,
    pub(super) prev_hash: Option<&'a str>,
}

pub(super) fn event_hash(input: EventHashInput<'_>) -> AppResult<String> {
    let canonical = canonical_json(&json!({
        "createdAt": timestamp(input.created_at),
        "eventId": input.event_id,
        "eventJson": input.event_json,
        "eventKind": event_kind_str(input.kind),
        "operationId": input.operation_id,
        "prevHash": input.prev_hash,
        "sequence": input.sequence,
        "state": state_str(input.state),
    }))?;
    Ok(lower_hex(&Sha256::digest(canonical.as_bytes())))
}

pub(super) fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

pub(super) fn operation_conflict(reason: &str) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
}
