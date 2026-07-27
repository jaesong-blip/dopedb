//! Redacted shared-connection and managed-lease HTTP exchanges.

use super::*;

fn remote_connection(value: RemoteConnectionResponse) -> AppResult<(ConnectionProfile, i64)> {
    let id = Uuid::parse_str(&value.id)
        .map_err(|_| AppError::Network("shared connection returned an invalid id".into()))?;
    if value.name.trim().is_empty()
        || value.name.len() > 120
        || value.host.len() > 512
        || !value.readonly_default
        || value.allow_writes
    {
        return Err(AppError::Network(
            "shared connection returned an unsafe member-local template".into(),
        ));
    }
    let access = crate::store::parse_workspace_access(value.access_mode)?;
    if matches!(access, WorkspaceConnectionAccess::Local) {
        return Err(AppError::Network(
            "shared connection returned invalid access".into(),
        ));
    }
    let credential_mode = crate::store::parse_credential_mode(value.credential_mode)?;
    if credential_mode == WorkspaceCredentialMode::Local {
        return Err(AppError::Network(
            "shared connection returned invalid credential mode".into(),
        ));
    }
    let revision = value.revision;
    if revision < 1 {
        return Err(AppError::Network(
            "shared connection returned invalid revision".into(),
        ));
    }
    Ok((
        ConnectionProfile {
            id,
            name: value.name,
            engine: crate::store::parse_engine(value.engine)?,
            provider: crate::store::parse_provider(value.provider)?,
            driver_id: value.driver_id,
            host: value.host,
            port: value.port,
            database: value.database,
            // Managed usernames and passwords are supplied only by the lease route.
            username: String::new(),
            sslmode: value.sslmode,
            extra_params: Default::default(),
            readonly_default: value.readonly_default,
            // A shared member-local template never delegates target write authority.
            allow_writes: false,
            secret_ref: None,
            env: value.env,
            schema_group: value.schema_group,
            workspace_access: access,
            credential_mode,
        },
        revision,
    ))
}

/// Fetch redacted shared templates for a workspace using the OS-stored session.
pub(super) async fn remote_connections(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<Option<Vec<(ConnectionProfile, i64)>>> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("shared connections require an authenticated session".into())
        })?;
    let origin = origin()?;
    let response = client()?
        .get(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/connections"
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading shared connections", error))?;
    // An updated desktop can briefly reach the previous control-plane deployment.
    // Preserve the local cache instead of interpreting a missing route as no data.
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let connections = response
        .json::<RemoteConnectionsResponse>()
        .await
        .map_err(|error| request_error("reading shared connections", error))?
        .connections
        .into_iter()
        .map(remote_connection)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Some(connections))
}

/// Publish only the non-secret portion of a local connection. The request type has
/// no credential fields, making accidental serialization of `secret_ref` impossible.
pub(super) async fn share_connection(
    user_id: &str,
    workspace_id: Uuid,
    profile: &ConnectionProfile,
) -> AppResult<(ConnectionProfile, i64)> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("sharing a connection requires an authenticated session".into())
        })?;
    let request = SharedConnectionRequest {
        name: &profile.name,
        engine: crate::store::engine_str(profile.engine),
        provider: crate::store::provider_str(profile.provider),
        driver_id: &profile.driver_id,
        host: &profile.host,
        port: profile.port,
        database: &profile.database,
        sslmode: &profile.sslmode,
        // Do not let a local write preference cross the shared-template boundary.
        readonly_default: true,
        allow_writes: false,
        env: &profile.env,
        schema_group: &profile.schema_group,
    };
    let origin = origin()?;
    let response = client()?
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/connections"
        ))
        .bearer_auth(token.as_str())
        .json(&request)
        .send()
        .await
        .map_err(|error| request_error("sharing connection", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    remote_connection(
        response
            .json::<CreatedConnectionResponse>()
            .await
            .map_err(|error| request_error("reading shared connection", error))?
            .connection,
    )
}

/// Roll back a newly shared template when a later local credential/cache step fails.
/// The server performs the same workspace and RBAC checks as every other mutation.
pub(super) async fn delete_connection(
    user_id: &str,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> AppResult<()> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config(
                "deleting a shared connection requires an authenticated session".into(),
            )
        })?;
    let origin = origin()?;
    let response = client()?
        .delete(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/connections/{connection_id}"
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("deleting shared connection", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
        return Ok(());
    }
    Err(oauth_error(response).await)
}

/// Revalidate a shared connection action against the current Better Auth session,
/// membership, role, and resource scope immediately before local DB access.
pub(super) async fn authorize_connection(
    user_id: &str,
    workspace_id: Uuid,
    connection_id: Uuid,
    write: bool,
) -> AppResult<RemoteConnectionAuthority> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("shared connection access requires an authenticated session".into())
        })?;
    let origin = origin()?;
    let response = client()?
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/connections/{connection_id}"
        ))
        .bearer_auth(token.as_str())
        .json(&json!({ "action": if write { "write" } else { "read" } }))
        .send()
        .await
        .map_err(|error| request_error("authorizing shared connection", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let authority = response
        .json::<AuthorizedConnectionResponse>()
        .await
        .map_err(|error| request_error("reading shared connection authorization", error))?;
    let expected_action = if write { "write" } else { "read" };
    let access = crate::store::parse_workspace_access(authority.access_mode)?;
    if !authority.allowed
        || authority.action != expected_action
        || authority.revision < 1
        || access == WorkspaceConnectionAccess::Local
        || (write && !access.can_write())
        || (!write && !access.can_read())
    {
        return Err(AppError::Network(
            "shared connection authorization returned invalid authority".into(),
        ));
    }
    Ok(RemoteConnectionAuthority {
        revision: authority.revision,
    })
}

/// Obtain one provider-issued database credential for a managed shared connection.
/// The response password is moved into a zeroizing buffer immediately and never
/// touches the local store; the driver may retain it only inside the lease-bound pool.
pub(super) async fn issue_managed_connection_lease(
    user_id: &str,
    workspace_id: Uuid,
    profile: &ConnectionProfile,
    write: bool,
) -> AppResult<ManagedConnectionLease> {
    if profile.credential_mode != WorkspaceCredentialMode::Managed {
        return Err(AppError::Config(
            "managed credentials were requested for a local binding".into(),
        ));
    }
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config("managed database access requires an authenticated session".into())
        })?;
    let origin = origin()?;
    let requested_access = if write { "write" } else { "read" };
    let response = client()?
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/connections/{}/lease",
            profile.id
        ))
        .bearer_auth(token.as_str())
        .header("x-dopedb-managed-lease-contract", MANAGED_LEASE_CONTRACT)
        .json(&json!({ "accessMode": requested_access }))
        .send()
        .await
        .map_err(|error| request_error("requesting managed database access", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let mut lease = response
        .json::<ManagedLeaseResponse>()
        .await
        .map_err(|error| request_error("reading managed database access", error))?
        .lease;
    let secret = Zeroizing::new(std::mem::take(&mut lease.password));
    let lease_id = Uuid::parse_str(&lease.id)
        .map_err(|_| AppError::Network("managed database access returned an invalid id".into()))?;
    let provider = crate::store::parse_provider(lease.provider)?;
    let engine = crate::store::parse_engine(lease.engine)?;
    let valid_provider_tls = match provider {
        Provider::Neon | Provider::PlanetScale => {
            lease.sslmode == "verify-full" && lease.tls_server_ca_pem.is_none()
        }
        Provider::GcpCloudSql => {
            matches!(lease.sslmode.as_str(), "verify-ca" | "verify-full")
                && lease.tls_server_ca_pem.as_ref().is_some_and(|pem| {
                    pem.len() <= 64 * 1024
                        && pem.starts_with("-----BEGIN CERTIFICATE-----")
                        && pem.trim_end().ends_with("-----END CERTIFICATE-----")
                        && !pem.contains('\0')
                })
        }
        Provider::Auto | Provider::Generic => false,
    };
    if engine != profile.engine
        || provider != profile.provider
        || lease.host.is_empty()
        || lease.host.len() > 512
        || lease.host.contains("://")
        || lease.host.chars().any(char::is_whitespace)
        || lease.port == 0
        || lease.database.is_empty()
        || lease.database.len() > 512
        || lease.username.is_empty()
        || lease.username.len() > 512
        || secret.is_empty()
        || secret.len() > (1 << 16)
        || !valid_provider_tls
        || lease.access_mode != requested_access
        || (write && !profile.workspace_access.can_write())
    {
        return Err(AppError::Network(
            "managed database access returned invalid connection material".into(),
        ));
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(&lease.expires_at)
        .map_err(|_| AppError::Network("managed database access returned invalid expiry".into()))?
        .with_timezone(&chrono::Utc);
    let valid_seconds = expires_at
        .signed_duration_since(chrono::Utc::now())
        .num_seconds();
    if !(30..=20 * 60).contains(&valid_seconds) {
        return Err(AppError::Network(
            "managed database access returned an unsafe expiry".into(),
        ));
    }
    let mut leased_profile = profile.clone();
    leased_profile.provider = provider;
    leased_profile.host = lease.host;
    leased_profile.port = lease.port;
    leased_profile.database = lease.database;
    leased_profile.username = lease.username;
    leased_profile.sslmode = lease.sslmode;
    leased_profile.extra_params.clear();
    if let Some(ca) = lease.tls_server_ca_pem {
        leased_profile
            .extra_params
            .insert("sslrootcert_pem".into(), ca);
    }
    leased_profile.secret_ref = None;
    tracing::debug!(
        connection_id = %profile.id,
        lease_id = %lease_id,
        valid_seconds,
        "opened short-lived managed database access"
    );
    Ok(ManagedConnectionLease {
        lease_id,
        profile: leased_profile,
        secret,
        valid_for: Duration::from_secs(valid_seconds as u64),
    })
}

/// Release a provider credential before its natural expiry when the owning desktop
/// pool is retired. Failure is surfaced to the caller for logging, but never blocks
/// local pool closure.
pub(super) async fn release_managed_connection_lease(
    user_id: &str,
    workspace_id: Uuid,
    connection_id: Uuid,
    lease_id: Uuid,
) -> AppResult<()> {
    let Some(token) = fetch_workspace_session(user_id)?.map(Zeroizing::new) else {
        return Ok(());
    };
    let origin = origin()?;
    let response = client()?
        .delete(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/connections/{connection_id}/lease"
        ))
        .bearer_auth(token.as_str())
        .json(&json!({ "leaseId": lease_id }))
        .send()
        .await
        .map_err(|error| request_error("releasing managed database access", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> RemoteConnectionResponse {
        RemoteConnectionResponse {
            id: Uuid::from_u128(9).to_string(),
            name: "analytics".into(),
            engine: "postgres".into(),
            provider: "generic".into(),
            driver_id: None,
            host: "db.example.test".into(),
            port: 5432,
            database: "analytics".into(),
            sslmode: "require".into(),
            readonly_default: true,
            allow_writes: false,
            env: None,
            schema_group: None,
            revision: 1,
            access_mode: "read".into(),
            credential_mode: "member_local".into(),
        }
    }

    #[test]
    fn shared_template_parser_fails_closed_for_writes_or_local_wire_values() {
        let mut write = response();
        write.allow_writes = true;
        assert!(remote_connection(write).is_err());

        let mut local = response();
        local.credential_mode = "local".into();
        assert!(remote_connection(local).is_err());
    }

    #[test]
    fn shared_template_parser_preserves_only_read_only_member_local_values() {
        let (profile, revision) = remote_connection(response()).expect("safe shared template");
        assert_eq!(revision, 1);
        assert_eq!(
            profile.credential_mode,
            WorkspaceCredentialMode::MemberLocal
        );
        assert!(profile.readonly_default);
        assert!(!profile.allow_writes);
    }

    #[test]
    fn managed_template_is_secretless_and_reaches_the_lease_only_profile() {
        let mut managed = response();
        managed.credential_mode = "managed".into();
        let (profile, revision) = remote_connection(managed).expect("managed lease template");
        assert_eq!(revision, 1);
        assert_eq!(profile.credential_mode, WorkspaceCredentialMode::Managed);
        assert!(profile.secret_ref.is_none());
        assert!(profile.username.is_empty());
        assert!(!profile.allow_writes);
    }
}
