//! Active-scope and revision-fenced SQLite provisioning receipt repository.

use chrono::{DateTime, Utc};
use sqlx::{AssertSqlSafe, Row};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::WorkspaceId;
use crate::store::{ActiveResourceScope, Store};

use super::domain::ProvisioningReceipt;

const ACTIVE_SCOPE: &str = r#"
EXISTS (
    SELECT 1
    FROM app_settings workspace
    JOIN workspaces w
      ON w.id = workspace.value
     AND w.lifecycle_state = 'active'
    JOIN app_settings generation
      ON generation.key = 'active_scope_generation'
    LEFT JOIN app_settings account
      ON account.key = 'active_workspace_account_id'
    WHERE workspace.key = 'active_workspace_id'
      AND workspace.value = ?
      AND generation.value = ?
      AND (
          (w.kind = 'personal' AND ? = 'personal')
          OR (
              w.kind = 'team'
              AND account.value = ?
              AND EXISTS (
                  SELECT 1 FROM workspace_members member
                  WHERE member.workspace_id = w.id
                    AND member.user_id = account.value
                    AND member.status = 'active'
              )
          )
      )
)
"#;

#[derive(Clone)]
pub(super) struct ProvisioningReceiptRepository {
    store: Store,
}

impl ProvisioningReceiptRepository {
    pub(super) fn new(store: Store) -> Self {
        Self { store }
    }

    pub(super) async fn create(
        &self,
        scope: &ActiveResourceScope,
        receipt: &ProvisioningReceipt,
    ) -> AppResult<ProvisioningReceipt> {
        receipt.validate()?;
        ensure_receipt_scope(scope, receipt)?;
        if receipt.revision() != 1 {
            return Err(blocked(
                "new provider provisioning receipt has an invalid revision",
            ));
        }
        let snapshot = receipt.encode_snapshot()?;
        let query = format!(
            "INSERT INTO provider_provisioning_receipts (
                 receipt_id, workspace_id, account_scope, connection_id, operation_id,
                 provider, target_fingerprint, plan_hash, idempotency_key, ownership_marker,
                 state, phase, completed_steps, revision, snapshot_json, created_at, updated_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE {ACTIVE_SCOPE}
             ON CONFLICT DO NOTHING"
        );
        // The only dynamic composition is the audited, source-constant active
        // scope predicate above; no identifier or user value enters the SQL.
        let result = sqlx::query(AssertSqlSafe(query))
            .bind(receipt.id().to_string())
            .bind(receipt.workspace_id().to_string())
            .bind(receipt.account_scope())
            .bind(Uuid::from(receipt.connection_id()).to_string())
            .bind(receipt.operation_id().to_string())
            .bind(receipt.provider().storage_key())
            .bind(receipt.target_fingerprint())
            .bind(receipt.plan_hash())
            .bind(receipt.idempotency_key())
            .bind(receipt.ownership_marker())
            .bind(receipt.state().storage_key())
            .bind(receipt.phase().storage_key())
            .bind(i64::from(receipt.completed_steps()))
            .bind(revision_i64(receipt.revision())?)
            .bind(&snapshot)
            .bind(receipt.created_at().to_rfc3339())
            .bind(receipt.updated_at().to_rfc3339())
            .bind(receipt.workspace_id().to_string())
            .bind(scope.generation.to_string())
            .bind(receipt.account_scope())
            .bind(receipt.account_scope())
            .execute(self.store.pool())
            .await?;
        if result.rows_affected() == 1 {
            return Ok(receipt.clone());
        }
        let existing = self
            .load_for_target(
                scope,
                receipt.provider().storage_key(),
                receipt.target_fingerprint(),
            )
            .await?;
        if existing.plan_hash() == receipt.plan_hash()
            && existing.idempotency_key() == receipt.idempotency_key()
            && existing.ownership_marker() == receipt.ownership_marker()
        {
            Ok(existing)
        } else {
            Err(blocked(
                "a different provider provisioning plan already owns this target",
            ))
        }
    }

    pub(super) async fn load(
        &self,
        scope: &ActiveResourceScope,
        receipt_id: Uuid,
    ) -> AppResult<ProvisioningReceipt> {
        let query = format!(
            "SELECT * FROM provider_provisioning_receipts
             WHERE receipt_id = ? AND workspace_id = ? AND account_scope = ?
               AND {ACTIVE_SCOPE}"
        );
        let row = sqlx::query(AssertSqlSafe(query))
            .bind(receipt_id.to_string())
            .bind(scope.workspace_id.to_string())
            .bind(scope.account_scope.storage_key())
            .bind(scope.workspace_id.to_string())
            .bind(scope.generation.to_string())
            .bind(scope.account_scope.storage_key())
            .bind(scope.account_scope.storage_key())
            .fetch_optional(self.store.pool())
            .await?
            .ok_or_else(|| blocked("provider provisioning receipt is unavailable"))?;
        decode_row(&row)
    }

    pub(super) async fn load_for_operation(
        &self,
        scope: &ActiveResourceScope,
        operation_id: Uuid,
    ) -> AppResult<ProvisioningReceipt> {
        let query = format!(
            "SELECT * FROM provider_provisioning_receipts
             WHERE operation_id = ? AND workspace_id = ? AND account_scope = ?
               AND {ACTIVE_SCOPE}"
        );
        let row = sqlx::query(AssertSqlSafe(query))
            .bind(operation_id.to_string())
            .bind(scope.workspace_id.to_string())
            .bind(scope.account_scope.storage_key())
            .bind(scope.workspace_id.to_string())
            .bind(scope.generation.to_string())
            .bind(scope.account_scope.storage_key())
            .bind(scope.account_scope.storage_key())
            .fetch_optional(self.store.pool())
            .await?
            .ok_or_else(|| blocked("provider provisioning receipt is unavailable"))?;
        decode_row(&row)
    }

    pub(super) async fn list_for_connection(
        &self,
        scope: &ActiveResourceScope,
        connection_id: Uuid,
    ) -> AppResult<Vec<ProvisioningReceipt>> {
        let query = format!(
            "SELECT * FROM provider_provisioning_receipts
             WHERE connection_id = ? AND workspace_id = ? AND account_scope = ?
               AND {ACTIVE_SCOPE}
             ORDER BY updated_at DESC, receipt_id ASC
             LIMIT 64"
        );
        let rows = sqlx::query(AssertSqlSafe(query))
            .bind(connection_id.to_string())
            .bind(scope.workspace_id.to_string())
            .bind(scope.account_scope.storage_key())
            .bind(scope.workspace_id.to_string())
            .bind(scope.generation.to_string())
            .bind(scope.account_scope.storage_key())
            .bind(scope.account_scope.storage_key())
            .fetch_all(self.store.pool())
            .await?;
        rows.iter().map(decode_row).collect()
    }

    pub(super) async fn save(
        &self,
        scope: &ActiveResourceScope,
        receipt: &ProvisioningReceipt,
        expected_revision: u64,
    ) -> AppResult<()> {
        receipt.validate()?;
        ensure_receipt_scope(scope, receipt)?;
        if receipt.revision() != expected_revision.saturating_add(1) {
            return Err(blocked("provider provisioning receipt revision is invalid"));
        }
        let snapshot = receipt.encode_snapshot()?;
        let query = format!(
            "UPDATE provider_provisioning_receipts
             SET operation_id = ?, plan_hash = ?, idempotency_key = ?, state = ?, phase = ?,
                 completed_steps = ?, revision = ?, snapshot_json = ?, updated_at = ?
             WHERE receipt_id = ? AND workspace_id = ? AND account_scope = ?
               AND provider = ? AND target_fingerprint = ? AND ownership_marker = ?
               AND revision = ? AND {ACTIVE_SCOPE}"
        );
        let result = sqlx::query(AssertSqlSafe(query))
            .bind(receipt.operation_id().to_string())
            .bind(receipt.plan_hash())
            .bind(receipt.idempotency_key())
            .bind(receipt.state().storage_key())
            .bind(receipt.phase().storage_key())
            .bind(i64::from(receipt.completed_steps()))
            .bind(revision_i64(receipt.revision())?)
            .bind(snapshot)
            .bind(receipt.updated_at().to_rfc3339())
            .bind(receipt.id().to_string())
            .bind(receipt.workspace_id().to_string())
            .bind(receipt.account_scope())
            .bind(receipt.provider().storage_key())
            .bind(receipt.target_fingerprint())
            .bind(receipt.ownership_marker())
            .bind(revision_i64(expected_revision)?)
            .bind(receipt.workspace_id().to_string())
            .bind(scope.generation.to_string())
            .bind(receipt.account_scope())
            .bind(receipt.account_scope())
            .execute(self.store.pool())
            .await?;
        if result.rows_affected() == 1 {
            Ok(())
        } else {
            Err(blocked(
                "provider provisioning scope or receipt revision changed",
            ))
        }
    }

    async fn load_for_target(
        &self,
        scope: &ActiveResourceScope,
        provider: &str,
        target_fingerprint: &str,
    ) -> AppResult<ProvisioningReceipt> {
        let query = format!(
            "SELECT * FROM provider_provisioning_receipts
             WHERE workspace_id = ? AND account_scope = ? AND provider = ?
               AND target_fingerprint = ? AND {ACTIVE_SCOPE}"
        );
        let row = sqlx::query(AssertSqlSafe(query))
            .bind(scope.workspace_id.to_string())
            .bind(scope.account_scope.storage_key())
            .bind(provider)
            .bind(target_fingerprint)
            .bind(scope.workspace_id.to_string())
            .bind(scope.generation.to_string())
            .bind(scope.account_scope.storage_key())
            .bind(scope.account_scope.storage_key())
            .fetch_optional(self.store.pool())
            .await?
            .ok_or_else(|| blocked("provider provisioning receipt is unavailable"))?;
        decode_row(&row)
    }
}

fn decode_row(row: &sqlx::sqlite::SqliteRow) -> AppResult<ProvisioningReceipt> {
    let receipt = ProvisioningReceipt::decode_snapshot(row.try_get("snapshot_json")?)?;
    let stored_created = timestamp(row.try_get("created_at")?)?;
    let stored_updated = timestamp(row.try_get("updated_at")?)?;
    let exact = row.try_get::<String, _>("receipt_id")? == receipt.id().to_string()
        && row.try_get::<String, _>("workspace_id")? == receipt.workspace_id().to_string()
        && row.try_get::<String, _>("account_scope")? == receipt.account_scope()
        && row.try_get::<String, _>("connection_id")?
            == Uuid::from(receipt.connection_id()).to_string()
        && row.try_get::<String, _>("operation_id")? == receipt.operation_id().to_string()
        && row.try_get::<String, _>("provider")? == receipt.provider().storage_key()
        && row.try_get::<String, _>("target_fingerprint")? == receipt.target_fingerprint()
        && row.try_get::<String, _>("plan_hash")? == receipt.plan_hash()
        && row.try_get::<String, _>("idempotency_key")? == receipt.idempotency_key()
        && row.try_get::<String, _>("ownership_marker")? == receipt.ownership_marker()
        && row.try_get::<String, _>("state")? == receipt.state().storage_key()
        && row.try_get::<String, _>("phase")? == receipt.phase().storage_key()
        && row.try_get::<i64, _>("completed_steps")? == i64::from(receipt.completed_steps())
        && row.try_get::<i64, _>("revision")? == revision_i64(receipt.revision())?
        && stored_created == receipt.created_at()
        && stored_updated == receipt.updated_at();
    if exact {
        Ok(receipt)
    } else {
        Err(AppError::Config(
            "provider provisioning receipt projection is inconsistent".into(),
        ))
    }
}

fn ensure_receipt_scope(
    scope: &ActiveResourceScope,
    receipt: &ProvisioningReceipt,
) -> AppResult<()> {
    if receipt.workspace_id() == WorkspaceId::from(scope.workspace_id)
        && receipt.account_scope() == scope.account_scope.storage_key()
    {
        Ok(())
    } else {
        Err(blocked(
            "provider provisioning receipt belongs to another scope",
        ))
    }
}

fn revision_i64(value: u64) -> AppResult<i64> {
    i64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| blocked("provider provisioning receipt revision is invalid"))
}

fn timestamp(value: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| AppError::Config("invalid provider provisioning timestamp".into()))
}

fn blocked(reason: &'static str) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
}

#[cfg(test)]
pub(crate) async fn assert_repository_fences() {
    use crate::features::providers::provisioning::domain::{
        fixture_plan, ManagedAccessCapability, ProvisioningCapabilityManifest, ProvisioningIntent,
    };
    use crate::features::workspaces::WorkspaceKind;
    use crate::kernel::identity::ConnectionId;
    use crate::store::AccountScope;

    use ManagedAccessCapability::{
        Apply, Destroy, Detect, Discover, Issue, Plan, Reconcile, Verify,
    };

    let store = Store::in_memory_for_test()
        .await
        .expect("open isolated provisioning store");
    let workspace_id = Uuid::from_u128(1);
    let scope = ActiveResourceScope {
        workspace_id,
        workspace_kind: WorkspaceKind::Personal,
        selected_account_id: None,
        account_scope: AccountScope::Personal,
        generation: 0,
    };
    let plan = fixture_plan(
        ProvisioningIntent::Apply,
        ProvisioningCapabilityManifest::new([
            Detect, Discover, Plan, Apply, Verify, Issue, Reconcile, Destroy,
        ]),
    );
    let operation_id = Uuid::from_u128(30);
    let now = Utc::now();
    let mut receipt = ProvisioningReceipt::ready_to_apply(
        WorkspaceId::from(workspace_id),
        AccountScope::Personal.storage_key().into(),
        ConnectionId::from(Uuid::from_u128(31)),
        operation_id,
        &plan,
        now,
    )
    .expect("create provisioning receipt");
    let repository = ProvisioningReceiptRepository::new(store.clone());
    let created = repository
        .create(&scope, &receipt)
        .await
        .expect("persist provisioning receipt");
    assert_eq!(created, receipt);

    receipt
        .begin_apply(&plan, operation_id, now)
        .expect("begin approved plan");
    repository
        .save(&scope, &receipt, 1)
        .await
        .expect("advance with the exact revision");
    assert_eq!(
        repository
            .load(&scope, receipt.id())
            .await
            .expect("reload receipt"),
        receipt
    );
    assert!(repository.save(&scope, &receipt, 1).await.is_err());

    sqlx::query("UPDATE app_settings SET value = '1' WHERE key = 'active_scope_generation'")
        .execute(store.pool())
        .await
        .expect("advance active scope generation");
    assert!(repository.load(&scope, receipt.id()).await.is_err());

    let current_scope = ActiveResourceScope {
        generation: 1,
        ..scope
    };
    assert_eq!(
        repository
            .load(&current_scope, receipt.id())
            .await
            .expect("same resource is visible only through the current generation"),
        receipt
    );
}
