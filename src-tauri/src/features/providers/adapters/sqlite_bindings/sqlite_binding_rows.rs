//! Typed projection of redacted provider-binding SQLite rows.

use sqlx::Row;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::{ProviderBindingRow, ProviderCleanupRow};

pub(super) fn row_to_binding(row: &sqlx::sqlite::SqliteRow) -> AppResult<ProviderBindingRow> {
    let parse = |name: &str| -> AppResult<Uuid> {
        Uuid::parse_str(row.try_get::<String, _>(name)?.as_str())
            .map_err(|_| AppError::Config(format!("invalid provider binding {name}")))
    };
    let keyring_ref = row
        .try_get::<Option<String>, _>("keyring_ref")?
        .map(|value| {
            Uuid::parse_str(&value)
                .map_err(|_| AppError::Config("invalid provider keyring reference".into()))
        })
        .transpose()?;
    Ok(ProviderBindingRow {
        binding_id: parse("binding_id")?,
        workspace_id: parse("workspace_id")?,
        account_user_id: row.try_get("account_user_id")?,
        provider: row.try_get("provider")?,
        integration_id: parse("integration_id")?,
        integration_generation: row.try_get("integration_generation")?,
        keyring_ref,
        principal_redacted: row.try_get("principal_redacted")?,
        scope_fingerprint: row.try_get("scope_fingerprint")?,
        verified_at: row.try_get("verified_at")?,
        revision: row.try_get("revision")?,
        tombstoned_at: row.try_get("tombstoned_at")?,
        delete_pending: row.try_get::<i64, _>("delete_pending")? != 0,
        updated_at: row.try_get("updated_at")?,
    })
}

pub(super) fn row_to_cleanup(row: &sqlx::sqlite::SqliteRow) -> AppResult<ProviderCleanupRow> {
    let parse = |name: &str| -> AppResult<Uuid> {
        Uuid::parse_str(row.try_get::<String, _>(name)?.as_str())
            .map_err(|_| AppError::Config(format!("invalid provider cleanup {name}")))
    };
    Ok(ProviderCleanupRow {
        workspace_id: parse("workspace_id")?,
        account_user_id: row.try_get("account_user_id")?,
        provider: row.try_get("provider")?,
        integration_id: parse("integration_id")?,
        integration_generation: row.try_get("integration_generation")?,
        binding_id: parse("binding_id")?,
        keyring_ref: parse("keyring_ref")?,
    })
}
