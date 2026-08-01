//! Scope-aware per-connection safety settings.

mod application;
mod ports;

use uuid::Uuid;

use crate::connection::{ConnectionAccess, ConnectionManager};
use crate::error::AppResult;
use crate::model::{SafetySettings, WorkspaceCredentialMode};
use crate::store::Store;

use application::SafetyUseCases;
use ports::SafetySettingsPort;

#[derive(Clone)]
struct SafetyPlatformAdapter {
    store: Store,
    connections: ConnectionManager,
}

type ComposedSafetyApplication = SafetyUseCases<SafetyPlatformAdapter>;

#[derive(Clone)]
pub(crate) struct SafetySettingsFeature {
    application: ComposedSafetyApplication,
}

impl SafetySettingsFeature {
    pub(crate) async fn get(&self, connection_id: Uuid) -> AppResult<SafetySettings> {
        self.application.get(connection_id).await
    }

    pub(crate) async fn update(
        &self,
        connection_id: Uuid,
        settings: SafetySettings,
    ) -> AppResult<()> {
        self.application.update(connection_id, settings).await
    }
}

pub(crate) fn compose(store: Store, connections: ConnectionManager) -> SafetySettingsFeature {
    SafetySettingsFeature {
        application: SafetyUseCases::new(SafetyPlatformAdapter::new(store, connections)),
    }
}

impl SafetyPlatformAdapter {
    fn new(store: Store, connections: ConnectionManager) -> Self {
        Self { store, connections }
    }

    pub(crate) async fn get(&self, connection_id: Uuid) -> AppResult<SafetySettings> {
        self.store.get_safety(connection_id).await
    }

    /// Normalize untrusted UI limits and persist them under an online connection
    /// authorization guard. Read-only workspace roles can never enable writes.
    pub(crate) async fn update(
        &self,
        connection_id: Uuid,
        mut settings: SafetySettings,
    ) -> AppResult<()> {
        let profile = self.store.get_connection(connection_id).await?;
        if !profile.workspace_access.can_write()
            || profile.credential_mode != WorkspaceCredentialMode::Local
        {
            settings.allow_writes = false;
        }
        let _mutation = self
            .connections
            .begin_connection_mutation(
                connection_id,
                if settings.allow_writes {
                    ConnectionAccess::Write
                } else {
                    ConnectionAccess::Read
                },
            )
            .await?;
        settings.max_rows = settings.max_rows.clamp(1, 100_000);
        settings.exec_preview_row_limit = settings.exec_preview_row_limit.clamp(0, 1_000_000);
        self.store.set_safety(connection_id, &settings).await
    }
}

impl SafetySettingsPort for SafetyPlatformAdapter {
    fn get(
        &self,
        connection_id: Uuid,
    ) -> impl std::future::Future<Output = AppResult<SafetySettings>> + Send {
        SafetyPlatformAdapter::get(self, connection_id)
    }

    fn update(
        &self,
        connection_id: Uuid,
        settings: SafetySettings,
    ) -> impl std::future::Future<Output = AppResult<()>> + Send {
        SafetyPlatformAdapter::update(self, connection_id, settings)
    }
}
