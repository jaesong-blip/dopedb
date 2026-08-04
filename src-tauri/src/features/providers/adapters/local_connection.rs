//! Provider-local connection resolution with a secret-free binding hand-off.
//!
//! The connection runtime first calls [`ProviderLocalResolver::authorize_binding`]
//! for every acquire.  Only a newly opened pool reaches `resolve`, where a
//! narrowly scoped provider API call may read the member's provider credential
//! from the OS keyring.  The returned value never contains that provider token.

use std::time::Duration;

use reqwest::{redirect::Policy, Client, Response, StatusCode, Url};
use serde_json::Value;

use crate::connection::{
    CloudSqlProxyConfig, ProviderLocalBindingPin, ProviderLocalConnectionPort, ProviderLocalFuture,
    ProviderLocalPinRequest, ProviderLocalResolveRequest, ProviderLocalResource,
    ProviderLocalSecret, ResolvedProviderLocalConnection,
};
use crate::error::{AppError, AppResult};
use crate::model::Provider;

use super::super::domain::{LocalProvider, ProviderBindingScope, ProviderScope};
use super::super::ports::ProviderCredentialVault;
use super::gcp_adc;
use super::sqlite_repository::SqliteProviderBindingRepository;
use super::KeyringProviderCredentialVault;

const MAX_PROVIDER_BODY_BYTES: usize = 64 * 1024;

/// Production implementation of the runtime's provider-local port.
#[derive(Clone)]
pub(crate) struct ProviderLocalResolver {
    repository: SqliteProviderBindingRepository,
    vault: KeyringProviderCredentialVault,
    client: Client,
}

impl ProviderLocalResolver {
    pub(crate) fn new(
        repository: SqliteProviderBindingRepository,
        vault: KeyringProviderCredentialVault,
    ) -> Self {
        Self {
            repository,
            vault,
            client: Client::builder()
                .redirect(Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .expect("provider-local HTTP client configuration is valid"),
        }
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
        if row.revision < 1
            || row.tombstoned_at.is_some()
            || row.delete_pending
            || (provider == LocalProvider::Neon && row.keyring_ref.is_none())
        {
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
        let binding = binding_scope(
            &scope,
            provider,
            request.authority,
            &row.integration_generation,
        );
        let mut profile = request.profile.clone();
        let mut cloud_sql_proxy = None;
        match &request.authority.resource {
            ProviderLocalResource::Neon {
                project,
                branch,
                database_id,
                database,
                ..
            } => {
                let Some(keyring_ref) = row.keyring_ref else {
                    return Err(blocked());
                };
                let key = self.vault.fetch(&binding, keyring_ref.into())?;
                let (endpoint, live_database) = self
                    .neon_endpoint(project, branch, database_id, database, &key)
                    .await?;
                profile.host = endpoint;
                profile.port = 5432;
                profile.database = live_database;
                profile.sslmode = "verify-full".into();
                profile.extra_params.remove("sslrootcert_pem");
            }
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
                cloud_sql_proxy = Some(CloudSqlProxyConfig {
                    instance_connection_name: settings.instance_connection_name,
                    access_token: settings.access_token,
                    network_mode: *network_mode,
                });
            }
        }
        Ok(ResolvedProviderLocalConnection {
            profile,
            // The runtime retrieves the account-scoped database secret only
            // after this local/provider resolution has succeeded.
            secret: ProviderLocalSecret::ProfileSecret,
            cloud_sql_proxy,
        })
    }

    async fn neon_endpoint(
        &self,
        project: &str,
        branch: &str,
        database_id: &str,
        database: &str,
        key: &zeroize::Zeroizing<String>,
    ) -> AppResult<(String, String)> {
        let databases = self
            .get_neon_json(&neon_url(project, branch, "databases")?, key)
            .await?;
        let live_database = validate_neon_database(&databases, database_id, database)?;
        let endpoints = self
            .get_neon_json(&neon_url(project, branch, "endpoints")?, key)
            .await?;
        Ok((parse_neon_read_endpoint(&endpoints)?, live_database))
    }

    async fn get_neon_json(&self, url: &Url, key: &zeroize::Zeroizing<String>) -> AppResult<Value> {
        let response = self
            .client
            .get(url.clone())
            .bearer_auth(key.as_str())
            .send()
            .await
            .map_err(|_| blocked())?;
        validate_response_meta(response.status(), response.content_length())?;
        parse_json(read_bounded(response).await?)
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
        Provider::Neon => Ok(LocalProvider::Neon),
        Provider::GcpCloudSql => Ok(LocalProvider::GcpCloudSql),
        _ => Err(blocked()),
    }
}

fn binding_scope(
    scope: &ProviderScope,
    provider: LocalProvider,
    authority: &crate::connection::ProviderLocalTarget,
    integration_generation: &str,
) -> ProviderBindingScope {
    ProviderBindingScope {
        scope: scope.clone(),
        provider,
        integration_id: authority.integration_id,
        integration_generation: integration_generation.to_owned(),
        // This value is not used to address the keyring.  Hosted authority
        // proof occurred when the binding was verified and the runtime gives
        // this resolver an exact current target separately.
        granted_scope: String::new(),
        verification_target: None,
    }
}

fn neon_url(project: &str, branch: &str, leaf: &str) -> AppResult<Url> {
    if !valid_neon_id(project)
        || !valid_neon_id(branch)
        || !matches!(leaf, "databases" | "endpoints")
    {
        return Err(blocked());
    }
    Url::parse(&format!(
        "https://console.neon.tech/api/v2/projects/{project}/branches/{branch}/{leaf}"
    ))
    .map_err(|_| blocked())
}

fn valid_neon_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

async fn read_bounded(mut response: Response) -> AppResult<Vec<u8>> {
    let mut body = Vec::with_capacity(4096);
    while let Some(chunk) = response.chunk().await.map_err(|_| blocked())? {
        append_bounded(&mut body, &chunk)?;
    }
    Ok(body)
}

fn validate_response_meta(status: StatusCode, content_length: Option<u64>) -> AppResult<()> {
    if !status.is_success()
        || content_length.is_some_and(|length| length > MAX_PROVIDER_BODY_BYTES as u64)
    {
        return Err(blocked());
    }
    Ok(())
}

fn append_bounded(body: &mut Vec<u8>, chunk: &[u8]) -> AppResult<()> {
    if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_BODY_BYTES {
        return Err(blocked());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn parse_json(body: Vec<u8>) -> AppResult<Value> {
    if body.len() > MAX_PROVIDER_BODY_BYTES || body.contains(&0) {
        return Err(blocked());
    }
    serde_json::from_slice(&body).map_err(|_| blocked())
}

fn validate_neon_database(value: &Value, database_id: &str, database: &str) -> AppResult<String> {
    let numeric_id = !database_id.is_empty()
        && database_id.len() <= 19
        && database_id.bytes().all(|byte| byte.is_ascii_digit());
    let legacy = database_id == database && !numeric_id;
    if (!numeric_id && !legacy) || !valid_database_name(database) {
        return Err(blocked());
    }
    let databases = value
        .get("databases")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= 256)
        .ok_or_else(blocked)?;
    let exact = databases
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let name = object.get("name").and_then(Value::as_str)?;
            let id = object.get("id").and_then(|value| {
                if let Some(id) = value.as_u64() {
                    return Some(id.to_string());
                }
                value
                    .as_str()
                    .filter(|id| {
                        !id.is_empty()
                            && id.len() <= 19
                            && id.bytes().all(|byte| byte.is_ascii_digit())
                    })
                    .map(str::to_owned)
            })?;
            (object.len() <= 8
                && valid_database_name(name)
                && ((legacy && name == database) || (!legacy && id == database_id)))
                .then(|| name.to_owned())
        })
        .collect::<Vec<_>>();
    (exact.len() == 1)
        .then(|| exact[0].clone())
        .ok_or_else(blocked)
}

fn parse_neon_read_endpoint(value: &Value) -> AppResult<String> {
    let endpoints = value
        .get("endpoints")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= 256)
        .ok_or_else(blocked)?;
    let hosts = endpoints
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            if object.len() > 12
                || object.get("type").and_then(Value::as_str) != Some("read_write")
                || object.get("disabled").and_then(Value::as_bool) != Some(false)
            {
                return None;
            }
            object
                .get("host")
                .and_then(Value::as_str)
                .filter(|host| valid_neon_host(host))
        })
        .collect::<Vec<_>>();
    match hosts.as_slice() {
        [host] => Ok((*host).to_owned()),
        _ => Err(blocked()),
    }
}

fn valid_database_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn valid_neon_host(value: &str) -> bool {
    value.len() <= 253
        && value.ends_with(".neon.tech")
        && !value.starts_with('.')
        && !value.contains("..")
        && !value.contains(['/', '\\', '@', ':', '?', '#'])
        && !value.chars().any(char::is_control)
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}
