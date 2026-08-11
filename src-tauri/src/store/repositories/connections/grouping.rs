//! Batch schema grouping and connection tombstone mutations.

use super::super::super::*;

impl Store {
    /// Update several connections as one transaction so a failed group operation
    /// cannot leave only part of the requested membership persisted.
    pub async fn set_connections_schema_group(
        &self,
        ids: &[Uuid],
        schema_group: Option<String>,
    ) -> AppResult<()> {
        for id in ids {
            self.get_connection(*id).await?;
        }
        let workspace_id = self.active_workspace_id().await?;
        let mut tx = self.pool.begin().await?;
        let updated_at = Utc::now();
        for id in ids {
            let result = sqlx::query(
                "UPDATE connections SET schema_group = ?2, updated_at = ?3,
                        revision = revision + 1, sync_status = 'local'
                 WHERE id = ?1 AND workspace_id = ?4 AND deleted_at IS NULL",
            )
            .bind(id.to_string())
            .bind(schema_group.as_deref())
            .bind(updated_at)
            .bind(workspace_id.to_string())
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != 1 {
                return Err(AppError::NotFound(format!("connection {id}")));
            }
        }
        tx.commit().await?;
        Ok(())
    }

    /// Tombstone a connection for future synchronization. Local history and audit rows
    /// remain available to their dedicated ledgers, while scoped resource reads stop
    /// resolving the connection immediately.
    pub async fn delete_connection(&self, id: Uuid) -> AppResult<()> {
        self.get_connection(id).await?;
        let workspace_id = self.active_workspace_id().await?;
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE connections SET deleted_at = ?2, updated_at = ?2,
                    revision = revision + 1, sync_status = 'local'
             WHERE id = ?1 AND workspace_id = ?3 AND deleted_at IS NULL",
        )
        .bind(id.to_string())
        .bind(Utc::now())
        .bind(workspace_id.to_string())
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            return Err(AppError::NotFound(format!("connection {id}")));
        }
        tx.commit().await?;
        Ok(())
    }
}
