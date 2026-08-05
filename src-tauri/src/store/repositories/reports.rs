//! Durable, authority-pinned Agent report mutation outbox.

use super::super::*;
use crate::features::reports::{validate_stored_mutation, StoredReportMutationKind};

const MAX_REPORT_OUTBOX_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;

impl Store {
    /// Persist the complete secret-free report mutation before its first network
    /// attempt. The writer lock and final pin check close scope/account ABA races.
    pub(crate) async fn enqueue_report_mutation_if_current(
        &self,
        pin: &PinnedConnection,
        stored: &StoredReportMutation,
    ) -> AppResult<Uuid> {
        validate_stored_mutation(stored)?;
        let selected_account =
            pin.scope
                .selected_account_id
                .as_deref()
                .ok_or_else(|| AppError::Blocked {
                    reason: "Agent reports require an active Team workspace account".into(),
                })?;
        if pin.scope.workspace_kind != WorkspaceKind::Team
            || !pin.requires_remote_rbac
            || selected_account != stored.authority.account_user_id
            || pin.connection_id != Uuid::from(stored.connection_id())
            || pin.connection_revision != stored.authority.connection_revision
            || pin.binding_revision != stored.authority.binding_revision
            || pin.binding_updated_at != stored.authority.binding_updated_at
        {
            return Err(AppError::Blocked {
                reason: "Agent report authority changed before it could be queued".into(),
            });
        }
        let payload_json = serde_json::to_string(stored)?;
        if payload_json.len() > MAX_REPORT_OUTBOX_PAYLOAD_BYTES {
            return Err(AppError::Config(
                "Agent report outbox payload is too large".into(),
            ));
        }
        let expected_revision = i64::try_from(stored.expected_revision())
            .map_err(|_| AppError::Config("Agent report revision is too large".into()))?;
        let operation = match &stored.mutation {
            StoredReportMutationKind::Propose { .. } => "propose",
            StoredReportMutationKind::AppendEvidence { .. } => "append_evidence",
        };
        let outbox_id = Uuid::new_v4();
        let mut tx = self.pool.begin().await?;
        let locked = sqlx::query(
            "UPDATE app_settings SET value = value WHERE key = 'active_scope_generation'",
        )
        .execute(&mut *tx)
        .await?;
        if locked.rows_affected() != 1
            || !Self::is_pin_current_with_access(&mut *tx, pin, false).await?
        {
            return Err(AppError::Blocked {
                reason: "Agent report authority changed before it could be queued".into(),
            });
        }
        let can_edit: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                 SELECT 1 FROM workspace_members
                 WHERE workspace_id = ?1 AND user_id = ?2 AND status = 'active'
                   AND role IN ('editor', 'admin', 'owner')
             )",
        )
        .bind(pin.scope.workspace_id.to_string())
        .bind(selected_account)
        .fetch_one(&mut *tx)
        .await?;
        if !can_edit {
            return Err(AppError::Blocked {
                reason: "Agent report proposals require workspace Editor access".into(),
            });
        }
        sqlx::query(
            "INSERT INTO sync_outbox
             (id, workspace_id, resource_type, resource_id, operation, revision,
              payload_json, created_at)
             VALUES (?1, ?2, 'report', ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(outbox_id.to_string())
        .bind(pin.scope.workspace_id.to_string())
        .bind(stored.report_id().to_string())
        .bind(operation)
        .bind(expected_revision)
        .bind(payload_json)
        .bind(Utc::now())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(outbox_id)
    }

    /// Read only the selected account's report mutations in SQLite insertion order.
    /// `rowid` is the ordering authority because two mutations may share a timestamp.
    pub(crate) async fn pending_report_mutations_for_active_scope(
        &self,
    ) -> AppResult<Vec<PendingReportMutation>> {
        let scope = self.active_resource_scope().await?;
        if scope.workspace_kind == WorkspaceKind::Personal {
            return Ok(Vec::new());
        }
        let selected_account = scope.selected_account_id.ok_or_else(|| AppError::Blocked {
            reason: "Agent report replay requires an active Team workspace account".into(),
        })?;
        let rows = sqlx::query(
            "SELECT id, workspace_id, resource_id, operation, revision, payload_json
             FROM sync_outbox
             WHERE workspace_id = ?1 AND resource_type = 'report'
             ORDER BY rowid",
        )
        .bind(scope.workspace_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        let mut pending = Vec::new();
        for row in rows {
            let payload_json: Option<String> = row.try_get("payload_json")?;
            let payload_json = payload_json
                .ok_or_else(|| AppError::Config("Agent report outbox payload is missing".into()))?;
            if payload_json.len() > MAX_REPORT_OUTBOX_PAYLOAD_BYTES {
                return Err(AppError::Config(
                    "Agent report outbox payload is too large".into(),
                ));
            }
            let stored: StoredReportMutation = serde_json::from_str(&payload_json)?;
            validate_stored_mutation(&stored)?;
            if stored.authority.account_user_id != selected_account {
                continue;
            }
            let resource_id = parse_uuid(row.try_get("resource_id")?)?;
            let revision: i64 = row.try_get("revision")?;
            let operation: String = row.try_get("operation")?;
            let expected_operation = match &stored.mutation {
                StoredReportMutationKind::Propose { .. } => "propose",
                StoredReportMutationKind::AppendEvidence { .. } => "append_evidence",
            };
            if resource_id != stored.report_id()
                || revision < 0
                || u64::try_from(revision).ok() != Some(stored.expected_revision())
                || operation != expected_operation
            {
                return Err(AppError::Config(
                    "Agent report outbox identity changed".into(),
                ));
            }
            pending.push(PendingReportMutation {
                outbox_id: parse_uuid(row.try_get("id")?)?,
                workspace_id: parse_uuid(row.try_get("workspace_id")?)?,
                stored,
            });
        }
        Ok(pending)
    }

    /// Revalidate every retained local authority field immediately before a replay.
    /// The hosted endpoint performs the independent online RBAC check afterwards.
    pub(crate) async fn is_report_mutation_authority_current(
        &self,
        pending: &PendingReportMutation,
    ) -> AppResult<bool> {
        let authority = &pending.stored.authority;
        let current: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                 SELECT 1
                 FROM app_settings active
                 JOIN workspaces w
                   ON active.key = 'active_workspace_id'
                  AND active.value = w.id
                  AND w.id = ?1
                  AND w.kind = 'team'
                  AND w.lifecycle_state = 'active'
                 JOIN app_settings account
                   ON account.key = 'active_workspace_account_id'
                  AND account.value = ?2
                 JOIN workspace_members member
                   ON member.workspace_id = w.id
                  AND member.user_id = account.value
                  AND member.status = 'active'
                  AND member.role IN ('editor', 'admin', 'owner')
                 JOIN connections connection
                   ON connection.id = ?3
                  AND connection.workspace_id = w.id
                  AND connection.remote_id IS NOT NULL
                  AND connection.deleted_at IS NULL
                  AND connection.revision = ?4
                 LEFT JOIN workspace_connection_bindings binding
                   ON binding.connection_id = connection.id
                  AND binding.account_user_id = account.value
                 WHERE CASE WHEN connection.remote_id IS NOT NULL
                            THEN COALESCE(binding.revision, 0) ELSE 0 END = ?5
                   AND CASE WHEN connection.remote_id IS NOT NULL
                            THEN COALESCE(binding.updated_at, '') ELSE '' END = ?6
                   AND COALESCE(binding.workspace_access, 'view')
                       IN ('read', 'write', 'manage')
             )",
        )
        .bind(pending.workspace_id.to_string())
        .bind(&authority.account_user_id)
        .bind(pending.stored.connection_id().to_string())
        .bind(authority.connection_revision)
        .bind(authority.binding_revision)
        .bind(&authority.binding_updated_at)
        .fetch_one(&self.pool)
        .await?;
        Ok(current)
    }

    pub(crate) async fn acknowledge_report_mutation(
        &self,
        pending: &PendingReportMutation,
    ) -> AppResult<()> {
        let expected_revision = i64::try_from(pending.stored.expected_revision())
            .map_err(|_| AppError::Config("Agent report revision is too large".into()))?;
        let deleted = sqlx::query(
            "DELETE FROM sync_outbox
             WHERE id = ?1 AND workspace_id = ?2 AND resource_type = 'report'
               AND resource_id = ?3 AND revision = ?4",
        )
        .bind(pending.outbox_id.to_string())
        .bind(pending.workspace_id.to_string())
        .bind(pending.stored.report_id().to_string())
        .bind(expected_revision)
        .execute(&self.pool)
        .await?;
        if deleted.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "Agent report outbox changed during replay".into(),
            });
        }
        Ok(())
    }

    /// Keep failure telemetry deliberately categorical: raw hosted response bodies,
    /// SQL evidence, session values, and provider details never enter `last_error`.
    pub(crate) async fn record_report_mutation_failure(
        &self,
        pending: &PendingReportMutation,
        error: &AppError,
    ) -> AppResult<()> {
        let updated = sqlx::query(
            "UPDATE sync_outbox
             SET attempts = attempts + 1, last_error = ?2
             WHERE id = ?1 AND workspace_id = ?3 AND resource_type = 'report'",
        )
        .bind(pending.outbox_id.to_string())
        .bind(error.kind())
        .bind(pending.workspace_id.to_string())
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "Agent report outbox changed while recording replay failure".into(),
            });
        }
        Ok(())
    }
}
