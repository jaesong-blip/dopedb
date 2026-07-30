//! Secret-free authority and local credential resolution for imported providers.
//!
//! The control plane supplies only a narrow, expiring resource target.  A
//! provider feature supplies the local resolver and may return either the
//! profile's OS-keyring secret or an ephemeral zeroizing secret.  Neither the
//! runtime cache nor the remote authority contract can carry a credential.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use chrono::{DateTime, Utc};
use zeroize::Zeroizing;

use super::cloud_sql_proxy::CloudSqlProxyConfig;
use crate::error::{AppError, AppResult};
use crate::kernel::identity::{
    AccountId, ConnectionId, ProviderBindingId, ProviderIntegrationId, WorkspaceId,
};
use crate::model::{ConnectionProfile, Engine, Provider};

pub(crate) type ProviderLocalFuture<'a, T> =
    Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'a>>;

/// A canonical, read-only target returned by the workspace authority endpoint.
/// It deliberately contains no credential, endpoint, or provider response body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderLocalTarget {
    pub(crate) connection_id: ConnectionId,
    pub(crate) connection_revision: i64,
    pub(crate) integration_id: ProviderIntegrationId,
    pub(crate) integration_generation: i64,
    pub(crate) provider: Provider,
    pub(crate) resource_fingerprint: String,
    pub(crate) resource: ProviderLocalResource,
    pub(crate) expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProviderLocalResource {
    Neon {
        project: String,
        branch: String,
        database: String,
        schemas: Vec<String>,
    },
    GcpCloudSql {
        project: String,
        instance: String,
        database: String,
        engine: Engine,
        network_mode: GcpCloudSqlNetworkMode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GcpCloudSqlNetworkMode {
    PrivateServicesAccess,
    Public,
    PrivateServiceConnect,
}

impl ProviderLocalTarget {
    pub(crate) fn cache_retire_after(&self) -> AppResult<Duration> {
        let seconds = self
            .expires_at
            .signed_duration_since(Utc::now())
            .num_seconds();
        if !(30..=(5 * 60 + 5)).contains(&seconds) {
            return Err(AppError::Network(
                "provider-local target authority returned an unsafe expiry".into(),
            ));
        }
        // Do not return a pool to a caller during the authority's final safety
        // margin.  The remaining minimum is still positive after validation.
        Ok(Duration::from_secs(seconds as u64).saturating_sub(Duration::from_secs(15)))
    }

    pub(crate) fn target_database(&self) -> &str {
        match &self.resource {
            ProviderLocalResource::Neon { database, .. }
            | ProviderLocalResource::GcpCloudSql { database, .. } => database,
        }
    }

    /// An in-memory cache discriminator. The fingerprint is authoritative, but
    /// retaining the canonical target identity as well makes a malformed or
    /// partially rolled-back authority response unable to reuse a pool for a
    /// different endpoint under the same fingerprint.
    pub(crate) fn cache_identity(&self) -> String {
        fn append(value: &mut String, part: &str) {
            value.push_str(&part.len().to_string());
            value.push(':');
            value.push_str(part);
        }
        let mut identity = String::new();
        match &self.resource {
            ProviderLocalResource::Neon {
                project,
                branch,
                database,
                schemas,
            } => {
                identity.push_str("neon;");
                append(&mut identity, project);
                append(&mut identity, branch);
                append(&mut identity, database);
                for schema in schemas {
                    append(&mut identity, schema);
                }
            }
            ProviderLocalResource::GcpCloudSql {
                project,
                instance,
                database,
                engine,
                network_mode,
            } => {
                identity.push_str("gcp;");
                append(&mut identity, project);
                append(&mut identity, instance);
                append(&mut identity, database);
                identity.push_str(match engine {
                    Engine::Postgres => "postgres;",
                    Engine::Mysql => "mysql;",
                    Engine::Sqlite | Engine::Mongodb => "invalid;",
                });
                identity.push_str(match network_mode {
                    GcpCloudSqlNetworkMode::PrivateServicesAccess => "psa",
                    GcpCloudSqlNetworkMode::Public => "public",
                    GcpCloudSqlNetworkMode::PrivateServiceConnect => "private-service-connect",
                });
            }
        }
        identity
    }
}

/// The only secret carrier accepted by the connection runtime.  It intentionally
/// implements neither Debug, Clone, nor serde traits.
#[allow(dead_code)] // constructed by the provider feature composition boundary
pub(crate) enum ProviderLocalSecret {
    ProfileSecret,
    Ephemeral(Zeroizing<String>),
}

/// A resolver may only narrow the network fields of a cloned profile.  The
/// runtime validates this result again before opening a pool.
pub(crate) struct ResolvedProviderLocalConnection {
    pub(crate) profile: ConnectionProfile,
    pub(crate) secret: ProviderLocalSecret,
    pub(crate) cloud_sql_proxy: Option<CloudSqlProxyConfig>,
}

/// A local provider authority snapshot.  It is returned by the provider feature
/// before every pool hand-off and carries no credential or keyring reference.
///
/// The binding id and revision prevent a cache entry authorized for one account,
/// workspace, integration generation, or local credential rotation from being
/// reused for another.  This is intentionally not `Debug` or serializable.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ProviderLocalBindingPin {
    pub(crate) binding_id: ProviderBindingId,
    pub(crate) binding_revision: i64,
    pub(crate) account_id: AccountId,
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) integration_id: ProviderIntegrationId,
    pub(crate) integration_generation: i64,
    pub(crate) provider: Provider,
    pub(crate) resource_fingerprint: String,
}

impl ProviderLocalBindingPin {
    pub(crate) fn matches_target(
        &self,
        account_id: &AccountId,
        workspace_id: WorkspaceId,
        target: &ProviderLocalTarget,
    ) -> bool {
        self.binding_revision > 0
            && self.account_id == *account_id
            && self.workspace_id == workspace_id
            && self.integration_id == target.integration_id
            && self.integration_generation == target.integration_generation
            && self.provider == target.provider
            && self.resource_fingerprint == target.resource_fingerprint
    }
}

/// Secret-free request used to validate an existing local provider binding.
#[allow(dead_code)] // read by the provider feature composition boundary
pub(crate) struct ProviderLocalPinRequest<'a> {
    pub(crate) account_id: &'a AccountId,
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) profile: &'a ConnectionProfile,
    pub(crate) authority: &'a ProviderLocalTarget,
}

#[allow(dead_code)] // consumed by a provider feature implementation, never serialized here
pub(crate) struct ProviderLocalResolveRequest<'a> {
    pub(crate) account_id: &'a AccountId,
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) profile: &'a ConnectionProfile,
    pub(crate) authority: &'a ProviderLocalTarget,
    pub(crate) binding_pin: &'a ProviderLocalBindingPin,
}

/// Provider feature port.  The runtime never imports a provider verifier or
/// keyring implementation directly, which keeps local credential material out of
/// the control-plane and cache layers.
pub(crate) trait ProviderLocalConnectionPort: Send + Sync {
    fn authorize_binding<'a>(
        &'a self,
        request: ProviderLocalPinRequest<'a>,
    ) -> ProviderLocalFuture<'a, ProviderLocalBindingPin>;

    fn resolve<'a>(
        &'a self,
        request: ProviderLocalResolveRequest<'a>,
    ) -> ProviderLocalFuture<'a, ResolvedProviderLocalConnection>;
}
