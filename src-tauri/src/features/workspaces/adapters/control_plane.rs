//! Hosted Better Auth RFC 8628 device authorization adapter. Network exchange
//! and credential persistence stay in Rust so Bearer sessions never cross into the
//! webview, logs, local SQLite, or frontend query caches.

mod authentication;
mod connections;
mod provider_local_target;

use std::net::IpAddr;
use std::time::Duration;

use reqwest::{redirect::Policy, Client, Response, StatusCode, Url};
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::connection::keychain::{
    delete_legacy_workspace_session, delete_workspace_session, fetch_legacy_workspace_session,
    fetch_workspace_session, store_workspace_session,
};
use crate::connection::{
    GcpCloudSqlNetworkMode, ManagedConnectionLease as RuntimeManagedConnectionLease,
    ProviderLocalResource, ProviderLocalTarget as RuntimeProviderLocalTarget,
    RemoteAuthorityFuture, RemoteConnectionAuthority as RuntimeRemoteConnectionAuthority,
    RemoteConnectionAuthorityPort,
};
use crate::error::{AppError, AppResult};
use crate::features::workspaces::{
    domain::{parse_workspace_role, valid_device_code},
    RemoteWorkspace, WorkspaceAuthUser, WorkspaceDeviceAuthorization, WorkspaceLoginPoll,
    WorkspaceLoginPollStatus,
};
use crate::kernel::identity::{AccountId, ConnectionId, ProviderIntegrationId, WorkspaceId};
use crate::model::{
    ConnectionProfile, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};

use super::super::ports::WorkspaceControlPlanePort;
use authentication::{
    auth_user, begin_login, migrate_legacy_session, poll_login, remote_workspaces, sign_out,
};
use connections::{
    authorize_connection, delete_connection, issue_managed_connection_lease,
    release_managed_connection_lease, remote_connections, share_connection,
};
use provider_local_target::provider_local_target;

const DEFAULT_CONTROL_PLANE_ORIGIN: &str = "https://app.dopedb.dev";
const DESKTOP_CLIENT_ID: &str = "dopedb-desktop";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const MANAGED_LEASE_CONTRACT: &str = "access-v1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct OAuthErrorResponse {
    error: Option<String>,
    error_description: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionResponse {
    user: WorkspaceAuthUser,
}

#[derive(Debug, Deserialize)]
struct WorkspacesResponse {
    workspaces: Vec<RemoteWorkspaceResponse>,
}

#[derive(Debug, Deserialize)]
struct RemoteWorkspaceResponse {
    id: String,
    name: String,
    role: Option<String>,
}

fn default_remote_credential_mode() -> String {
    "member_local".into()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConnectionResponse {
    id: String,
    name: String,
    engine: String,
    provider: String,
    driver_id: Option<String>,
    host: String,
    port: u16,
    database: String,
    sslmode: String,
    readonly_default: bool,
    allow_writes: bool,
    env: Option<String>,
    schema_group: Option<String>,
    revision: i64,
    access_mode: String,
    #[serde(default = "default_remote_credential_mode")]
    credential_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConnectionsResponse {
    connections: Vec<RemoteConnectionResponse>,
}

#[derive(Debug, Deserialize)]
struct CreatedConnectionResponse {
    connection: RemoteConnectionResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizedConnectionResponse {
    allowed: bool,
    action: String,
    access_mode: String,
    revision: i64,
}

#[derive(Debug, Deserialize)]
struct ManagedLeaseResponse {
    lease: RemoteManagedLease,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteManagedLease {
    id: String,
    provider: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    sslmode: String,
    tls_server_ca_pem: Option<String>,
    access_mode: String,
    expires_at: String,
}

pub(crate) struct ManagedConnectionLease {
    pub lease_id: Uuid,
    pub profile: ConnectionProfile,
    pub secret: Zeroizing<String>,
    pub valid_for: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RemoteConnectionAuthority {
    pub revision: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedConnectionRequest<'a> {
    name: &'a str,
    engine: &'a str,
    provider: &'a str,
    driver_id: &'a Option<String>,
    host: &'a str,
    port: u16,
    database: &'a str,
    sslmode: &'a str,
    readonly_default: bool,
    allow_writes: bool,
    env: &'a Option<String>,
    schema_group: &'a Option<String>,
}

fn is_loopback_host(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    })
}

/// The one canonical hosted-origin validator. Provider adapters reuse this
/// rather than accepting a second environment variable or a weaker fallback.
pub(crate) fn validated_control_plane_origin() -> AppResult<String> {
    let raw = std::env::var("DOPEDB_WORKSPACE_ORIGIN")
        .unwrap_or_else(|_| DEFAULT_CONTROL_PLANE_ORIGIN.to_string())
        .trim_end_matches('/')
        .to_string();
    let url = Url::parse(&raw)
        .map_err(|_| AppError::Config("workspace control-plane origin is invalid".into()))?;
    let local_debug_origin =
        cfg!(debug_assertions) && url.scheme() == "http" && is_loopback_host(&url);
    if (url.scheme() != "https" && !local_debug_origin)
        || url.username() != ""
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::Config(
            "workspace control-plane origin must be an HTTPS origin".into(),
        ));
    }
    Ok(raw)
}

// Child HTTP adapter modules retain this private spelling; cross-feature users
// must call the explicit validated export above.
fn origin() -> AppResult<String> {
    validated_control_plane_origin()
}

/// Build the hosted workspace console URL from the same validated origin used by
/// the auth API. Keeping this in Rust prevents the webview from opening an
/// arbitrary origin while still honoring the localhost override in debug builds.
pub(crate) fn console_url(workspace_id: Option<Uuid>) -> AppResult<String> {
    let mut url = Url::parse(&validated_control_plane_origin()?)
        .map_err(|_| AppError::Config("workspace control-plane origin is invalid".into()))?;
    url.set_path("/settings");
    if let Some(workspace_id) = workspace_id {
        let workspace_id = workspace_id.to_string();
        url.query_pairs_mut()
            .append_pair("workspace", &workspace_id);
        url.set_fragment(Some(&format!("workspace-{workspace_id}")));
    } else {
        url.set_fragment(Some("workspaces"));
    }
    Ok(url.into())
}

fn client() -> AppResult<Client> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .user_agent(concat!("DopeDB/", env!("CARGO_PKG_VERSION"), " desktop"))
        .build()
        .map_err(|error| AppError::Network(format!("could not create HTTP client: {error}")))
}

fn request_error(action: &str, error: reqwest::Error) -> AppError {
    AppError::Network(format!("{action} failed: {error}"))
}

async fn oauth_error(response: Response) -> AppError {
    let status = response.status();
    let body = response.json::<OAuthErrorResponse>().await.ok();
    let detail = body
        .as_ref()
        .and_then(|value| {
            value
                .error_description
                .as_deref()
                .or(value.message.as_deref())
        })
        .unwrap_or("the control plane rejected the request");
    AppError::Network(format!(
        "workspace authentication returned {status}: {detail}"
    ))
}

/// Production bridge injected into the connection-pool runtime. Keeping this
/// implementation beside the HTTP client prevents the pool from reaching into a
/// global workspace module.
#[derive(Clone, Copy)]
pub(crate) struct HostedWorkspaceControlPlane;

impl RemoteConnectionAuthorityPort for HostedWorkspaceControlPlane {
    fn authorize<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        connection_id: ConnectionId,
        write: bool,
    ) -> RemoteAuthorityFuture<'a, RuntimeRemoteConnectionAuthority> {
        Box::pin(async move {
            let authority = authorize_connection(
                account_id.as_str(),
                workspace_id.into(),
                connection_id.into(),
                write,
            )
            .await?;
            Ok(RuntimeRemoteConnectionAuthority {
                revision: authority.revision,
            })
        })
    }

    fn issue_managed_lease<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        profile: &'a ConnectionProfile,
        write: bool,
    ) -> RemoteAuthorityFuture<'a, RuntimeManagedConnectionLease> {
        Box::pin(async move {
            let lease = issue_managed_connection_lease(
                account_id.as_str(),
                workspace_id.into(),
                profile,
                write,
            )
            .await?;
            Ok(RuntimeManagedConnectionLease {
                lease_id: lease.lease_id,
                profile: lease.profile,
                secret: lease.secret,
                valid_for: lease.valid_for,
            })
        })
    }

    fn release_managed_lease<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        connection_id: ConnectionId,
        lease_id: Uuid,
    ) -> RemoteAuthorityFuture<'a, ()> {
        Box::pin(release_managed_connection_lease(
            account_id.as_str(),
            workspace_id.into(),
            connection_id.into(),
            lease_id,
        ))
    }

    fn provider_local_target<'a>(
        &'a self,
        account_id: &'a AccountId,
        workspace_id: WorkspaceId,
        connection_id: ConnectionId,
    ) -> RemoteAuthorityFuture<'a, RuntimeProviderLocalTarget> {
        Box::pin(provider_local_target(
            account_id.as_str(),
            workspace_id.into(),
            connection_id,
        ))
    }
}

impl WorkspaceControlPlanePort for HostedWorkspaceControlPlane {
    async fn begin_login(&self) -> AppResult<WorkspaceDeviceAuthorization> {
        begin_login().await
    }

    async fn poll_login(&self, device_code: &str) -> AppResult<WorkspaceLoginPoll> {
        poll_login(device_code).await
    }

    async fn auth_user(&self, account_id: &AccountId) -> AppResult<Option<WorkspaceAuthUser>> {
        auth_user(account_id.as_str()).await
    }

    async fn migrate_legacy_session(&self) -> AppResult<Option<WorkspaceAuthUser>> {
        migrate_legacy_session().await
    }

    async fn sign_out(&self, account_id: &AccountId) -> AppResult<()> {
        sign_out(account_id.as_str()).await
    }

    async fn remote_workspaces(&self, account_id: &AccountId) -> AppResult<Vec<RemoteWorkspace>> {
        remote_workspaces(account_id.as_str()).await
    }

    async fn remote_connections(
        &self,
        account_id: &AccountId,
        workspace_id: WorkspaceId,
    ) -> AppResult<Option<Vec<(ConnectionProfile, i64)>>> {
        remote_connections(account_id.as_str(), workspace_id.into()).await
    }

    async fn share_connection(
        &self,
        account_id: &AccountId,
        workspace_id: WorkspaceId,
        profile: &ConnectionProfile,
    ) -> AppResult<(ConnectionProfile, i64)> {
        share_connection(account_id.as_str(), workspace_id.into(), profile).await
    }

    async fn delete_connection(
        &self,
        account_id: &AccountId,
        workspace_id: WorkspaceId,
        connection_id: ConnectionId,
    ) -> AppResult<()> {
        delete_connection(
            account_id.as_str(),
            workspace_id.into(),
            connection_id.into(),
        )
        .await
    }

    fn console_url(&self, workspace_id: Option<WorkspaceId>) -> AppResult<String> {
        console_url(workspace_id.map(Into::into))
    }
}
