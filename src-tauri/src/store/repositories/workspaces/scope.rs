//! Active-scope projection, generation, and membership-repair invariants.

use super::super::super::*;

pub(in crate::store) fn active_scope_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> AppResult<ActiveResourceScope> {
    let workspace_id = parse_uuid(row.try_get("workspace_id")?)?;
    let workspace_kind = parse_workspace_kind(row.try_get("workspace_kind")?)?;
    let selected_account_id: Option<String> = row.try_get("selected_account_id")?;
    let account_scope = match workspace_kind {
        WorkspaceKind::Personal => AccountScope::Personal,
        WorkspaceKind::Team => AccountScope::WorkspaceUser(
            selected_account_id
                .clone()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Config("a team workspace has no active account".into()))?,
        ),
    };
    Ok(ActiveResourceScope {
        workspace_id,
        workspace_kind,
        selected_account_id,
        account_scope,
        generation: parse_scope_generation(row.try_get::<String, _>("scope_generation")?.as_str())?,
    })
}

pub(in crate::store) fn account_scope_from_parts(
    workspace_kind: WorkspaceKind,
    selected_account_id: Option<&str>,
    stored_scope: &str,
) -> AppResult<AccountScope> {
    let account_scope = match workspace_kind {
        WorkspaceKind::Personal if stored_scope == "personal" => AccountScope::Personal,
        WorkspaceKind::Team => {
            let user_id = selected_account_id
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Config("a team workspace has no active account".into()))?;
            if stored_scope != user_id {
                return Err(AppError::Config(
                    "active workspace scope is internally inconsistent".into(),
                ));
            }
            AccountScope::WorkspaceUser(user_id.to_owned())
        }
        WorkspaceKind::Personal => {
            return Err(AppError::Config(
                "Personal Workspace has an invalid local scope".into(),
            ));
        }
    };
    Ok(account_scope)
}

pub(in crate::store) fn parse_scope_generation(raw: &str) -> AppResult<i64> {
    let generation = raw
        .parse::<i64>()
        .map_err(|_| AppError::Config("active scope generation is invalid".into()))?;
    if generation < 0 {
        return Err(AppError::Config(
            "active scope generation is invalid".into(),
        ));
    }
    Ok(generation)
}

pub(in crate::store) async fn bump_active_scope_generation(
    tx: &mut Transaction<'_, Sqlite>,
) -> AppResult<i64> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'active_scope_generation'")
            .fetch_optional(&mut **tx)
            .await?;
    let current = match raw {
        Some(raw) => parse_scope_generation(&raw)?,
        None => 0,
    };
    let next = current
        .checked_add(1)
        .ok_or_else(|| AppError::Config("active scope generation overflowed".into()))?;
    sqlx::query(
        "INSERT INTO app_settings (key, value)
         VALUES ('active_scope_generation', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(next.to_string())
    .execute(&mut **tx)
    .await?;
    Ok(next)
}

/// Membership synchronization can revoke the selected account while another account
/// keeps the same team workspace alive. Repair that tuple inside the synchronization
/// transaction so no committed state ever exposes a revoked account with a team.
pub(super) async fn repair_active_scope_after_membership_change(
    tx: &mut Transaction<'_, Sqlite>,
    now: DateTime<Utc>,
) -> AppResult<bool> {
    let current: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT workspace.value, account.value
         FROM app_settings workspace
         LEFT JOIN app_settings account
           ON account.key = 'active_workspace_account_id'
         WHERE workspace.key = 'active_workspace_id'",
    )
    .fetch_optional(&mut **tx)
    .await?;
    let Some((current_workspace_id, mut selected_account_id)) = current else {
        return Err(AppError::Config("no active workspace is configured".into()));
    };
    let mut account_setting_repaired = false;
    if let Some(user_id) = selected_account_id.as_deref() {
        let account_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                 SELECT 1 FROM workspace_accounts WHERE user_id = ?1
             )",
        )
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?;
        if !account_exists {
            sqlx::query(
                "DELETE FROM app_settings
                 WHERE key = 'active_workspace_account_id'",
            )
            .execute(&mut **tx)
            .await?;
            selected_account_id = None;
            account_setting_repaired = true;
        }
    }
    let current_is_valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM workspaces w
             WHERE w.id = ?1
               AND w.lifecycle_state = 'active'
               AND (w.kind = 'personal'
                    OR (?2 IS NOT NULL AND EXISTS(
                        SELECT 1 FROM workspace_members m
                        WHERE m.workspace_id = w.id
                          AND m.user_id = ?2
                          AND m.status = 'active'
                    )))
         )",
    )
    .bind(&current_workspace_id)
    .bind(selected_account_id.as_deref())
    .fetch_one(&mut **tx)
    .await?;
    if current_is_valid {
        if account_setting_repaired {
            bump_active_scope_generation(tx).await?;
        }
        return Ok(account_setting_repaired);
    }

    // Membership repair never chooses a different Team on the user's behalf.
    // Authentication and workspace navigation are independent decisions.
    let fallback_workspace_id = migrations::PERSONAL_WORKSPACE_ID.to_owned();

    sqlx::query(
        "UPDATE app_settings SET value = ?1
         WHERE key = 'active_workspace_id'",
    )
    .bind(&fallback_workspace_id)
    .execute(&mut **tx)
    .await?;
    if let Some(user_id) = selected_account_id.as_deref() {
        sqlx::query(
            "UPDATE workspace_accounts
             SET last_workspace_id = CASE
                     WHEN ?1 = ?2 THEN last_workspace_id ELSE ?1
                 END,
                 last_used_at = ?3,
                 updated_at = ?3
             WHERE user_id = ?4",
        )
        .bind(&fallback_workspace_id)
        .bind(migrations::PERSONAL_WORKSPACE_ID)
        .bind(now)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    }
    bump_active_scope_generation(tx).await?;
    Ok(true)
}

pub(in crate::store) async fn repair_active_scope_on_open(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    repair_active_scope_after_membership_change(&mut tx, Utc::now()).await?;
    tx.commit().await?;
    Ok(())
}
