//! Provider-owned SQLite persistence for local credential bindings.
//!
//! The table stores an opaque OS-keyring reference and redacted verification
//! evidence only. Provider tokens and raw discovery responses never enter this
//! module, the sync outbox, or the audit chain.

use chrono::Utc;
use sqlx::Transaction;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::access::ActiveResourceScope;
use crate::store::Store;

mod sqlite_binding_rows;
use sqlite_binding_rows::{row_to_binding, row_to_cleanup};

/// Redacted, local binding state returned to the provider feature adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderBindingRow {
    pub(crate) binding_id: Uuid,
    pub(crate) workspace_id: Uuid,
    pub(crate) account_user_id: String,
    pub(crate) provider: String,
    pub(crate) integration_id: Uuid,
    pub(crate) integration_generation: String,
    pub(crate) keyring_ref: Option<Uuid>,
    pub(crate) principal_redacted: String,
    pub(crate) scope_fingerprint: String,
    pub(crate) verified_at: Option<String>,
    pub(crate) revision: i64,
    pub(crate) tombstoned_at: Option<String>,
    pub(crate) delete_pending: bool,
    pub(crate) updated_at: String,
}

/// Complete redacted replacement pointer for one local provider binding.
pub(crate) struct ProviderBindingCommit<'a> {
    pub(crate) scope: &'a ActiveResourceScope,
    pub(crate) provider: &'a str,
    pub(crate) integration_id: Uuid,
    pub(crate) integration_generation: &'a str,
    pub(crate) binding_id: Uuid,
    /// Opaque OS-keyring identifier. Keyless ADC intentionally has none.
    pub(crate) keyring_ref: Option<Uuid>,
    pub(crate) principal_redacted: &'a str,
    pub(crate) scope_fingerprint: &'a str,
}

pub(crate) struct PreviousProviderBinding {
    pub(crate) binding_id: Uuid,
    pub(crate) provider: String,
    pub(crate) integration_id: Uuid,
    pub(crate) keyring_ref: Uuid,
    pub(crate) integration_generation: String,
}

/// Exact non-secret retry identity read from the durable cleanup queue.
pub(crate) struct ProviderCleanupRow {
    pub(crate) workspace_id: Uuid,
    pub(crate) account_user_id: String,
    pub(crate) provider: String,
    pub(crate) integration_id: Uuid,
    pub(crate) integration_generation: String,
    pub(crate) binding_id: Uuid,
    pub(crate) keyring_ref: Uuid,
}

impl Store {
    /// Loads one durable local binding for the provider-local connection port.
    ///
    /// This query deliberately accepts the complete account/workspace/provider
    /// identity instead of consulting the selected UI scope.  The caller has
    /// already compared that identity with the active scope, and this exact
    /// predicate keeps a binding from another account or workspace from being
    /// used as a credential capability.
    pub(crate) async fn provider_binding_for_local_authority(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        provider: &str,
        integration_id: Uuid,
        integration_generation: &str,
        scope_fingerprint: &str,
    ) -> AppResult<Option<ProviderBindingRow>> {
        let row = sqlx::query(
            "SELECT * FROM workspace_provider_bindings
             WHERE workspace_id = ?1 AND account_user_id = ?2 AND provider = ?3
               AND integration_id = ?4 AND integration_generation = ?5
               AND scope_fingerprint = ?6
               AND tombstoned_at IS NULL AND delete_pending = 0",
        )
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .bind(provider)
        .bind(integration_id.to_string())
        .bind(integration_generation)
        .bind(scope_fingerprint)
        .fetch_optional(self.pool())
        .await?;
        row.as_ref().map(row_to_binding).transpose()
    }

    pub(crate) async fn list_provider_bindings(
        &self,
        scope: &ActiveResourceScope,
    ) -> AppResult<Vec<ProviderBindingRow>> {
        let account = required_account(scope)?;
        let rows = sqlx::query(
            "SELECT * FROM workspace_provider_bindings
             WHERE workspace_id = ?1 AND account_user_id = ?2 ORDER BY updated_at DESC",
        )
        .bind(scope.workspace_id.to_string())
        .bind(account)
        .fetch_all(self.pool())
        .await?;
        rows.iter().map(row_to_binding).collect()
    }

    /// Commits a copy-on-write keyring pointer only if the exact active scope
    /// has not changed since the receipt was issued. The returned pointer is
    /// eligible for best-effort deletion only after this transaction commits.
    pub(crate) async fn commit_provider_binding(
        &self,
        commit: ProviderBindingCommit<'_>,
    ) -> AppResult<Option<PreviousProviderBinding>> {
        let ProviderBindingCommit {
            scope,
            provider,
            integration_id,
            integration_generation,
            binding_id,
            keyring_ref,
            principal_redacted,
            scope_fingerprint,
        } = commit;
        let account = required_account(scope)?.to_owned();
        let mut tx = self.pool().begin().await?;
        ensure_scope_current(&mut tx, scope, &account).await?;
        let previous: Option<(String, Option<String>, String)> =
            sqlx::query_as::<_, (String, Option<String>, String)>(
                "SELECT binding_id, keyring_ref, integration_generation FROM workspace_provider_bindings
             WHERE workspace_id = ?1 AND account_user_id = ?2
               AND provider = ?3 AND integration_id = ?4",
            )
            .bind(scope.workspace_id.to_string())
            .bind(&account)
            .bind(provider)
            .bind(integration_id.to_string())
            .fetch_optional(&mut *tx)
            .await?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO workspace_provider_bindings
             (binding_id, workspace_id, account_user_id, provider, integration_id,
              integration_generation, keyring_ref, principal_redacted, scope_fingerprint,
              verified_at, revision, tombstoned_at, delete_pending, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, NULL, 0, ?10, ?10)
             ON CONFLICT(workspace_id, account_user_id, provider, integration_id) DO UPDATE SET
               binding_id = excluded.binding_id,
               integration_generation = excluded.integration_generation,
               keyring_ref = excluded.keyring_ref,
               principal_redacted = excluded.principal_redacted,
               scope_fingerprint = excluded.scope_fingerprint,
               verified_at = excluded.verified_at,
               revision = workspace_provider_bindings.revision + 1,
               tombstoned_at = NULL,
               delete_pending = 0,
               updated_at = excluded.updated_at",
        )
        .bind(binding_id.to_string())
        .bind(scope.workspace_id.to_string())
        .bind(&account)
        .bind(provider)
        .bind(integration_id.to_string())
        .bind(integration_generation)
        .bind(keyring_ref.map(|id| id.to_string()))
        .bind(principal_redacted)
        .bind(scope_fingerprint)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if let Some((previous_binding_id, Some(previous_keyring_ref), previous_generation)) =
            &previous
        {
            let cleanup = ProviderCleanupRow {
                workspace_id: scope.workspace_id,
                account_user_id: account.clone(),
                provider: provider.into(),
                integration_id,
                integration_generation: previous_generation.clone(),
                binding_id: Uuid::parse_str(previous_binding_id)
                    .map_err(|_| AppError::Config("invalid provider binding id".into()))?,
                keyring_ref: Uuid::parse_str(previous_keyring_ref)
                    .map_err(|_| AppError::Config("invalid provider keyring reference".into()))?,
            };
            queue_cleanup(&mut tx, &cleanup, &now).await?;
        }
        tx.commit().await?;
        previous
            .and_then(|(binding_id, keyring_ref, integration_generation)| {
                keyring_ref.map(|keyring_ref| (binding_id, keyring_ref, integration_generation))
            })
            .map(|(binding_id, keyring_ref, integration_generation)| {
                let binding_id = Uuid::parse_str(&binding_id)
                    .map_err(|_| AppError::Config("invalid provider binding id".into()))?;
                Uuid::parse_str(&keyring_ref)
                    .map(|keyring_ref| PreviousProviderBinding {
                        binding_id,
                        provider: provider.into(),
                        integration_id,
                        keyring_ref,
                        integration_generation,
                    })
                    .map_err(|_| AppError::Config("invalid provider keyring reference".into()))
            })
            .transpose()
    }

    pub(crate) async fn tombstone_provider_binding(
        &self,
        scope: &ActiveResourceScope,
        binding_id: Uuid,
    ) -> AppResult<Option<ProviderBindingRow>> {
        let account = required_account(scope)?.to_owned();
        let mut tx = self.pool().begin().await?;
        ensure_scope_current(&mut tx, scope, &account).await?;
        let row = sqlx::query(
            "SELECT * FROM workspace_provider_bindings
             WHERE binding_id = ?1 AND workspace_id = ?2 AND account_user_id = ?3
               AND tombstoned_at IS NULL",
        )
        .bind(binding_id.to_string())
        .bind(scope.workspace_id.to_string())
        .bind(&account)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };
        let binding = row_to_binding(&row)?;
        let now = Utc::now().to_rfc3339();
        let delete_pending = i64::from(binding.keyring_ref.is_some());
        sqlx::query(
            "UPDATE workspace_provider_bindings SET tombstoned_at = ?1, delete_pending = ?2,
             revision = revision + 1, updated_at = ?1 WHERE binding_id = ?3",
        )
        .bind(&now)
        .bind(delete_pending)
        .bind(binding.binding_id.to_string())
        .execute(&mut *tx)
        .await?;
        if let Some(keyring_ref) = binding.keyring_ref {
            let keyring_ref = keyring_ref.to_string();
            let cleanup = ProviderCleanupRow {
                workspace_id: binding.workspace_id,
                account_user_id: binding.account_user_id.clone(),
                provider: binding.provider.clone(),
                integration_id: binding.integration_id,
                integration_generation: binding.integration_generation.clone(),
                binding_id: binding.binding_id,
                keyring_ref: Uuid::parse_str(&keyring_ref)
                    .map_err(|_| AppError::Config("invalid provider keyring reference".into()))?,
            };
            queue_cleanup(&mut tx, &cleanup, &now).await?;
        }
        tx.commit().await?;
        Ok(Some(binding))
    }

    /// Startup/list retry deliberately does not depend on the selected UI
    /// scope: every row already contains its complete keyring identity.
    pub(crate) async fn list_provider_cleanup_global(&self) -> AppResult<Vec<ProviderCleanupRow>> {
        let rows = sqlx::query(
            "SELECT workspace_id, account_user_id, provider, integration_id,
                    integration_generation, binding_id, keyring_ref
             FROM workspace_provider_credential_cleanup ORDER BY created_at ASC LIMIT 32",
        )
        .fetch_all(self.pool())
        .await?;
        rows.iter().map(row_to_cleanup).collect()
    }

    pub(crate) async fn tombstone_provider_bindings_for_account(
        &self,
        account: Option<&str>,
    ) -> AppResult<Vec<ProviderBindingRow>> {
        let mut tx = self.pool().begin().await?;
        let rows = if let Some(account) = account {
            sqlx::query("SELECT * FROM workspace_provider_bindings WHERE account_user_id = ?1 AND tombstoned_at IS NULL")
                .bind(account)
                .fetch_all(&mut *tx)
                .await?
        } else {
            sqlx::query("SELECT * FROM workspace_provider_bindings WHERE tombstoned_at IS NULL")
                .fetch_all(&mut *tx)
                .await?
        };
        let mut tombstoned = Vec::new();
        for row in rows {
            let binding = row_to_binding(&row)?;
            tombstone_row(&mut tx, &binding).await?;
            tombstoned.push(binding);
        }
        tx.commit().await?;
        Ok(tombstoned)
    }

    pub(crate) async fn reconcile_provider_grants(
        &self,
        grants: &[(String, Uuid)],
    ) -> AppResult<Vec<ProviderBindingRow>> {
        let mut tx = self.pool().begin().await?;
        let rows =
            sqlx::query("SELECT * FROM workspace_provider_bindings WHERE tombstoned_at IS NULL")
                .fetch_all(&mut *tx)
                .await?;
        let mut tombstoned = Vec::new();
        for row in rows {
            let binding = row_to_binding(&row)?;
            if !grants.iter().any(|(account, workspace)| {
                account == &binding.account_user_id && *workspace == binding.workspace_id
            }) {
                tombstone_row(&mut tx, &binding).await?;
                tombstoned.push(binding);
            }
        }
        tx.commit().await?;
        Ok(tombstoned)
    }

    pub(crate) async fn complete_provider_cleanup(
        &self,
        cleanup: &ProviderCleanupRow,
    ) -> AppResult<()> {
        let mut tx = self.pool().begin().await?;
        sqlx::query(
            "DELETE FROM workspace_provider_credential_cleanup
             WHERE workspace_id = ?1 AND account_user_id = ?2 AND provider = ?3
               AND integration_id = ?4 AND integration_generation = ?5 AND keyring_ref = ?6",
        )
        .bind(cleanup.workspace_id.to_string())
        .bind(&cleanup.account_user_id)
        .bind(&cleanup.provider)
        .bind(cleanup.integration_id.to_string())
        .bind(&cleanup.integration_generation)
        .bind(cleanup.keyring_ref.to_string())
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE workspace_provider_bindings SET keyring_ref = NULL, delete_pending = 0,
             updated_at = ?1 WHERE binding_id = ?2 AND workspace_id = ?3
               AND account_user_id = ?4 AND keyring_ref = ?5 AND tombstoned_at IS NOT NULL",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(cleanup.binding_id.to_string())
        .bind(cleanup.workspace_id.to_string())
        .bind(&cleanup.account_user_id)
        .bind(cleanup.keyring_ref.to_string())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn enqueue_provider_cleanup(
        &self,
        cleanup: &ProviderCleanupRow,
    ) -> AppResult<()> {
        let mut tx = self.pool().begin().await?;
        let now = Utc::now().to_rfc3339();
        queue_cleanup(&mut tx, cleanup, &now).await?;
        tx.commit().await?;
        Ok(())
    }
}

async fn queue_cleanup(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    cleanup: &ProviderCleanupRow,
    now: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO workspace_provider_credential_cleanup
         (workspace_id, account_user_id, provider, integration_id, integration_generation,
          binding_id, keyring_ref, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(cleanup.workspace_id.to_string())
    .bind(&cleanup.account_user_id)
    .bind(&cleanup.provider)
    .bind(cleanup.integration_id.to_string())
    .bind(&cleanup.integration_generation)
    .bind(cleanup.binding_id.to_string())
    .bind(cleanup.keyring_ref.to_string())
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn tombstone_row(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    binding: &ProviderBindingRow,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE workspace_provider_bindings SET tombstoned_at = ?1, delete_pending = ?2,
         revision = revision + 1, updated_at = ?1 WHERE binding_id = ?3 AND tombstoned_at IS NULL",
    )
    .bind(&now)
    .bind(i64::from(binding.keyring_ref.is_some()))
    .bind(binding.binding_id.to_string())
    .execute(&mut **tx)
    .await?;
    if let Some(keyring_ref) = binding.keyring_ref {
        queue_cleanup(
            tx,
            &ProviderCleanupRow {
                workspace_id: binding.workspace_id,
                account_user_id: binding.account_user_id.clone(),
                provider: binding.provider.clone(),
                integration_id: binding.integration_id,
                integration_generation: binding.integration_generation.clone(),
                binding_id: binding.binding_id,
                keyring_ref,
            },
            &now,
        )
        .await?;
    }
    Ok(())
}

fn required_account(scope: &ActiveResourceScope) -> AppResult<&str> {
    scope
        .selected_account_id
        .as_deref()
        .ok_or_else(|| AppError::Blocked {
            reason: "provider credentials require an active workspace account".into(),
        })
}

async fn ensure_scope_current(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    scope: &ActiveResourceScope,
    account: &str,
) -> AppResult<()> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM app_settings workspace
         JOIN app_settings selected ON selected.key = 'active_workspace_account_id'
         JOIN app_settings generation ON generation.key = 'active_scope_generation'
         JOIN workspaces w ON w.id = workspace.value AND w.lifecycle_state = 'active'
         JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = selected.value
           AND m.status = 'active'
         WHERE workspace.key = 'active_workspace_id' AND workspace.value = ?1
           AND selected.value = ?2 AND generation.value = ?3",
    )
    .bind(scope.workspace_id.to_string())
    .bind(account)
    .bind(scope.generation.to_string())
    .fetch_optional(&mut **tx)
    .await?;
    found.ok_or_else(|| AppError::Blocked {
        reason: "workspace authority changed before provider credential commit".into(),
    })?;
    Ok(())
}
