//! Workspace/account selection and remote synchronization use cases.

use crate::error::{AppError, AppResult};
use crate::features::connections::ConnectionCredentialVault;
use crate::kernel::identity::{AccountId, WorkspaceId};

use super::super::domain::{
    DashboardOutboxOperation, DashboardPushResult, Workspace, WorkspaceAuthUser, WorkspaceKind,
};
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
            if let Err(error) = self
                .sync_workspace_resources(&account_user_id, workspace.id)
                .await
            {
                tracing::warn!(workspace_id = %workspace.id, %error, "workspace resource sync deferred after switch");
            }
        }
        Ok(workspace)
    }

    pub(crate) async fn activate_account(&self, user_id: AccountId) -> AppResult<Workspace> {
        let user = self.validated_user(&user_id).await?;
        self.sync_account_memberships(&user).await?;
        let workspace = self.runtime.activate_account(&user_id).await?;
        if workspace.kind == WorkspaceKind::Team {
            if let Err(error) = self.sync_workspace_resources(&user_id, workspace.id).await {
                tracing::warn!(workspace_id = %workspace.id, %error, "workspace resource sync deferred after account switch");
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
            if let Err(error) = self.sync_workspace_resources(&user.id, active.id).await {
                tracing::warn!(workspace_id = %active.id, %error, "workspace resource sync deferred after membership refresh");
            }
        }
        Ok(())
    }

    /// Refresh the active Team workspace's dashboard definitions without making
    /// local inspection depend on control-plane availability. The dashboard screen
    /// calls this before reading its SQLite projection so Agent-created definitions
    /// are shared even when the workspace selection itself did not change.
    pub(crate) async fn refresh_dashboards(&self) -> AppResult<()> {
        let workspace = self.repository.active_workspace().await?;
        if workspace.kind == WorkspaceKind::Personal {
            return Ok(());
        }
        let account_user_id = self.repository.active_account_id().await?.ok_or_else(|| {
            AppError::Config("team dashboard sync requires an active account".into())
        })?;
        self.sync_workspace_resources(&account_user_id, workspace.id)
            .await
    }

    /// Serialize one account/workspace pull so a late full-collection response can
    /// never overwrite a newer cursor page. Each page checkpoint is committed only
    /// after all selected projections have been reconciled successfully.
    pub(super) async fn sync_workspace_resources(
        &self,
        account_user_id: &AccountId,
        workspace_id: WorkspaceId,
    ) -> AppResult<()> {
        let _sync_guard = self.sync_lock.lock().await;
        let mut cursor = self
            .repository
            .workspace_pull_cursor(workspace_id, account_user_id)
            .await?;
        for _ in 0..64 {
            let Some(page) = self
                .control_plane
                .workspace_pull_page(account_user_id, workspace_id, cursor)
                .await?
            else {
                // During a rolling deployment, retain the previous full-snapshot
                // behavior and do not invent a checkpoint for a missing cursor API.
                self.sync_connections(account_user_id, workspace_id).await?;
                self.sync_dashboards(account_user_id, workspace_id).await?;
                return Ok(());
            };
            let has_pending_dashboards = !self
                .repository
                .pending_dashboard_mutations(workspace_id, account_user_id)
                .await?
                .is_empty();
            if page.refresh_connections {
                self.sync_connections(account_user_id, workspace_id).await?;
            }
            if page.refresh_dashboards || has_pending_dashboards {
                self.sync_dashboards(account_user_id, workspace_id).await?;
            }
            // Reports intentionally have no second desktop reader projection: the
            // strict outbound outbox is replayed by the report feature and the web
            // workspace owns review/publish reads. The cursor still orders those
            // audit facts so later resource kinds cannot be skipped.
            if page.refresh_reports {
                tracing::debug!(
                    %workspace_id,
                    report_tombstone = page.report_tombstone,
                    "workspace report change retained by web-authoritative reader"
                );
            }
            if page.connection_tombstone || page.dashboard_tombstone {
                tracing::debug!(
                    %workspace_id,
                    connection_tombstone = page.connection_tombstone,
                    dashboard_tombstone = page.dashboard_tombstone,
                    "workspace tombstones reconciled through authoritative collections"
                );
            }
            self.repository
                .commit_workspace_pull_cursor(workspace_id, account_user_id, cursor, page)
                .await?;
            cursor = Some(page.next_cursor);
            if !page.has_more {
                return Ok(());
            }
        }
        Err(AppError::Network(
            "workspace sync exceeded the bounded cursor replay window".into(),
        ))
    }

    async fn sync_connections(
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
            Ok(None) => Err(AppError::Network(
                "shared connection collection is unavailable during cursor sync".into(),
            )),
            Err(error) => Err(error),
        }
    }

    async fn sync_dashboards(
        &self,
        account_user_id: &AccountId,
        workspace_id: WorkspaceId,
    ) -> AppResult<()> {
        let initial_remote = match self
            .control_plane
            .remote_dashboards(account_user_id, workspace_id)
            .await
        {
            Ok(Some(dashboards)) => dashboards,
            Ok(None) => {
                return Err(AppError::Network(
                    "shared dashboard collection is unavailable during cursor sync".into(),
                ));
            }
            Err(error) => return Err(error),
        };

        let pending = self
            .repository
            .pending_dashboard_mutations(workspace_id, account_user_id)
            .await?;
        let had_pending = !pending.is_empty();
        for mutation in pending {
            let result = match mutation.operation {
                DashboardOutboxOperation::Upsert => {
                    self.control_plane
                        .upsert_dashboard(account_user_id, workspace_id, &mutation)
                        .await
                }
                DashboardOutboxOperation::Delete => {
                    self.control_plane
                        .delete_dashboard(account_user_id, workspace_id, &mutation)
                        .await
                }
            };
            match result {
                Ok(DashboardPushResult::Applied(remote)) => {
                    self.repository
                        .acknowledge_dashboard_mutation(workspace_id, &mutation, Some(&remote))
                        .await?;
                }
                Ok(DashboardPushResult::Deleted(_remote_revision)) => {
                    self.repository
                        .acknowledge_dashboard_mutation(workspace_id, &mutation, None)
                        .await?;
                }
                Ok(DashboardPushResult::Conflict) => {
                    self.repository
                        .mark_dashboard_conflict(workspace_id, &mutation)
                        .await?;
                }
                Err(error) => {
                    tracing::warn!(
                        %workspace_id,
                        dashboard_id = %mutation.dashboard_id,
                        %error,
                        "workspace dashboard push deferred"
                    );
                }
            }
        }

        let remote = if had_pending {
            match self
                .control_plane
                .remote_dashboards(account_user_id, workspace_id)
                .await
            {
                Ok(Some(dashboards)) => dashboards,
                Ok(None) => {
                    return Err(AppError::Network(
                        "shared dashboard collection disappeared during cursor sync".into(),
                    ));
                }
                Err(error) => return Err(error),
            }
        } else {
            initial_remote
        };
        self.repository
            .sync_remote_dashboards(workspace_id, account_user_id, &remote)
            .await
    }
}
