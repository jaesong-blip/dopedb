use chrono::Utc;
use serde_json::Value;
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::error::AppResult;
use crate::kernel::identity::JobId;

pub(super) async fn append_event(
    transaction: &mut Transaction<'_, Sqlite>,
    job_id: JobId,
    event_kind: &str,
    value: &Value,
) -> AppResult<()> {
    let sequence: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM job_events WHERE job_id = ?1",
    )
    .bind(job_id.to_string())
    .fetch_one(&mut **transaction)
    .await?;
    sqlx::query(
        "INSERT INTO job_events
            (id, job_id, sequence, event_kind, event_json, created_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(job_id.to_string())
    .bind(sequence)
    .bind(event_kind)
    .bind(serde_json::to_string(value)?)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}
