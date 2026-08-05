//! Scope-pinned dashboard persistence and optimistic conflict handling.

use super::super::*;

impl Store {
    // ── saved dashboards ────────────────────────────────────────────────────

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
        let sync_status = if pin.scope.workspace_kind == WorkspaceKind::Team {
            "dirty"
        } else {
            "local"
        };
        let mut tx = self.pool.begin().await?;
        Self::acquire_dashboard_writer(&mut tx).await?;
        if !Self::is_pin_current_with_access(&mut *tx, pin, true).await? {
            return Err(dashboard_scope_changed());
        }
        let inserted = sqlx::query(
            r#"INSERT INTO dashboards
                  (id, connection_id, title, description, sql, visualization_json,
                   workspace_id, revision, sync_status, created_at, updated_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?9)"#,
        )
        .bind(id.to_string())
        .bind(draft.connection_id.to_string())
        .bind(&draft.title)
        .bind(&draft.description)
        .bind(&draft.sql)
        .bind(visualization_json)
        .bind(pin.scope.workspace_id.to_string())
        .bind(sync_status)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() != 1 {
            return Err(dashboard_scope_changed());
        }
        if pin.scope.workspace_kind == WorkspaceKind::Team {
            enqueue_outbox(
                &mut tx,
                pin.scope.workspace_id,
                "dashboard",
                id.into(),
                "upsert",
                1,
            )
            .await?;
        }
        tx.commit().await?;

        Ok(Dashboard {
            id,
            connection_id: draft.connection_id,
            title: draft.title.clone(),
            description: draft.description.clone(),
            sql: draft.sql.clone(),
            visualization: draft.visualization.clone(),
            state: DashboardState::Draft,
            sync_status: if pin.scope.workspace_kind == WorkspaceKind::Team {
                DashboardSyncStatus::Dirty
            } else {
                DashboardSyncStatus::Local
            },
            owner_member_id: None,
            updated_by_member_id: None,
            revision: 1,
            remote_revision: None,
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
        let sync_status = if connection.scope.workspace_kind == WorkspaceKind::Team {
            "dirty"
        } else {
            "local"
        };
        let revision: Option<i64> = sqlx::query_scalar(
            "UPDATE dashboards SET deleted_at = ?2, updated_at = ?2,
                    revision = revision + 1, sync_status = ?6
             WHERE id = ?1 AND workspace_id = ?3 AND connection_id = ?4
               AND revision = ?5 AND deleted_at IS NULL
             RETURNING revision",
        )
        .bind(dashboard_id.to_string())
        .bind(Utc::now())
        .bind(connection.scope.workspace_id.to_string())
        .bind(connection.connection_id.to_string())
        .bind(dashboard_revision)
        .bind(sync_status)
        .fetch_optional(&mut *tx)
        .await?;
        let revision = revision.ok_or_else(dashboard_scope_changed)?;
        if connection.scope.workspace_kind == WorkspaceKind::Team {
            enqueue_outbox(
                &mut tx,
                connection.scope.workspace_id,
                "dashboard",
                dashboard_id.into(),
                "delete",
                revision,
            )
            .await?;
        }
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

    /// Coalesce the durable outbox to one latest mutation per dashboard. The
    /// projection contains only the saved definition; result rows and run history
    /// live in different tables and cannot be selected by this query.
    pub(crate) async fn pending_dashboard_mutations(
        &self,
        workspace_id: Uuid,
    ) -> AppResult<Vec<PendingDashboardMutation>> {
        let rows = sqlx::query(
            "SELECT outbox.id AS outbox_id, outbox.resource_id, outbox.operation,
                    outbox.revision AS local_revision,
                    dashboard.connection_id, dashboard.remote_id,
                    dashboard.remote_revision, dashboard.title, dashboard.description,
                    dashboard.sql, dashboard.visualization_json
             FROM sync_outbox outbox
             JOIN dashboards dashboard
               ON dashboard.id = outbox.resource_id
              AND dashboard.workspace_id = outbox.workspace_id
             WHERE outbox.workspace_id = ?1
               AND outbox.resource_type = 'dashboard'
               AND NOT EXISTS (
                 SELECT 1 FROM sync_outbox newer
                 WHERE newer.workspace_id = outbox.workspace_id
                   AND newer.resource_type = outbox.resource_type
                   AND newer.resource_id = outbox.resource_id
                   AND newer.revision > outbox.revision
               )
             ORDER BY outbox.created_at, outbox.id",
        )
        .bind(workspace_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let operation: String = row.try_get("operation")?;
                let operation = match operation.as_str() {
                    "upsert" => DashboardOutboxOperation::Upsert,
                    "delete" => DashboardOutboxOperation::Delete,
                    _ => {
                        return Err(AppError::Config(
                            "dashboard outbox contains an invalid operation".into(),
                        ))
                    }
                };
                let local_revision: i64 = row.try_get("local_revision")?;
                let remote_revision: Option<i64> = row.try_get("remote_revision")?;
                if local_revision < 1 || remote_revision.is_some_and(|value| value < 1) {
                    return Err(AppError::Config(
                        "dashboard outbox contains an invalid revision".into(),
                    ));
                }
                let visualization_json: String = row.try_get("visualization_json")?;
                let visualization = serde_json::from_str(&visualization_json)?;
                validate_visualization(&visualization)?;
                Ok(PendingDashboardMutation {
                    outbox_id: parse_uuid(row.try_get("outbox_id")?)?,
                    dashboard_id: parse_uuid(row.try_get("resource_id")?)?,
                    connection_id: parse_uuid(row.try_get("connection_id")?)?,
                    operation,
                    local_revision,
                    remote_id: parse_uuid_opt(row.try_get("remote_id")?)?,
                    remote_revision,
                    title: row.try_get("title")?,
                    description: row.try_get("description")?,
                    sql: row.try_get("sql")?,
                    visualization_json,
                })
            })
            .collect()
    }

    /// Advance a local mutation only if the exact outbox identity and local
    /// revision are still current. A newer offline edit remains dirty and keeps its
    /// own outbox row.
    pub(crate) async fn acknowledge_dashboard_mutation(
        &self,
        workspace_id: Uuid,
        mutation: &PendingDashboardMutation,
        remote: Option<&RemoteDashboard>,
    ) -> AppResult<()> {
        if remote.is_some_and(|dashboard| {
            dashboard.id != mutation.dashboard_id
                || dashboard.connection_id != mutation.connection_id
        }) {
            return Err(AppError::Network(
                "shared dashboard acknowledgement changed resource identity".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        Self::acquire_dashboard_writer(&mut tx).await?;
        let current: bool = sqlx::query_scalar(
            "SELECT EXISTS(
               SELECT 1 FROM sync_outbox
               WHERE id = ?1 AND workspace_id = ?2 AND resource_type = 'dashboard'
                 AND resource_id = ?3 AND revision = ?4
             )",
        )
        .bind(mutation.outbox_id.to_string())
        .bind(workspace_id.to_string())
        .bind(mutation.dashboard_id.to_string())
        .bind(mutation.local_revision)
        .fetch_one(&mut *tx)
        .await?;
        if !current {
            return Err(AppError::Blocked {
                reason: "dashboard changed while workspace sync was running".into(),
            });
        }
        if let Some(remote) = remote {
            let changed = sqlx::query(
                "UPDATE dashboards
                 SET remote_id = ?1, remote_revision = ?2,
                     state = ?3, owner_member_id = ?4, updated_by_member_id = ?5,
                     sync_status = CASE WHEN revision = ?6 THEN 'synced' ELSE 'dirty' END
                 WHERE id = ?7 AND workspace_id = ?8 AND connection_id = ?9",
            )
            .bind(remote.id.to_string())
            .bind(remote.revision)
            .bind(remote.state.as_str())
            .bind(&remote.owner_member_id)
            .bind(&remote.updated_by_member_id)
            .bind(mutation.local_revision)
            .bind(mutation.dashboard_id.to_string())
            .bind(workspace_id.to_string())
            .bind(mutation.connection_id.to_string())
            .execute(&mut *tx)
            .await?;
            if changed.rows_affected() != 1 {
                return Err(AppError::Blocked {
                    reason: "dashboard scope changed while workspace sync was running".into(),
                });
            }
        } else {
            let changed = sqlx::query(
                "UPDATE dashboards
                 SET sync_status = CASE WHEN revision = ?1 THEN 'local' ELSE 'dirty' END
                 WHERE id = ?2 AND workspace_id = ?3 AND connection_id = ?4",
            )
            .bind(mutation.local_revision)
            .bind(mutation.dashboard_id.to_string())
            .bind(workspace_id.to_string())
            .bind(mutation.connection_id.to_string())
            .execute(&mut *tx)
            .await?;
            if changed.rows_affected() != 1 {
                return Err(AppError::Blocked {
                    reason: "dashboard scope changed while workspace sync was running".into(),
                });
            }
        }
        sqlx::query(
            "DELETE FROM sync_outbox
             WHERE workspace_id = ?1 AND resource_type = 'dashboard'
               AND resource_id = ?2 AND revision <= ?3",
        )
        .bind(workspace_id.to_string())
        .bind(mutation.dashboard_id.to_string())
        .bind(mutation.local_revision)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn mark_dashboard_conflict(
        &self,
        workspace_id: Uuid,
        mutation: &PendingDashboardMutation,
    ) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        Self::acquire_dashboard_writer(&mut tx).await?;
        let changed = sqlx::query(
            "UPDATE dashboards SET sync_status = 'conflict'
             WHERE id = ?1 AND workspace_id = ?2 AND revision = ?3",
        )
        .bind(mutation.dashboard_id.to_string())
        .bind(workspace_id.to_string())
        .bind(mutation.local_revision)
        .execute(&mut *tx)
        .await?;
        if changed.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "dashboard changed while conflict was recorded".into(),
            });
        }
        sqlx::query(
            "DELETE FROM sync_outbox
             WHERE workspace_id = ?1 AND resource_type = 'dashboard'
               AND resource_id = ?2 AND revision <= ?3",
        )
        .bind(workspace_id.to_string())
        .bind(mutation.dashboard_id.to_string())
        .bind(mutation.local_revision)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Replace only clean cached definitions with the complete remote collection.
    /// Dirty/conflict rows are preserved for explicit reconciliation, while missing
    /// clean remote rows become local tombstones.
    pub(crate) async fn sync_remote_dashboards(
        &self,
        workspace_id: Uuid,
        dashboards: &[RemoteDashboard],
    ) -> AppResult<()> {
        let mut seen = HashSet::with_capacity(dashboards.len());
        for dashboard in dashboards {
            if !seen.insert(dashboard.id) || dashboard.revision < 1 {
                return Err(AppError::Network(
                    "shared dashboard collection contains duplicate or invalid identities".into(),
                ));
            }
            let visualization = serde_json::from_str(&dashboard.visualization_json)?;
            validate_visualization(&visualization)?;
        }
        let mut tx = self.pool.begin().await?;
        Self::acquire_dashboard_writer(&mut tx).await?;
        for dashboard in dashboards {
            let changed = sqlx::query(
                "INSERT INTO dashboards
                   (id, connection_id, title, description, sql, visualization_json,
                    workspace_id, remote_id, remote_revision, revision, sync_status,
                    state, owner_member_id, updated_by_member_id, deleted_at,
                    created_at, updated_at)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?1, ?8, ?8, 'synced',
                        ?9, ?10, ?11, NULL, ?12, ?13
                 FROM connections connection
                 WHERE connection.id = ?2 AND connection.workspace_id = ?7
                   AND connection.deleted_at IS NULL
                 ON CONFLICT(id) DO UPDATE SET
                   connection_id = excluded.connection_id,
                   title = excluded.title,
                   description = excluded.description,
                   sql = excluded.sql,
                   visualization_json = excluded.visualization_json,
                   remote_id = excluded.remote_id,
                   remote_revision = excluded.remote_revision,
                   revision = excluded.revision,
                   sync_status = 'synced',
                   state = excluded.state,
                   owner_member_id = excluded.owner_member_id,
                   updated_by_member_id = excluded.updated_by_member_id,
                   deleted_at = NULL,
                   created_at = excluded.created_at,
                   updated_at = excluded.updated_at
                 WHERE dashboards.workspace_id = excluded.workspace_id
                   AND dashboards.sync_status IN ('local', 'synced')",
            )
            .bind(dashboard.id.to_string())
            .bind(dashboard.connection_id.to_string())
            .bind(&dashboard.title)
            .bind(&dashboard.description)
            .bind(&dashboard.sql)
            .bind(&dashboard.visualization_json)
            .bind(workspace_id.to_string())
            .bind(dashboard.revision)
            .bind(dashboard.state.as_str())
            .bind(&dashboard.owner_member_id)
            .bind(&dashboard.updated_by_member_id)
            .bind(dashboard.created_at)
            .bind(dashboard.updated_at)
            .execute(&mut *tx)
            .await?;
            if changed.rows_affected() == 0 {
                let preserved: bool = sqlx::query_scalar(
                    "SELECT EXISTS(
                       SELECT 1 FROM dashboards
                       WHERE id = ?1 AND workspace_id = ?2
                         AND sync_status IN ('dirty', 'conflict')
                     )",
                )
                .bind(dashboard.id.to_string())
                .bind(workspace_id.to_string())
                .fetch_one(&mut *tx)
                .await?;
                if !preserved {
                    return Err(AppError::Network(
                        "shared dashboard references an unavailable connection".into(),
                    ));
                }
            }
        }
        let cached = sqlx::query(
            "SELECT id FROM dashboards
             WHERE workspace_id = ?1 AND remote_id IS NOT NULL
               AND sync_status = 'synced' AND deleted_at IS NULL",
        )
        .bind(workspace_id.to_string())
        .fetch_all(&mut *tx)
        .await?;
        for row in cached {
            let id = parse_uuid(row.try_get("id")?)?;
            if !seen.contains(&id) {
                sqlx::query(
                    "UPDATE dashboards SET deleted_at = ?1, state = 'archived', updated_at = ?1
                     WHERE id = ?2 AND workspace_id = ?3
                       AND remote_id IS NOT NULL AND sync_status = 'synced'",
                )
                .bind(Utc::now())
                .bind(id.to_string())
                .bind(workspace_id.to_string())
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }
}
