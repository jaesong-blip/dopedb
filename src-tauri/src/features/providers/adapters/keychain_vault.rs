//! Provider-only Keychain/Credential Manager vault with no debug file fallback.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use keyring::Entry;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::ProviderBindingId;
use crate::kernel::sync::lock_unpoisoned;

use super::super::domain::{ProviderBindingScope, ProviderCredentialCleanup, ProviderScope};
use super::super::ports::ProviderCredentialVault;

const SERVICE: &str = "dev.dopedb.desktop";
const CACHE_CAPACITY: usize = 64;

#[derive(Default)]
struct Cache {
    values: HashMap<String, Zeroizing<String>>,
    order: VecDeque<String>,
}

impl Cache {
    fn remember(&mut self, account: String, secret: &str) {
        self.values
            .insert(account.clone(), Zeroizing::new(secret.to_owned()));
        self.order.retain(|existing| existing != &account);
        self.order.push_back(account);
        while self.order.len() > CACHE_CAPACITY {
            if let Some(evicted) = self.order.pop_front() {
                self.values.remove(&evicted);
            }
        }
    }

    fn forget_scope(&mut self, scope: Option<&ProviderScope>) {
        let prefix = scope.map(|scope| {
            format!(
                "provider-credential:v1:{}:{}:",
                scope.account_id, scope.workspace_id
            )
        });
        self.values.retain(|account, _| {
            prefix
                .as_ref()
                .is_none_or(|prefix| !account.starts_with(prefix))
        });
        self.order
            .retain(|account| self.values.contains_key(account));
    }
}

/// Production credential vault. It deliberately never invokes the connection
/// keychain module, whose debug fallback is forbidden for provider API keys.
#[derive(Clone, Default)]
pub(crate) struct KeyringProviderCredentialVault {
    cache: Arc<Mutex<Cache>>,
}

impl KeyringProviderCredentialVault {
    fn account(scope: &ProviderBindingScope, id: ProviderBindingId) -> String {
        format!(
            "provider-credential:v1:{}:{}:{}:{}:{}:{}",
            scope.scope.account_id,
            scope.scope.workspace_id,
            scope.provider.storage_key(),
            scope.integration_id,
            scope.integration_generation,
            id
        )
    }

    fn entry(account: &str) -> AppResult<Entry> {
        Entry::new(SERVICE, account).map_err(AppError::from)
    }

    fn cleanup_account(cleanup: &ProviderCredentialCleanup) -> String {
        format!(
            "provider-credential:v1:{}:{}:{}:{}:{}:{}",
            cleanup.scope.account_id,
            cleanup.scope.workspace_id,
            cleanup.provider.storage_key(),
            cleanup.integration_id,
            cleanup.integration_generation,
            cleanup.keyring_ref
        )
    }
}

impl ProviderCredentialVault for KeyringProviderCredentialVault {
    fn store(
        &self,
        scope: &ProviderBindingScope,
        id: ProviderBindingId,
        secret: &str,
    ) -> AppResult<()> {
        let account = Self::account(scope, id);
        // Holding this tiny lock across an OS-store call is intentional: it is
        // a per-process single-flight that prevents repeated macOS prompts.
        let mut cache = lock_unpoisoned(&self.cache);
        Self::entry(&account)?.set_password(secret)?;
        cache.remember(account, secret);
        Ok(())
    }

    fn fetch(
        &self,
        scope: &ProviderBindingScope,
        id: ProviderBindingId,
    ) -> AppResult<Zeroizing<String>> {
        let account = Self::account(scope, id);
        let mut cache = lock_unpoisoned(&self.cache);
        if let Some(secret) = cache.values.get(&account) {
            return Ok(Zeroizing::new(secret.as_str().to_owned()));
        }
        let secret = Self::entry(&account)?
            .get_password()
            .map_err(|error| match error {
                keyring::Error::NoEntry => {
                    AppError::NotFound("provider credential is unavailable".into())
                }
                other => other.into(),
            })?;
        cache.remember(account, &secret);
        Ok(Zeroizing::new(secret))
    }

    fn delete(&self, cleanup: &ProviderCredentialCleanup) -> AppResult<()> {
        let account = Self::cleanup_account(cleanup);
        let mut cache = lock_unpoisoned(&self.cache);
        cache.values.remove(&account);
        cache.order.retain(|existing| existing != &account);
        match Self::entry(&account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn clear_scope(&self, scope: Option<&ProviderScope>) {
        lock_unpoisoned(&self.cache).forget_scope(scope);
    }
}

#[cfg(test)]
impl KeyringProviderCredentialVault {
    pub(super) fn account_for_test(scope: &ProviderBindingScope, id: ProviderBindingId) -> String {
        Self::account(scope, id)
    }
}
