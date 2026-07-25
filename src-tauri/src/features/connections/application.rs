//! Connection use cases.
//!
//! Validation and mutation ordering live here. Concrete SQLite, keychain, driver,
//! pool, and Tauri details remain behind ports.

use std::sync::Arc;

use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::ConnectionId;
use crate::kernel::TerminalAuthority;
use crate::model::{ConnectionProfile, WorkspaceConnectionAccess, WorkspaceCredentialMode};

use super::domain::{
    normalize_schema_group, resolve_cli_name, validate_schema_group_engine, AgentConnectionSummary,
    CliConnectionResolutionError, DriverDescriptor, MAX_CONNECTION_CREDENTIAL_BYTES,
};
use super::ports::{
    AdHocConnectionPort, AuthorizedConnectionPort, ConnectionCredentialVault,
    ConnectionMutationPort, ConnectionPermission, ConnectionRepositoryPort, ConnectionRuntimePort,
    DriverRegistryPort, ScopeMutationPort,
};

pub(crate) struct ConnectionUpsertRequest {
    pub(crate) profile: ConnectionProfile,
    pub(crate) password: Option<Zeroizing<String>>,
}

pub(crate) struct ConnectionProfileTestRequest {
    pub(crate) profile: ConnectionProfile,
    pub(crate) password: Option<Zeroizing<String>>,
}

pub(crate) struct ConnectionUseCases<R, A, D, T, V>
where
    V: ConnectionCredentialVault + ?Sized,
{
    repository: R,
    authority: A,
    drivers: D,
    tester: T,
    credentials: Arc<V>,
}

impl<R, A, D, T, V> Clone for ConnectionUseCases<R, A, D, T, V>
where
    R: Clone,
    A: Clone,
    D: Clone,
    T: Clone,
    V: ConnectionCredentialVault + ?Sized,
{
    fn clone(&self) -> Self {
        Self {
            repository: self.repository.clone(),
            authority: self.authority.clone(),
            drivers: self.drivers.clone(),
            tester: self.tester.clone(),
            credentials: Arc::clone(&self.credentials),
        }
    }
}

impl<R, A, D, T, V> ConnectionUseCases<R, A, D, T, V>
where
    R: ConnectionRepositoryPort,
    A: ConnectionRuntimePort,
    D: DriverRegistryPort,
    T: AdHocConnectionPort,
    V: ConnectionCredentialVault + ?Sized,
{
    pub(crate) fn new(
        repository: R,
        authority: A,
        drivers: D,
        tester: T,
        credentials: Arc<V>,
    ) -> Self {
        Self {
            repository,
            authority,
            drivers,
            tester,
            credentials,
        }
    }

    pub(crate) fn list_drivers(&self) -> Vec<DriverDescriptor> {
        self.drivers.list()
    }

    pub(crate) fn install_driver(&self, id: &str) -> AppResult<DriverDescriptor> {
        self.drivers.install(id)
    }

    pub(crate) async fn list_profiles(&self) -> AppResult<Vec<ConnectionProfile>> {
        self.repository.list().await
    }

    /// Persist one local connection and atomically rotate its credential pointer.
    pub(crate) async fn upsert(
        &self,
        request: ConnectionUpsertRequest,
    ) -> AppResult<ConnectionProfile> {
        let ConnectionUpsertRequest {
            mut profile,
            password,
        } = request;
        if profile.workspace_access != WorkspaceConnectionAccess::Local {
            return Err(AppError::Blocked {
                reason:
                    "shared templates are edited by workspace editors; bind credentials separately"
                        .into(),
            });
        }
        profile.schema_group = normalize_schema_group(profile.schema_group);
        self.drivers.validate(&profile)?;

        let mutation = self.authority.begin_scope_mutation().await;
        let id = ConnectionId::from(profile.id);
        self.repository.ensure_write_scope(id).await?;
        let connections = self.repository.list().await?;
        validate_schema_group_engine(&profile, &connections)?;
        let existing_secret_id = connections
            .iter()
            .find(|connection| connection.id == profile.id)
            .and_then(|connection| connection.secret_ref.as_deref())
            .map(Uuid::parse_str)
            .transpose()
            .map_err(|_| {
                AppError::Config("stored connection secret reference is invalid".into())
            })?;
        let password = password.filter(|password| !password.is_empty());
        if password
            .as_ref()
            .is_some_and(|value| value.len() > MAX_CONNECTION_CREDENTIAL_BYTES)
        {
            return Err(AppError::Config(
                "connection credential exceeds the size limit".into(),
            ));
        }

        profile.secret_ref = existing_secret_id.map(|value| value.to_string());
        let replacement_secret_id = password.as_ref().map(|_| Uuid::new_v4());
        if let Some(password) = password.as_deref() {
            let credential_id = replacement_secret_id.expect("password has a replacement id");
            self.credentials.store(&credential_id, password)?;
            profile.secret_ref = Some(credential_id.to_string());
        }

        match self.repository.upsert(&profile).await {
            Ok(profile) => {
                let _ = self.repository.clear_schema_cache(id).await;
                mutation.retire_connection(id).await;
                if replacement_secret_id.is_some() {
                    if let Some(previous_id) = existing_secret_id {
                        self.delete_secret_best_effort(
                            previous_id,
                            "replace_connection_credentials",
                        );
                    }
                }
                Ok(profile)
            }
            Err(error) => {
                if let Some(credential_id) = replacement_secret_id {
                    self.delete_secret_best_effort(credential_id, "upsert_connection");
                }
                Err(error)
            }
        }
    }

    pub(crate) async fn set_schema_group(
        &self,
        ids: Vec<ConnectionId>,
        schema_group: Option<String>,
    ) -> AppResult<Vec<ConnectionProfile>> {
        let mut unique_ids = Vec::with_capacity(ids.len());
        for id in ids {
            if !unique_ids.contains(&id) {
                unique_ids.push(id);
            }
        }
        if unique_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mutation = self.authority.begin_scope_mutation().await;
        let normalized = normalize_schema_group(schema_group);
        let mut connections = self.repository.list().await?;
        for id in &unique_ids {
            let raw_id = Uuid::from(*id);
            let profile = connections
                .iter_mut()
                .find(|profile| profile.id == raw_id)
                .ok_or_else(|| AppError::NotFound(format!("connection {id}")))?;
            if profile.workspace_access != WorkspaceConnectionAccess::Local {
                return Err(AppError::Blocked {
                    reason:
                        "shared template metadata must be changed through the workspace service"
                            .into(),
                });
            }
            profile.schema_group = normalized.clone();
        }

        let updated = unique_ids
            .iter()
            .map(|id| {
                connections
                    .iter()
                    .find(|profile| profile.id == Uuid::from(*id))
                    .cloned()
                    .ok_or_else(|| AppError::NotFound(format!("connection {id}")))
            })
            .collect::<AppResult<Vec<_>>>()?;
        for profile in &updated {
            validate_schema_group_engine(profile, &connections)?;
        }

        self.repository
            .set_schema_group(&unique_ids, normalized)
            .await?;
        mutation.retire_connections(&unique_ids).await;
        Ok(updated)
    }

    pub(crate) async fn delete(&self, id: ConnectionId) -> AppResult<()> {
        let mutation = self
            .authority
            .begin_connection_mutation(id, ConnectionPermission::Read)
            .await?;
        let profile = mutation.profile().clone();
        if profile.workspace_access != WorkspaceConnectionAccess::Local {
            return Err(AppError::Blocked {
                reason: "shared connections can only be removed by a workspace administrator"
                    .into(),
            });
        }
        self.repository.delete(id).await?;
        if let Some(secret_ref) = profile.secret_ref.as_deref() {
            match Uuid::parse_str(secret_ref) {
                Ok(credential_id) => {
                    self.delete_secret_best_effort(credential_id, "delete_connection");
                }
                Err(error) => {
                    tracing::warn!(
                        connection_id = %id,
                        %error,
                        "ignored invalid credential reference while deleting connection"
                    );
                }
            }
        }
        mutation.retire_connection(id).await;
        Ok(())
    }

    pub(crate) async fn test(&self, id: ConnectionId) -> AppResult<()> {
        let profile = self.repository.get(id).await?;
        if !profile.workspace_access.can_read() {
            return Err(AppError::Blocked {
                reason: "your workspace role cannot test this shared connection".into(),
            });
        }
        self.authority
            .authorize(id, ConnectionPermission::Read)
            .await?
            .test_fresh()
            .await
    }

    pub(crate) async fn test_profile(
        &self,
        request: ConnectionProfileTestRequest,
    ) -> AppResult<()> {
        let ConnectionProfileTestRequest { profile, password } = request;
        if profile.workspace_access != WorkspaceConnectionAccess::Local
            || profile.credential_mode != WorkspaceCredentialMode::Local
        {
            return Err(AppError::Blocked {
                reason: "shared connections must be tested through workspace authorization".into(),
            });
        }
        let password = password.unwrap_or_default();
        if password.len() > MAX_CONNECTION_CREDENTIAL_BYTES {
            return Err(AppError::Config(
                "connection credential exceeds the size limit".into(),
            ));
        }
        self.tester.test(&profile, password).await
    }

    pub(crate) async fn list_agent_summaries(&self) -> AppResult<Vec<AgentConnectionSummary>> {
        Ok(self
            .list_profiles()
            .await?
            .iter()
            .map(AgentConnectionSummary::from)
            .collect())
    }

    pub(crate) async fn terminal_summary(
        &self,
        authority: &TerminalAuthority,
    ) -> AppResult<AgentConnectionSummary> {
        let connection = self
            .authority
            .authorize_terminal(authority, ConnectionPermission::Read)
            .await?;
        Ok(AgentConnectionSummary::from(connection.profile()))
    }

    pub(crate) async fn list_terminal_summaries(
        &self,
        authority: &TerminalAuthority,
    ) -> AppResult<Vec<AgentConnectionSummary>> {
        Ok(vec![self.terminal_summary(authority).await?])
    }

    pub(crate) async fn test_terminal(&self, authority: &TerminalAuthority) -> AppResult<()> {
        self.authority
            .authorize_terminal(authority, ConnectionPermission::Read)
            .await?
            .test_fresh()
            .await
    }

    pub(crate) async fn resolve_terminal_cli(
        &self,
        authority: &TerminalAuthority,
        name: &str,
    ) -> AppResult<Result<AgentConnectionSummary, CliConnectionResolutionError>> {
        let authority_guard = self
            .authority
            .authorize_terminal(authority, ConnectionPermission::Read)
            .await?;
        let summaries = self.list_agent_summaries().await?;
        let resolved = resolve_cli_name(&summaries, name);
        drop(authority_guard);
        Ok(resolved)
    }

    fn delete_secret_best_effort(&self, id: Uuid, action: &'static str) {
        if let Err(error) = self.credentials.delete(&id) {
            tracing::warn!(credential_id = %id, %error, action, "credential cleanup deferred");
        }
    }
}
