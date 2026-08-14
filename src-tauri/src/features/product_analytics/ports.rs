use std::future::Future;

use crate::error::AppResult;

use super::domain::{ProductAnalyticsConsent, ProductAnalyticsConsentState};

pub(super) trait ProductAnalyticsConsentPort: Clone + Send + Sync + 'static {
    fn state(&self) -> impl Future<Output = AppResult<ProductAnalyticsConsentState>> + Send;
    fn set_consent(
        &self,
        consent: ProductAnalyticsConsent,
    ) -> impl Future<Output = AppResult<ProductAnalyticsConsentState>> + Send;
}
