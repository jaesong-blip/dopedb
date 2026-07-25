use chrono::Utc;

use crate::error::AppResult;

use super::super::super::ports::JobRecord;
use super::mapping::row_to_record;
use super::records::get_unscoped;
use super::JobRepository;

pub(super) async fn recover_interrupted(repository: &JobRepository) -> AppResult<Vec<JobRecord>> {
    let interrupted = sqlx::query(
        "SELECT * FROM jobs
         WHERE state IN ('running', 'cancel_requested')
         ORDER BY created_at ASC",
    )
    .fetch_all(repository.store.pool())
    .await?
    .iter()
    .map(row_to_record)
    .collect::<AppResult<Vec<_>>>()?;
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE jobs
         SET state = CASE WHEN kind = 'export' AND resumable = 1
                          THEN 'paused' ELSE 'failed' END,
             pause_requested = 0,
             error_code = CASE WHEN kind = 'export' AND resumable = 1
                               THEN 'runtime_restarted'
                               WHEN kind = 'import' THEN 'outcome_unknown'
                               ELSE 'not_resumable' END,
             redacted_error = CASE WHEN kind = 'export' AND resumable = 1
                 THEN 'The app restarted. Validate the checkpoint and resume.'
                 WHEN kind = 'import'
                 THEN 'The app restarted during import; the last commit may be ambiguous and is never retried automatically.'
                 ELSE 'The app restarted and this format cannot resume.' END,
             finished_at = CASE WHEN kind = 'export' AND resumable = 1
                                THEN NULL ELSE ?1 END,
             updated_at = ?1
         WHERE state IN ('running', 'cancel_requested')",
    )
    .bind(now)
    .execute(repository.store.pool())
    .await?;
    let mut recovered = Vec::with_capacity(interrupted.len());
    for record in interrupted {
        recovered.push(get_unscoped(repository, record.job.id).await?);
    }
    Ok(recovered)
}
