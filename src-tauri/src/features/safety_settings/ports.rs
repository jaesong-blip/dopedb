//! Authority and persistence contract required by Safety settings use cases.

use std::future::Future;

use uuid::Uuid;

use crate::error::AppResult;
use crate::model::SafetySettings;

pub(crate) trait SafetySettingsPort: Clone + Send + Sync + 'static {
    fn get(&self, connection_id: Uuid) -> impl Future<Output = AppResult<SafetySettings>> + Send;

    fn update(
        &self,
        connection_id: Uuid,
        settings: SafetySettings,
    ) -> impl Future<Output = AppResult<()>> + Send;
}
