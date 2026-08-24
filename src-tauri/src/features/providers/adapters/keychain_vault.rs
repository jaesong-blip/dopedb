//! Provider-only Keychain/Credential Manager vault with no debug file fallback.

use keyring::Entry;

use crate::error::{AppError, AppResult};

use super::super::domain::ProviderCredentialCleanup;
use super::super::ports::ProviderCredentialVault;

#[cfg(feature = "packaged-benchmark")]
const SERVICE: &str = "dev.dopedb.desktop.benchmark";
#[cfg(all(debug_assertions, not(feature = "packaged-benchmark")))]
const SERVICE: &str = "dev.dopedb.desktop.dev";
#[cfg(all(not(debug_assertions), not(feature = "packaged-benchmark")))]
const SERVICE: &str = "dev.dopedb.desktop";

/// Production credential vault. It deliberately never invokes the connection
/// keychain module, whose debug fallback is forbidden for provider API keys.
#[derive(Clone, Default)]
pub(crate) struct KeyringProviderCredentialVault;

impl KeyringProviderCredentialVault {
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
    fn delete(&self, cleanup: &ProviderCredentialCleanup) -> AppResult<()> {
        let account = Self::cleanup_account(cleanup);
        match Self::entry(&account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}
