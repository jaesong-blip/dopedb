//! Workspace/account selection and remote synchronization use cases.

use crate::error::{AppError, AppResult};
use crate::features::connections::ConnectionCredentialVault;
use crate::kernel::identity::{AccountId, WorkspaceId};

use super::super::domain::{Workspace, WorkspaceAuthUser, WorkspaceKind};
use super::super::ports::{
    WorkspaceConfigurationPort, WorkspaceControlPlanePort, WorkspaceRepositoryPort,
    WorkspaceRuntimePort,
};
use super::WorkspaceUseCases;

impl<R, A, C, V, E> WorkspaceUseCases<R, A, C, V, E>
where
    R: WorkspaceRepositoryPort,
    A: WorkspaceRuntimePort,
    C: WorkspaceControlPlanePort,
    V: ConnectionCredentialVault + ?Sized,
    E: WorkspaceConfigurationPort,
{
    pub(crate) fn console_url(&self, workspace_id: Option<WorkspaceId>) -> AppResult<String> {
        self.control_plane.console_url(workspace_id)
    }

    pub(crate) async fn list(&self) -> AppResult<Vec<Workspace>> {
        self.repository.list_workspaces().await
    }

    /// Explicitly refresh hosted memberships without changing the cached authentication
    /// presentation. The desktop calls this after returning from web settings.
    pub(crate) async fn refresh_memberships(&self) -> AppResult<Vec<Workspace>> {
        let accounts = self.repository.accounts().await?;
        for account in accounts {
            match self.control_plane.auth_user(&account.user.id).await {
                Ok(Some(user)) => self.sync_account_memberships(&user).await?,
                Ok(None) => {
                    self.runtime.remove_account(&account.user.id).await?;
                }
                Err(error) => tracing::warn!(
                    user_id = %account.user.id,
                    %error,
                    "workspace account refresh deferred"
                ),
            }
        }
        self.ensure_active_account().await?;
        self.repository.list_workspaces().await
    }

    pub(crate) async fn active(&self) -> AppResult<Workspace> {
        self.repository.active_workspace().await
    }

    pub(crate) async fn activate(
        &self,
        id: WorkspaceId,
        account_user_id: Option<AccountId>,
    ) -> AppResult<Workspace> {
        let target = self
            .repository
            .list_workspaces()
            .await?
            .into_iter()
            .find(|workspace| workspace.id == id)
            .ok_or_else(|| AppError::NotFound(format!("workspace {id}")))?;
        if target.kind == WorkspaceKind::Team {
            let user_id = account_user_id.as_ref().ok_or_else(|| {
                AppError::Config("team workspace selection requires an account".into())
            })?;
            let user = self.validated_user(user_id).await?;
            self.sync_account_memberships(&user).await?;
        }
        let workspace = self
            .runtime
            .activate_workspace(id, account_user_id.as_ref())
            .await?;
        if workspace.kind == WorkspaceKind::Team {
            let account_user_id = account_user_id.ok_or_else(|| {
                AppError::Config("team workspace selection requires an account".into())
            })?;
            if let Err(error) = self.sync_connections(&account_user_id, workspace.id).await {
                tracing::warn!(workspace_id = %workspace.id, %error, "workspace connection sync deferred after switch");
            }
        }
        Ok(workspace)
    }

    pub(crate) async fn activate_account(&self, user_id: AccountId) -> AppResult<Workspace> {
        let user = self.validated_user(&user_id).await?;
        self.sync_account_memberships(&user).await?;
        let workspace = self.runtime.activate_account(&user_id).await?;
        if workspace.kind == WorkspaceKind::Team {
            if let Err(error) = self.sync_connections(&user_id, workspace.id).await {
                tracing::warn!(workspace_id = %workspace.id, %error, "workspace connection sync deferred after account switch");
            }
        }
        Ok(workspace)
    }

    pub(super) async fn sync_account_memberships(&self, user: &WorkspaceAuthUser) -> AppResult<()> {
        self.repository.remember_account(user).await?;
        let remote = self.control_plane.remote_workspaces(&user.id).await?;
        let workspaces = remote
            .into_iter()
            .map(|workspace| (workspace.id, workspace.name, workspace.role))
            .collect::<Vec<_>>();
        self.runtime
            .sync_account_workspaces(user, &workspaces)
            .await?;
        let active = self.repository.active_workspace().await?;
        if active.kind == WorkspaceKind::Team
            && self.repository.active_account_id().await?.as_ref() == Some(&user.id)
        {
            self.sync_connections(&user.id, active.id).await?;
        }
        Ok(())
    }

    pub(super) async fn sync_connections(
        &self,
        account_user_id: &AccountId,
        workspace_id: WorkspaceId,
    ) -> AppResult<()> {
        match self
            .control_plane
            .remote_connections(account_user_id, workspace_id)
            .await
        {
            Ok(Some(connections)) => {
                let removed_credential_ids = self
                    .runtime
                    .sync_remote_connections(workspace_id, account_user_id, &connections)
                    .await?;
                for credential_id in removed_credential_ids {
                    self.delete_secret_best_effort(credential_id, "remove_remote_connection");
                }
                Ok(())
            }
            Ok(None) => {
                tracing::info!(
                    %workspace_id,
                    "shared connection API is not deployed yet; keeping the local workspace cache"
                );
                Ok(())
            }
            Err(error) => {
                // Switching is local and remains usable during a control-plane outage.
                // Shared execution still requires a fresh online authorization, so this
                // stale cache cannot broaden database access.
                tracing::warn!(%workspace_id, %error, "workspace connection sync deferred");
                Ok(())
            }
        }
    }
}
