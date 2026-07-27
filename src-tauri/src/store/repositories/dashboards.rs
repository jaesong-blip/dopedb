//! Scope-pinned dashboard persistence and optimistic conflict handling.

use super::super::*;

impl Store {
    // ── saved dashboards ────────────────────────────────────────────────────

    /// Test-only convenience for seeding dashboards. Production creation must hold
    /// a scope-pinned capability and call `save_dashboard_if_current`.
    #[cfg(test)]
    pub(crate) async fn save_dashboard(&self, draft: &DashboardDraft) -> AppResult<Dashboard> {
        let pin = self
            .pin_connection_for_dashboard(draft.connection_id.into())
            .await?;
        self.save_dashboard_if_current(&pin, draft).await
    }

    /// Persist a dashboard only while the supplied connection authority is still
    /// current. Taking SQLite's writer lock before rechecking the pin prevents a
    /// second process from switching scope or changing connection material between
    /// the check, insert, and outbox append.
    pub(crate) async fn save_dashboard_if_current(
        &self,
        pin: &PinnedConnection,
        draft: &DashboardDraft,
    ) -> AppResult<Dashboard> {
        if Uuid::from(draft.connection_id) != pin.connection_id {
            return Err(AppError::Blocked {
                reason: "dashboard connection does not match the authorized connection".into(),
            });
        }
        let id = DashboardId::from(Uuid::new_v4());
        let now = Utc::now();
        let visualization_json = serde_json::to_string(&draft.visualization)?;
        let mut tx = self.pool.begin().await?;
        Self::acquire_dashboard_writer(&mut tx).await?;
        if !Self::is_pin_current_with_access(&mut *tx, pin, true).await? {
            return Err(dashboard_scope_changed());
        }
        let inserted = sqlx::query(
            r#"INSERT INTO dashboards
                  (id, connection_id, title, description, sql, visualization_json,
                   workspace_id, revision, sync_status, created_at, updated_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,1,'dirty',?8,?8)"#,
        )
        .bind(id.to_string())
        .bind(draft.connection_id.to_string())
        .bind(&draft.title)
        .bind(&draft.description)
        .bind(&draft.sql)
        .bind(visualization_json)
        .bind(pin.scope.workspace_id.to_string())
        .bind(now)
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() != 1 {
            return Err(dashboard_scope_changed());
        }
        enqueue_outbox(
            &mut tx,
            pin.scope.workspace_id,
            "dashboard",
            id.into(),
            "upsert",
            1,
        )
        .await?;
        tx.commit().await?;

        Ok(Dashboard {
            id,
            connection_id: draft.connection_id,
            title: draft.title.clone(),
            description: draft.description.clone(),
            sql: draft.sql.clone(),
            visualization: draft.visualization.clone(),
            created_at: now,
            updated_at: now,
        })
    }

    /// List one connection's saved dashboards from the same read snapshot that
    /// proves the retained scope and connection revision are still current.
    pub(crate) async fn list_dashboards_if_current(
        &self,
        pin: &PinnedConnection,
    ) -> AppResult<Vec<Dashboard>> {
        let mut tx = self.pool.begin().await?;
        if !Self::is_pin_current_with_access(&mut *tx, pin, true).await? {
            return Err(dashboard_scope_changed());
        }
        let rows = sqlx::query(
            "SELECT d.* FROM dashboards d
             JOIN connections c ON c.id = d.connection_id
             WHERE d.connection_id = ?1 AND d.workspace_id = ?2 AND d.deleted_at IS NULL
               AND c.workspace_id = ?2 AND c.deleted_at IS NULL
             ORDER BY d.updated_at DESC, d.rowid DESC",
        )
        .bind(pin.connection_id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .fetch_all(&mut *tx)
        .await?;
        let dashboards = rows
            .iter()
            .map(row_to_dashboard)
            .collect::<AppResult<_>>()?;
        tx.commit().await?;
        Ok(dashboards)
    }

    #[cfg(test)]
    pub(crate) async fn list_dashboards(
        &self,
        connection_id: ConnectionId,
    ) -> AppResult<Vec<Dashboard>> {
        let pin = self
            .pin_connection_for_dashboard(connection_id.into())
            .await?;
        self.list_dashboards_if_current(&pin).await
    }

    pub(crate) async fn get_dashboard(&self, id: DashboardId) -> AppResult<Dashboard> {
        let workspace_id = self.active_workspace_id().await?;
        let row = sqlx::query(
            "SELECT d.* FROM dashboards d
             JOIN connections c ON c.id = d.connection_id
             WHERE d.id = ?1 AND d.workspace_id = ?2 AND d.deleted_at IS NULL
               AND c.workspace_id = ?2 AND c.deleted_at IS NULL",
        )
        .bind(id.to_string())
        .bind(workspace_id.to_string())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("dashboard {id}")))?;
        row_to_dashboard(&row)
    }

    /// Pin a dashboard identity for metadata deletion without parsing its
    /// visualization. The connection pin applies membership and account-local
    /// visibility; the final read transaction closes cross-process races.
    pub(crate) async fn pin_dashboard_for_view(
        &self,
        id: DashboardId,
    ) -> AppResult<PinnedDashboard> {
        let row = sqlx::query(
            "SELECT d.connection_id, d.revision,
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
             JOIN dashboards d
               ON d.workspace_id = active.workspace_id
              AND d.deleted_at IS NULL
             JOIN connections c
               ON c.id = d.connection_id
              AND c.workspace_id = active.workspace_id
              AND c.deleted_at IS NULL
             WHERE d.id = ?1
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
        .ok_or_else(|| AppError::NotFound(format!("dashboard {id}")))?;
        let connection_id = parse_uuid(row.try_get("connection_id")?)?;
        let dashboard_revision = row.try_get("revision")?;
        let initial_scope = row_to_active_resource_scope(&row)?;
        let connection = match self.pin_connection_for_dashboard(connection_id).await {
            Ok(connection) => connection,
            Err(AppError::NotFound(_)) => {
                return Err(AppError::NotFound(format!("dashboard {id}")))
            }
            Err(error) => return Err(error),
        };
        if connection.scope != initial_scope {
            return Err(dashboard_scope_changed());
        }
        let mut tx = self.pool.begin().await?;
        if !Self::is_pin_current_with_access(&mut *tx, &connection, true).await? {
            return Err(dashboard_scope_changed());
        }
        let current: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                 SELECT 1 FROM dashboards d
                 WHERE d.id = ?1 AND d.workspace_id = ?2 AND d.connection_id = ?3
                   AND d.revision = ?4 AND d.deleted_at IS NULL
             )",
        )
        .bind(id.to_string())
        .bind(connection.scope.workspace_id.to_string())
        .bind(connection.connection_id.to_string())
        .bind(dashboard_revision)
        .fetch_one(&mut *tx)
        .await?;
        if !current {
            return Err(dashboard_scope_changed());
        }
        tx.commit().await?;
        Ok(PinnedDashboard {
            dashboard_id: id,
            connection_id,
            dashboard_revision,
            connection,
        })
    }

    #[cfg(test)]
    pub(crate) async fn delete_dashboard(&self, id: DashboardId) -> AppResult<()> {
        let pin = self.pin_dashboard_for_view(id).await?;
        self.delete_dashboard_if_current(&pin).await
    }

    /// Tombstone exactly the dashboard revision that was pinned for this operation.
    /// The returned revision feeds exactly one outbox event; a stale or concurrent
    /// delete cannot publish a phantom event.
    pub(crate) async fn delete_dashboard_if_current(&self, pin: &PinnedDashboard) -> AppResult<()> {
        if pin.connection_id != pin.connection.connection_id {
            return Err(dashboard_scope_changed());
        }
        self.delete_dashboard_revision_if_current(
            &pin.connection,
            pin.dashboard_id,
            pin.dashboard_revision,
        )
        .await
    }

    async fn delete_dashboard_revision_if_current(
        &self,
        connection: &PinnedConnection,
        dashboard_id: DashboardId,
        dashboard_revision: i64,
    ) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        Self::acquire_dashboard_writer(&mut tx).await?;
        if !Self::is_pin_current_with_access(&mut *tx, connection, true).await? {
            return Err(dashboard_scope_changed());
        }
        let revision: Option<i64> = sqlx::query_scalar(
            "UPDATE dashboards SET deleted_at = ?2, updated_at = ?2,
                    revision = revision + 1, sync_status = 'dirty'
             WHERE id = ?1 AND workspace_id = ?3 AND connection_id = ?4
               AND revision = ?5 AND deleted_at IS NULL
             RETURNING revision",
        )
        .bind(dashboard_id.to_string())
        .bind(Utc::now())
        .bind(connection.scope.workspace_id.to_string())
        .bind(connection.connection_id.to_string())
        .bind(dashboard_revision)
        .fetch_optional(&mut *tx)
        .await?;
        let revision = revision.ok_or_else(dashboard_scope_changed)?;
        enqueue_outbox(
            &mut tx,
            connection.scope.workspace_id,
            "dashboard",
            dashboard_id.into(),
            "delete",
            revision,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn acquire_dashboard_writer(tx: &mut Transaction<'_, Sqlite>) -> AppResult<()> {
        let locked = sqlx::query(
            "UPDATE app_settings SET value = value WHERE key = 'active_scope_generation'",
        )
        .execute(&mut **tx)
        .await?;
        if locked.rows_affected() != 1 {
            return Err(AppError::Config(
                "active workspace generation is missing".into(),
            ));
        }
        Ok(())
    }
}
