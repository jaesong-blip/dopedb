//! Remembered account and workspace-membership reconciliation.

use super::super::super::*;
use super::scope::{active_scope_from_row, repair_active_scope_after_membership_change};

impl Store {
    // ── workspaces ─────────────────────────────────────────────────────────

    /// List locally available, active workspaces. Milestone 0 normally returns
    /// only the account-free Personal Workspace created by the migration.
    pub async fn list_workspaces(&self) -> AppResult<Vec<Workspace>> {
        let rows = sqlx::query(
            "SELECT * FROM workspaces WHERE lifecycle_state = 'active' ORDER BY kind, name",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_workspace).collect()
    }

    /// Return locally remembered accounts and their current hosted memberships. This
    /// index contains display metadata only; session tokens remain in the OS keychain.
    pub async fn workspace_accounts(&self) -> AppResult<Vec<WorkspaceAuthAccount>> {
        let account_rows = sqlx::query(
            "SELECT user_id, email, display_name FROM workspace_accounts
             ORDER BY last_used_at DESC, created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut accounts = Vec::with_capacity(account_rows.len());
        for row in account_rows {
            let user_id: String = row.try_get("user_id")?;
            let membership_rows = sqlx::query(
                "SELECT workspace_id, role FROM workspace_members
                 WHERE user_id = ?1 AND status = 'active'
                 ORDER BY joined_at ASC",
            )
            .bind(&user_id)
            .fetch_all(&self.pool)
            .await?;
            let memberships = membership_rows
                .iter()
                .map(|membership| {
                    Ok(WorkspaceAccountMembership {
                        workspace_id: Uuid::parse_str(membership.try_get("workspace_id")?)
                            .map(WorkspaceId::from)
                            .map_err(|error| AppError::Config(error.to_string()))?,
                        role: parse_workspace_role(membership.try_get("role")?)?,
                    })
                })
                .collect::<AppResult<Vec<_>>>()?;
            accounts.push(WorkspaceAuthAccount {
                user: WorkspaceAuthUser {
                    id: AccountId::new(user_id).ok_or_else(|| {
                        AppError::Config("stored workspace account id is empty".into())
                    })?,
                    email: row.try_get("email")?,
                    display_name: row.try_get("display_name")?,
                },
                memberships,
            });
        }
        Ok(accounts)
    }

    pub async fn active_workspace_account_id(&self) -> AppResult<Option<String>> {
        Ok(sqlx::query_scalar(
            "SELECT value FROM app_settings WHERE key = 'active_workspace_account_id'",
        )
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Read the complete active scope in one SQLite statement. Callers that need a
    /// durable identity for a longer operation must retain this value instead of
    /// re-reading workspace and account settings independently.
    pub(crate) async fn active_resource_scope(&self) -> AppResult<ActiveResourceScope> {
        let row = sqlx::query(
            "SELECT w.id AS workspace_id,
                    w.kind AS workspace_kind,
                    account.value AS selected_account_id,
                    generation.value AS scope_generation
             FROM app_settings active
             JOIN workspaces w
               ON active.key = 'active_workspace_id'
              AND active.value = w.id
              AND w.lifecycle_state = 'active'
             LEFT JOIN app_settings account
               ON account.key = 'active_workspace_account_id'
             JOIN app_settings generation
               ON generation.key = 'active_scope_generation'
             WHERE w.kind = 'personal'
                OR (account.value IS NOT NULL AND EXISTS(
                    SELECT 1 FROM workspace_members m
                    WHERE m.workspace_id = w.id
                      AND m.user_id = account.value
                      AND m.status = 'active'
                ))",
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::Config("no active workspace scope is configured".into()))?;
        active_scope_from_row(&row)
    }

    /// Remember public account identity before a possibly-offline membership refresh.
    /// This makes a completed device login durable without ever persisting its token.
    pub async fn remember_workspace_account(&self, user: &WorkspaceAuthUser) -> AppResult<()> {
        let now = Utc::now();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO workspace_accounts
                (user_id, email, display_name, created_at, updated_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?4, ?4)
             ON CONFLICT(user_id) DO UPDATE SET
                email = excluded.email,
                display_name = excluded.display_name,
                updated_at = excluded.updated_at",
        )
        .bind(user.id.as_str())
        .bind(&user.email)
        .bind(&user.display_name)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Reconcile one Better Auth account independently. A workspace stays visible while
    /// any remembered account still has an active membership, which prevents signing in
    /// as a second account from hiding the first account's workspaces.
    pub async fn sync_account_workspaces(
        &self,
        user: &WorkspaceAuthUser,
        workspaces: &[(Uuid, String, WorkspaceRole)],
    ) -> AppResult<()> {
        let personal_id = Uuid::parse_str(migrations::PERSONAL_WORKSPACE_ID)
            .map_err(|_| AppError::Config("invalid personal workspace id".into()))?;
        if workspaces.iter().any(|(id, _, _)| *id == personal_id) {
            return Err(AppError::Config(
                "remote workspace conflicts with the Personal Workspace".into(),
            ));
        }
        self.remember_workspace_account(user).await?;
        let now = Utc::now();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE workspace_members SET status = 'archived'
             WHERE user_id = ?1",
        )
        .bind(user.id.as_str())
        .execute(&mut *tx)
        .await?;
        for (id, name, role) in workspaces {
            sqlx::query(
                "INSERT INTO workspaces
                    (id, name, kind, lifecycle_state, created_at, updated_at)
                 VALUES (?1, ?2, 'team', 'active', ?3, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    lifecycle_state = 'active',
                    updated_at = excluded.updated_at
                 WHERE workspaces.kind = 'team'",
            )
            .bind(id.to_string())
            .bind(name)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            let member_id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO workspace_members
                    (id, workspace_id, user_id, display_name, role, status, joined_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)
                 ON CONFLICT(workspace_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET
                    display_name = excluded.display_name,
                    role = excluded.role,
                    status = 'active'",
            )
            .bind(member_id.to_string())
            .bind(id.to_string())
            .bind(user.id.as_str())
            .bind(&user.display_name)
            .bind(workspace_role_str(*role))
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
        // Upgrade legacy team-local ownership and the previous global credential
        // overlay only after this exact account's server membership was refreshed.
        // This prevents an unrelated account that signs in first from inheriting data.
        sqlx::query(
            "UPDATE connections SET account_user_id = ?1
             WHERE remote_id IS NULL AND account_user_id IS NULL
               AND workspace_id IN (
                   SELECT workspace_id FROM workspace_members
                   WHERE user_id = ?1 AND status = 'active'
               )",
        )
        .bind(user.id.as_str())
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO workspace_connection_bindings
                (connection_id, account_user_id, username, extra_params, secret_ref, updated_at)
             SELECT c.id, ?1, c.username, c.extra_params, c.secret_ref, ?2
             FROM connections c
             JOIN workspace_members m
               ON m.workspace_id = c.workspace_id
              AND m.user_id = ?1 AND m.status = 'active'
             WHERE c.remote_id IS NOT NULL
               AND (c.username != '' OR c.extra_params != '{}' OR c.secret_ref IS NOT NULL)",
        )
        .bind(user.id.as_str())
        .bind(now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE connections SET username = '', extra_params = '{}', secret_ref = NULL
             WHERE remote_id IS NOT NULL
               AND workspace_id IN (
                   SELECT workspace_id FROM workspace_members
                   WHERE user_id = ?1 AND status = 'active'
               )
               AND (username != '' OR extra_params != '{}' OR secret_ref IS NOT NULL)",
        )
        .bind(user.id.as_str())
        .execute(&mut *tx)
        .await?;
        for table in ["query_history", "query_service_sessions", "schema_cache"] {
            let statement = format!(
                "UPDATE {table} SET account_scope = ?1
                 WHERE account_scope = 'personal' AND connection_id IN (
                     SELECT c.id FROM connections c
                     JOIN workspace_members m
                       ON m.workspace_id = c.workspace_id
                      AND m.user_id = ?1 AND m.status = 'active'
                     JOIN workspaces w ON w.id = c.workspace_id AND w.kind = 'team'
                 )"
            );
            sqlx::query(AssertSqlSafe(statement))
                .bind(user.id.as_str())
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "UPDATE agent_chat_threads
             SET account_scope = ?1,
                 workspace_id = COALESCE(
                     (SELECT c.workspace_id FROM connections c
                      WHERE c.id = agent_chat_threads.connection_id),
                     workspace_id
                 )
             WHERE account_scope = 'personal'
               AND connection_id IN (
                   SELECT c.id FROM connections c
                   JOIN workspace_members m
                     ON m.workspace_id = c.workspace_id
                    AND m.user_id = ?1 AND m.status = 'active'
                   JOIN workspaces w ON w.id = c.workspace_id AND w.kind = 'team'
               )",
        )
        .bind(user.id.as_str())
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE workspaces SET lifecycle_state = 'archived', updated_at = ?1
             WHERE kind = 'team' AND NOT EXISTS (
                 SELECT 1 FROM workspace_members m
                 WHERE m.workspace_id = workspaces.id AND m.status = 'active'
             )",
        )
        .bind(now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE workspace_accounts SET last_workspace_id = NULL
             WHERE user_id = ?1 AND last_workspace_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM workspace_members m
                 WHERE m.user_id = ?1
                   AND m.workspace_id = workspace_accounts.last_workspace_id
                   AND m.status = 'active'
             )",
        )
        .bind(user.id.as_str())
        .execute(&mut *tx)
        .await?;
        repair_active_scope_after_membership_change(&mut tx, now).await?;
        tx.commit().await?;
        Ok(())
    }
}
