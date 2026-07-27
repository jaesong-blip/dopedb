//! Bounded one-use provider credential receipt registry.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{DeviceId, ProviderBindingId, ProviderCredentialReceiptId};
use crate::kernel::sync::lock_unpoisoned;

use super::super::domain::{ProviderBindingScope, ProviderCredentialReceipt, ProviderScope};
use super::super::ports::ProviderReceiptRegistry;

const TTL: Duration = Duration::minutes(5);
const CAPACITY: usize = 256;

#[derive(Clone)]
struct Entry {
    binding: ProviderBindingScope,
    device_id: DeviceId,
    staged_binding_id: ProviderBindingId,
    expires_at: DateTime<Utc>,
}

/// One process-local owner for staged provider credentials. Dropping this value
/// intentionally invalidates all receipts after restart.
#[derive(Clone, Default)]
pub(crate) struct InMemoryProviderReceiptRegistry {
    entries: Arc<Mutex<HashMap<ProviderCredentialReceiptId, Entry>>>,
}

impl ProviderReceiptRegistry for InMemoryProviderReceiptRegistry {
    fn drain_expired(&self, now: DateTime<Utc>) -> Vec<(ProviderBindingScope, ProviderBindingId)> {
        let mut entries = lock_unpoisoned(&self.entries);
        let expired = entries
            .iter()
            .filter_map(|(id, entry)| (entry.expires_at <= now).then_some(*id))
            .collect::<Vec<_>>();
        expired
            .into_iter()
            .filter_map(|id| {
                entries
                    .remove(&id)
                    .map(|entry| (entry.binding, entry.staged_binding_id))
            })
            .collect()
    }

    fn issue(
        &self,
        binding: ProviderBindingScope,
        device_id: DeviceId,
        staged_binding_id: ProviderBindingId,
        now: DateTime<Utc>,
    ) -> AppResult<ProviderCredentialReceipt> {
        let mut entries = lock_unpoisoned(&self.entries);
        if entries.len() >= CAPACITY {
            return Err(AppError::Blocked {
                reason: "too many pending provider credential receipts".into(),
            });
        }
        let receipt_id = ProviderCredentialReceiptId::from(Uuid::new_v4());
        let expires_at = now + TTL;
        entries.insert(
            receipt_id,
            Entry {
                binding,
                device_id,
                staged_binding_id,
                expires_at,
            },
        );
        Ok(ProviderCredentialReceipt {
            receipt_id,
            expires_at,
        })
    }

    fn claim(
        &self,
        id: ProviderCredentialReceiptId,
        device_id: DeviceId,
        now: DateTime<Utc>,
    ) -> AppResult<(ProviderBindingScope, ProviderBindingId)> {
        let mut entries = lock_unpoisoned(&self.entries);
        let entry = entries.get(&id).ok_or_else(|| AppError::Blocked {
            reason: "provider credential receipt is expired or already used".into(),
        })?;
        if entry.expires_at <= now {
            let _ = entries.remove(&id);
            return Err(AppError::Blocked {
                reason: "provider credential receipt is expired or already used".into(),
            });
        }
        if entry.device_id != device_id {
            // A foreign receipt can neither read nor claim the staged item. It
            // remains available only to its exact owner until TTL cleanup.
            return Err(AppError::Blocked {
                reason: "provider credential receipt is invalid".into(),
            });
        }
        let entry = entries.remove(&id).expect("entry checked above");
        Ok((entry.binding, entry.staged_binding_id))
    }

    fn clear_scope(
        &self,
        scope: Option<&ProviderScope>,
    ) -> Vec<(ProviderBindingScope, ProviderBindingId)> {
        let mut entries = lock_unpoisoned(&self.entries);
        let ids = entries
            .iter()
            .filter_map(|(id, entry)| {
                scope
                    .is_none_or(|scope| &entry.binding.scope == scope)
                    .then_some(*id)
            })
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| {
                entries
                    .remove(&id)
                    .map(|entry| (entry.binding, entry.staged_binding_id))
            })
            .collect()
    }
}
