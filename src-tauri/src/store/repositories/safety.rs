//! Per-connection safety policy persistence.

use super::super::*;

pub(in crate::store) async fn ensure_safety_row(
    tx: &mut Transaction<'_, Sqlite>,
    connection_id: Uuid,
) -> AppResult<()> {
    sqlx::query("INSERT OR IGNORE INTO connection_safety (connection_id) VALUES (?1)")
        .bind(connection_id.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(in crate::store) async fn sync_safety_allow_writes(
    tx: &mut Transaction<'_, Sqlite>,
    connection_id: Uuid,
    allow_writes: bool,
) -> AppResult<()> {
    ensure_safety_row(tx, connection_id).await?;
    sqlx::query("UPDATE connection_safety SET allow_writes = ?2 WHERE connection_id = ?1")
        .bind(connection_id.to_string())
        .bind(allow_writes)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

impl Store {
    // ── safety settings ────────────────────────────────────────────────────

    /// Returns stored safety settings, or the type default if none exist yet.
    pub async fn get_safety(&self, connection_id: Uuid) -> AppResult<SafetySettings> {
        self.get_connection(connection_id).await?;
        let row = sqlx::query(
            "SELECT require_approval, allow_writes, wrap_writes_in_tx, explain_preview,
                    auto_run_reads, max_rows, exec_preview_row_limit
             FROM connection_safety WHERE connection_id = ?1",
        )
        .bind(connection_id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        Ok(match row {
            None => SafetySettings::default(),
            Some(r) => SafetySettings {
                require_approval: r.try_get("require_approval")?,
                allow_writes: r.try_get("allow_writes")?,
                wrap_writes_in_tx: r.try_get("wrap_writes_in_tx")?,
                explain_preview: r.try_get("explain_preview")?,
                auto_run_reads: r.try_get("auto_run_reads")?,
                max_rows: r.try_get::<i64, _>("max_rows")? as u64,
                exec_preview_row_limit: r.try_get("exec_preview_row_limit")?,
            },
        })
    }

    pub async fn set_safety(&self, connection_id: Uuid, s: &SafetySettings) -> AppResult<()> {
        self.get_connection(connection_id).await?;
        sqlx::query(
            r#"INSERT INTO connection_safety
                (connection_id, require_approval, allow_writes, wrap_writes_in_tx,
                 explain_preview, auto_run_reads, max_rows, exec_preview_row_limit)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
               ON CONFLICT(connection_id) DO UPDATE SET
                 require_approval=?2, allow_writes=?3, wrap_writes_in_tx=?4,
                 explain_preview=?5, auto_run_reads=?6, max_rows=?7,
                 exec_preview_row_limit=?8"#,
        )
        .bind(connection_id.to_string())
        .bind(s.require_approval)
        .bind(s.allow_writes)
        .bind(s.wrap_writes_in_tx)
        .bind(s.explain_preview)
        .bind(s.auto_run_reads)
        .bind(s.max_rows as i64)
        .bind(s.exec_preview_row_limit)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
