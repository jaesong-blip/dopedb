//! Safety settings use cases independent of concrete storage and connection adapters.

use uuid::Uuid;

use crate::error::AppResult;
use crate::model::SafetySettings;

use super::ports::SafetySettingsPort;

#[derive(Clone)]
pub(crate) struct SafetyUseCases<P> {
    port: P,
}

impl<P> SafetyUseCases<P>
where
    P: SafetySettingsPort,
{
    pub(crate) fn new(port: P) -> Self {
        Self { port }
    }

    pub(crate) async fn get(&self, connection_id: Uuid) -> AppResult<SafetySettings> {
        self.port.get(connection_id).await
    }

    pub(crate) async fn update(
        &self,
        connection_id: Uuid,
        settings: SafetySettings,
    ) -> AppResult<()> {
        self.port.update(connection_id, settings).await
    }
}
