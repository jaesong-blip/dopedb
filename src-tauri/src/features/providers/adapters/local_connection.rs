//! Provider-local connection resolution with a secret-free binding hand-off.
//!
//! Provider metadata is obtained only through an audited official CLI. Neon has
//! no supported local management CLI, so Neon connections use the workspace's
//! managed-lease path instead of reading an API key in Desktop.

use crate::connection::{
    CloudSqlProxyConfig, ProviderLocalBindingPin, ProviderLocalConnectionPort, ProviderLocalFuture,
    ProviderLocalPinRequest, ProviderLocalResolveRequest, ProviderLocalResource,
    ProviderLocalSecret, ResolvedProviderLocalConnection,
};
use crate::error::{AppError, AppResult};
use crate::model::Provider;

use super::super::domain::LocalProvider;
use super::gcp_adc;
use super::sqlite_repository::SqliteProviderBindingRepository;

/// Production implementation of the runtime's provider-local port.
#[derive(Clone)]
pub(crate) struct ProviderLocalResolver {
    repository: SqliteProviderBindingRepository,
}

impl ProviderLocalResolver {
    pub(crate) fn new(repository: SqliteProviderBindingRepository) -> Self {
        Self { repository }
    }

    async fn pin(
        &self,
        request: &ProviderLocalPinRequest<'_>,
    ) -> AppResult<ProviderLocalBindingPin> {
        let provider = local_provider(request.profile.provider)?;
        if request.authority.provider != request.profile.provider
            || request.authority.integration_generation < 1
            || request.authority.resource_fingerprint.len() != 64
            || !request
                .authority
                .resource_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(blocked());
        }
        let scope = self.repository.current_scope().await?;
        if scope.account_id != *request.account_id || scope.workspace_id != request.workspace_id {
            return Err(blocked());
        }
        let row = self
            .repository
            .local_binding(
                &scope,
                provider,
                request.authority.integration_id,
                &request.authority.integration_generation.to_string(),
            )
            .await?;
        if row.revision < 1 || row.tombstoned_at.is_some() || row.delete_pending {
            return Err(blocked());
        }
        Ok(ProviderLocalBindingPin {
            binding_id: row.binding_id.into(),
            binding_revision: row.revision,
            account_id: request.account_id.clone(),
            workspace_id: request.workspace_id,
            integration_id: request.authority.integration_id,
            integration_generation: request.authority.integration_generation,
            provider: request.authority.provider,
            resource_fingerprint: request.authority.resource_fingerprint.clone(),
        })
    }

    async fn resolve_connection(
        &self,
        request: &ProviderLocalResolveRequest<'_>,
    ) -> AppResult<ResolvedProviderLocalConnection> {
        let pin = self
            .pin(&ProviderLocalPinRequest {
                account_id: request.account_id,
                workspace_id: request.workspace_id,
                profile: request.profile,
                authority: request.authority,
            })
            .await?;
        if pin != *request.binding_pin {
            return Err(blocked());
        }
        // A provider API credential is never a database credential. Refuse a
        // member-local target before either provider API is contacted when the
        // member's own OS-keyring database binding is absent.
        if request
            .profile
            .secret_ref
            .as_deref()
            .is_none_or(str::is_empty)
        {
            return Err(blocked());
        }
        let provider = local_provider(request.profile.provider)?;
        let scope = self.repository.current_scope().await?;
        if scope.account_id != *request.account_id || scope.workspace_id != request.workspace_id {
            return Err(blocked());
        }
        let row = self
            .repository
            .local_binding(
                &scope,
                provider,
                request.authority.integration_id,
                &request.authority.integration_generation.to_string(),
            )
            .await?;
        if row.binding_id != uuid::Uuid::from(request.binding_pin.binding_id)
            || row.revision != request.binding_pin.binding_revision
            || row.tombstoned_at.is_some()
            || row.delete_pending
        {
            return Err(blocked());
        }
        let mut profile = request.profile.clone();
        let cloud_sql_proxy = match &request.authority.resource {
            ProviderLocalResource::Neon { .. } => return Err(blocked()),
            ProviderLocalResource::GcpCloudSql {
                project,
                instance,
                database,
                engine,
                network_mode,
            } => {
                if row.keyring_ref.is_some() || *engine != request.profile.engine {
                    return Err(blocked());
                }
                let settings = gcp_adc::resolve_cloud_sql_connect_settings(
                    project,
                    instance,
                    database,
                    *engine,
                    *network_mode,
                )
                .await?;
                profile.host = settings.host;
                profile.port = settings.port;
                profile.database = database.clone();
                profile.sslmode = settings.sslmode;
                profile
                    .extra_params
                    .insert("sslrootcert_pem".into(), settings.server_ca_pem);
                Some(CloudSqlProxyConfig {
                    instance_connection_name: settings.instance_connection_name,
                    access_token: settings.access_token,
                    network_mode: *network_mode,
                })
            }
        };
        Ok(ResolvedProviderLocalConnection {
            profile,
            // The runtime retrieves the account-scoped database secret only
            // after this local/provider resolution has succeeded.
            secret: ProviderLocalSecret::ProfileSecret,
            cloud_sql_proxy,
        })
    }
}

impl ProviderLocalConnectionPort for ProviderLocalResolver {
    fn authorize_binding<'a>(
        &'a self,
        request: ProviderLocalPinRequest<'a>,
    ) -> ProviderLocalFuture<'a, ProviderLocalBindingPin> {
        Box::pin(async move { self.pin(&request).await })
    }

    fn resolve<'a>(
        &'a self,
        request: ProviderLocalResolveRequest<'a>,
    ) -> ProviderLocalFuture<'a, ResolvedProviderLocalConnection> {
        Box::pin(async move { self.resolve_connection(&request).await })
    }
}

fn blocked() -> AppError {
    AppError::Blocked {
        reason: "provider-local connection resolution is unavailable".into(),
    }
}

fn local_provider(provider: Provider) -> AppResult<LocalProvider> {
    match provider {
        Provider::GcpCloudSql => Ok(LocalProvider::GcpCloudSql),
        _ => Err(blocked()),
    }
}
