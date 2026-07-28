//! Scope-pinned query history persistence and dashboard provenance reads.

use super::super::*;

impl Store {
    // ── query history ──────────────────────────────────────────────────────

    /// Persist an execution artifact only if the connection still has the exact
    /// workspace/account/material identity that authorized the operation. This is
    /// intentionally one `INSERT .. SELECT` statement: checking a pin and inserting
    /// separately would let a scope switch place an old operation in the new account.
    pub(crate) async fn insert_history_if_current(
        &self,
        pin: &PinnedConnection,
        h: &HistoryEntry,
    ) -> AppResult<()> {
        if h.connection_id != pin.connection_id {
            return Err(AppError::Config(
                "query history does not match its connection pin".into(),
            ));
        }
        let result = sqlx::query(
            r#"INSERT INTO query_history
                (id, connection_id, account_scope, sql, kind, status, row_count,
                 duration_ms, error, executed_at, origin)
               SELECT ?10, ?5, ?9, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
               WHERE EXISTS(
                   SELECT 1
                   FROM app_settings workspace
                   JOIN workspaces w
                     ON workspace.key = 'active_workspace_id'
                    AND workspace.value = w.id
                    AND w.lifecycle_state = 'active'
                   LEFT JOIN app_settings account
                     ON account.key = 'active_workspace_account_id'
                   JOIN app_settings generation
                     ON generation.key = 'active_scope_generation'
                   JOIN connections c
                     ON c.id = ?5
                    AND c.workspace_id = w.id
                    AND c.deleted_at IS NULL
                   LEFT JOIN workspace_connection_bindings b
                     ON b.connection_id = c.id
                    AND b.account_user_id = account.value
                   WHERE w.id = ?1
                     AND w.kind = ?2
                     AND account.value IS ?3
                     AND generation.value = ?4
                     AND c.revision = ?6
                     AND CASE WHEN c.remote_id IS NOT NULL
                              THEN COALESCE(b.revision, 0) ELSE 0 END = ?7
                     AND CASE WHEN c.remote_id IS NOT NULL
                              THEN COALESCE(b.updated_at, '') ELSE '' END = ?8
                     AND CASE WHEN w.kind = 'personal'
                              THEN 'personal' ELSE account.value END = ?9
                     AND (w.kind = 'personal'
                          OR EXISTS(
                              SELECT 1 FROM workspace_members m
                              WHERE m.workspace_id = w.id
                                AND m.user_id = account.value
                                AND m.status = 'active'
                          ))
                     AND (w.kind = 'personal'
                          OR c.remote_id IS NOT NULL
                          OR c.account_user_id = account.value)
                     AND (c.remote_id IS NULL
                          OR COALESCE(b.workspace_access, 'view')
                             IN ('read', 'write', 'manage'))
               )"#,
        )
        .bind(pin.scope.workspace_id.to_string())
        .bind(workspace_kind_str(pin.scope.workspace_kind))
        .bind(pin.scope.selected_account_id.as_deref())
        .bind(pin.scope.generation.to_string())
        .bind(pin.connection_id.to_string())
        .bind(pin.connection_revision)
        .bind(pin.binding_revision)
        .bind(&pin.binding_updated_at)
        .bind(pin.scope.account_scope.storage_key())
        .bind(h.id.to_string())
        .bind(&h.sql)
        .bind(kind_str(h.kind))
        .bind(&h.status)
        .bind(h.row_count)
        .bind(h.duration_ms)
        .bind(&h.error)
        .bind(h.executed_at)
        .bind(&h.origin)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "workspace scope changed before query history could be saved".into(),
            });
        }
        Ok(())
    }

    pub async fn list_history(&self, connection_id: Uuid) -> AppResult<Vec<HistoryEntry>> {
        self.get_connection(connection_id).await?;
        let account_scope = self.active_local_scope().await?;
        let rows = sqlx::query(
            "SELECT * FROM query_history
             WHERE connection_id = ?1 AND account_scope = ?2
             ORDER BY executed_at DESC",
        )
        .bind(connection_id.to_string())
        .bind(account_scope)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_history).collect()
    }

    /// Resolve the initial query provenance and active generation in one SQLite
    /// snapshot. Callers inspect eligibility before doing any connection pin work.
    pub(crate) async fn resolve_history_for_dashboard_prepare(
        &self,
        id: Uuid,
    ) -> AppResult<ResolvedDashboardHistory> {
        let row = sqlx::query(
            "SELECT h.*,
                    active.workspace_id AS pinned_workspace_id,
                    active.workspace_kind AS pinned_workspace_kind,
                    active.selected_account_id AS pinned_selected_account_id,
                    active.account_scope AS pinned_account_scope,
                    active.scope_generation AS pinned_scope_generation
             FROM (
                 SELECT w.id AS workspace_id,
                        w.kind AS workspace_kind,
                        account.value AS selected_account_id,
                        CASE WHEN w.kind = 'personal'
                             THEN 'personal' ELSE account.value END AS account_scope,
                        generation.value AS scope_generation
                 FROM app_settings workspace
                 JOIN workspaces w
                   ON workspace.key = 'active_workspace_id'
                  AND workspace.value = w.id
                  AND w.lifecycle_state = 'active'
                 LEFT JOIN app_settings account
                   ON account.key = 'active_workspace_account_id'
                 JOIN app_settings generation
                   ON generation.key = 'active_scope_generation'
             ) active
             JOIN connections c
               ON c.workspace_id = active.workspace_id
              AND c.deleted_at IS NULL
             JOIN query_history h
               ON h.connection_id = c.id
              AND h.account_scope = active.account_scope
             WHERE h.id = ?1
               AND (active.workspace_kind = 'personal'
                    OR active.selected_account_id IS NOT NULL)
               AND (active.workspace_kind = 'personal'
                    OR EXISTS(
                        SELECT 1 FROM workspace_members m
                        WHERE m.workspace_id = active.workspace_id
                          AND m.user_id = active.selected_account_id
                          AND m.status = 'active'
                    ))
               AND (active.workspace_kind = 'personal'
                    OR c.remote_id IS NOT NULL
                    OR c.account_user_id = active.selected_account_id)",
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("query history {id}")))?;
        Ok(ResolvedDashboardHistory {
            history: row_to_history(&row)?,
            scope: row_to_active_resource_scope(&row)?,
        })
    }

    /// Re-read query provenance from the same SQLite snapshot that proves the
    /// retained connection authority is current. The captured initial scope defeats
    /// cross-process A → B → A changes before pinning.
    pub(crate) async fn get_history_if_current(
        &self,
        pin: &PinnedConnection,
        resolved: &ResolvedDashboardHistory,
    ) -> AppResult<HistoryEntry> {
        if resolved.scope != pin.scope || resolved.history.connection_id != pin.connection_id {
            return Err(dashboard_scope_changed());
        }
        let mut tx = self.pool.begin().await?;
        if !Self::is_pin_current_with_access(&mut *tx, pin, true).await? {
            return Err(dashboard_scope_changed());
        }
        let row = sqlx::query(
            "SELECT h.* FROM query_history h
             JOIN connections c ON c.id = h.connection_id
             WHERE h.id = ?1 AND h.connection_id = ?2 AND h.account_scope = ?3
               AND c.workspace_id = ?4 AND c.deleted_at IS NULL",
        )
        .bind(resolved.history.id.to_string())
        .bind(pin.connection_id.to_string())
        .bind(pin.scope.account_scope.storage_key())
        .bind(pin.scope.workspace_id.to_string())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("query history {}", resolved.history.id)))?;
        let history = row_to_history(&row)?;
        tx.commit().await?;
        Ok(history)
    }
}
