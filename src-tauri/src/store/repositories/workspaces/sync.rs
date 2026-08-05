//! Account-scoped hosted pull checkpoints.

use super::super::super::*;
use crate::features::workspaces::WorkspacePullPage;

impl Store {
    pub(crate) async fn workspace_pull_cursor(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
    ) -> AppResult<Option<i64>> {
        sqlx::query_scalar(
            "SELECT state.pull_cursor
             FROM workspace_sync_state state
             JOIN workspace_members member
               ON member.workspace_id = state.workspace_id
              AND member.user_id = state.account_scope
              AND member.status = 'active'
             WHERE state.workspace_id = ?1 AND state.account_scope = ?2",
        )
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Into::into)
    }

    /// Commit a cursor only after every collection selected by that page has been
    /// reconciled. Exact previous-cursor matching rejects a late concurrent task;
    /// a different value outside normal forward replay is accepted only for the
    /// server's explicit restore or long-offline compaction reset page.
    pub(crate) async fn commit_workspace_pull_cursor(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        expected_cursor: Option<i64>,
        page: WorkspacePullPage,
    ) -> AppResult<()> {
        if page.next_cursor < 0
            || (!page.reset && expected_cursor.is_some_and(|cursor| page.next_cursor < cursor))
            || (page.reset && !expected_cursor.is_some_and(|cursor| page.next_cursor != cursor))
            || (page.has_more && !expected_cursor.is_some_and(|cursor| page.next_cursor > cursor))
            || ((expected_cursor.is_none() || page.reset)
                && (!page.refresh_connections || !page.refresh_dashboards || !page.refresh_reports))
            || (page.connection_tombstone && !page.refresh_connections)
            || (page.dashboard_tombstone && !page.refresh_dashboards)
            || (page.report_tombstone && !page.refresh_reports)
        {
            return Err(AppError::Network(
                "workspace sync cursor moved outside its ordered contract".into(),
            ));
        }
        let now = Utc::now();
        let changed = if let Some(expected_cursor) = expected_cursor {
            sqlx::query(
                "UPDATE workspace_sync_state
                 SET pull_cursor = ?1, last_pulled_at = ?2
                 WHERE workspace_id = ?3 AND account_scope = ?4
                   AND pull_cursor = ?5
                   AND EXISTS (
                     SELECT 1 FROM workspace_members member
                     WHERE member.workspace_id = ?3
                       AND member.user_id = ?4
                       AND member.status = 'active'
                   )",
            )
            .bind(page.next_cursor)
            .bind(now)
            .bind(workspace_id.to_string())
            .bind(account_user_id)
            .bind(expected_cursor)
            .execute(&self.pool)
            .await?
        } else {
            sqlx::query(
                "INSERT INTO workspace_sync_state
                    (workspace_id, account_scope, pull_cursor, last_pulled_at)
                 SELECT ?1, ?2, ?3, ?4
                 WHERE EXISTS (
                   SELECT 1 FROM workspace_members member
                   WHERE member.workspace_id = ?1
                     AND member.user_id = ?2
                     AND member.status = 'active'
                 )
                 ON CONFLICT(workspace_id, account_scope) DO NOTHING",
            )
            .bind(workspace_id.to_string())
            .bind(account_user_id)
            .bind(page.next_cursor)
            .bind(now)
            .execute(&self.pool)
            .await?
        };
        if changed.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "workspace sync scope or cursor changed concurrently".into(),
            });
        }
        Ok(())
    }
}
