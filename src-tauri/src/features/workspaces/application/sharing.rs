//! Shared connection publication and member-local credential binding use cases.

use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::connections::{ConnectionCredentialVault, MAX_CONNECTION_CREDENTIAL_BYTES};
use crate::model::{ConnectionProfile, WorkspaceConnectionAccess, WorkspaceCredentialMode};

use super::super::domain::{validate_member_username, WorkspaceKind};
use super::super::ports::{
    WorkspaceConfigurationPort, WorkspaceConnectionMutationPort, WorkspaceControlPlanePort,
    WorkspaceRepositoryPort, WorkspaceRuntimePort,
};
use super::{WorkspaceConnectionCopyRequest, WorkspaceCredentialBindingRequest, WorkspaceUseCases};

impl<R, A, C, V, E> WorkspaceUseCases<R, A, C, V, E>
where
    R: WorkspaceRepositoryPort,
    A: WorkspaceRuntimePort,
    C: WorkspaceControlPlanePort,
    V: ConnectionCredentialVault + ?Sized,
    E: WorkspaceConfigurationPort,
{
    /// Copy a local connection into a team workspace. Only its redacted template
    /// crosses the network; the caller's credential is duplicated locally under the
    /// remote resource UUID.
    pub(crate) async fn copy_connection(
        &self,
        request: WorkspaceConnectionCopyRequest,
    ) -> AppResult<ConnectionProfile> {
        let WorkspaceConnectionCopyRequest {
            connection_id,
            workspace_id,
            account_user_id,
        } = request;
        let source = self.repository.get_connection(connection_id).await?;
        if source.workspace_access != WorkspaceConnectionAccess::Local {
            return Err(AppError::Config(
                "only a local connection can be copied into a workspace".into(),
            ));
        }
        let target = self
            .repository
            .list_workspaces()
            .await?
            .into_iter()
            .find(|workspace| workspace.id == workspace_id && workspace.kind == WorkspaceKind::Team)
            .ok_or_else(|| AppError::NotFound(format!("team workspace {workspace_id}")))?;
        let current_account = self.repository.active_account_id().await?;
        if target.id == self.repository.active_workspace_id().await?
            && current_account.as_ref() == Some(&account_user_id)
        {
            return Err(AppError::Config("choose a different team workspace".into()));
        }
        let account = self
            .repository
            .accounts()
            .await?
            .into_iter()
            .find(|account| {
                account.user.id == account_user_id
                    && account
                        .memberships
                        .iter()
                        .any(|membership| membership.workspace_id == workspace_id)
            })
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "workspace {workspace_id} for account {account_user_id}"
                ))
            })?;

        // Resolve every local prerequisite and snapshot the current remote collection
        // before creating the server resource. This avoids a remote template being left
        // behind merely because a later credential read or collection fetch failed.
        let copied_secret = if source.secret_ref.is_some() {
            Some(self.credentials.fetch_profile(&source)?)
        } else {
            None
        };
        let mut remote = self
            .control_plane
            .remote_connections(&account.user.id, workspace_id)
            .await?
            .ok_or_else(|| {
                AppError::Network(
                    "the workspace service has not deployed shared connections yet".into(),
                )
            })?;
        let credential_id = copied_secret.as_ref().map(|_| Uuid::new_v4());
        if let (Some(credential_id), Some(secret)) = (credential_id, copied_secret.as_deref()) {
            self.credentials.store(&credential_id, secret)?;
        }
        let shared = self
            .control_plane
            .share_connection(&account.user.id, workspace_id, &source)
            .await;
        let (created, revision) = match shared {
            Ok(created) => created,
            Err(error) => {
                if let Some(credential_id) = credential_id {
                    self.delete_secret_best_effort(credential_id, "share_connection");
                }
                return Err(error);
            }
        };
        remote.push((created.clone(), revision));
        let credential_ref = credential_id.map(|id| id.to_string());
        let local_result = async {
            let removed_credential_ids = self
                .runtime
                .sync_remote_connections(workspace_id, &account.user.id, &remote)
                .await?;
            for credential_id in removed_credential_ids {
                self.delete_secret_best_effort(credential_id, "remove_remote_connection");
            }
            self.repository
                .bind_connection_credentials(
                    created.id.into(),
                    &account.user.id,
                    &source.username,
                    &source.extra_params,
                    credential_ref.as_deref(),
                )
                .await
        }
        .await;
        match local_result {
            Ok(profile) => Ok(profile),
            Err(error) => {
                if let Some(credential_id) = credential_id {
                    self.delete_secret_best_effort(credential_id, "persist_shared_connection");
                }
                match self
                    .control_plane
                    .delete_connection(&account.user.id, workspace_id, created.id.into())
                    .await
                {
                    Ok(()) => {
                        if let Err(cache_error) = self
                            .repository
                            .purge_remote_connection_cache(workspace_id, created.id.into())
                            .await
                        {
                            tracing::warn!(
                                connection_id = %created.id,
                                %cache_error,
                                "rolled-back shared connection cache cleanup deferred"
                            );
                        }
                    }
                    Err(rollback_error) => tracing::warn!(
                        connection_id = %created.id,
                        %rollback_error,
                        "shared connection rollback deferred"
                    ),
                }
                Err(error)
            }
        }
    }

    /// Store one member's database credential only in the OS credential store and
    /// atomically publish the new binding revision for a shared template.
    pub(crate) async fn bind_connection_credentials(
        &self,
        request: WorkspaceCredentialBindingRequest,
    ) -> AppResult<ConnectionProfile> {
        let WorkspaceCredentialBindingRequest {
            connection_id,
            username,
            password,
        } = request;
        let username = validate_member_username(&username)?;
        if password.is_empty() || password.len() > MAX_CONNECTION_CREDENTIAL_BYTES {
            return Err(AppError::Config(
                "connection credential is empty or exceeds the size limit".into(),
            ));
        }
        let mutation = self
            .runtime
            .begin_connection_mutation(connection_id)
            .await?;
        let profile = mutation.profile().clone();
        if profile.workspace_access == WorkspaceConnectionAccess::Local {
            return Err(AppError::Config(
                "connection is not a shared workspace template".into(),
            ));
        }
        if profile.credential_mode != WorkspaceCredentialMode::MemberLocal {
            return Err(AppError::Blocked {
                reason: "this shared connection uses automatically managed credentials".into(),
            });
        }
        if !profile.workspace_access.can_read() {
            return Err(AppError::Blocked {
                reason: "your workspace role cannot execute this connection".into(),
            });
        }
        let account_user_id = mutation.selected_account_id()?;
        let previous_credential_id = profile
            .secret_ref
            .as_deref()
            .map(Uuid::parse_str)
            .transpose()
            .map_err(|_| AppError::Config("connection secret reference is invalid".into()))?;
        // Copy-on-write prevents a password-only rotation from mutating credential
        // material behind an unchanged binding revision.
        let credential_id = Uuid::new_v4();
        self.credentials.store(&credential_id, password.as_str())?;
        let credential_ref = credential_id.to_string();
        match self
            .repository
            .bind_connection_credentials(
                connection_id,
                &account_user_id,
                username,
                &profile.extra_params,
                Some(&credential_ref),
            )
            .await
        {
            Ok(profile) => {
                mutation.retire(connection_id).await;
                if let Some(previous_credential_id) = previous_credential_id {
                    self.delete_secret_best_effort(
                        previous_credential_id,
                        "replace_workspace_connection_credentials",
                    );
                }
                Ok(profile)
            }
            Err(error) => {
                self.delete_secret_best_effort(credential_id, "bind_connection_credentials");
                Err(error)
            }
        }
    }

    pub(super) fn delete_secret_best_effort(&self, id: Uuid, action: &'static str) {
        if let Err(error) = self.credentials.delete(&id) {
            tracing::warn!(credential_id = %id, %error, action, "credential cleanup deferred");
        }
    }
}
