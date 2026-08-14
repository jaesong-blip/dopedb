use crate::error::{AppError, AppResult};
use crate::store::Store;

use super::domain::{ProductAnalyticsConsent, ProductAnalyticsConsentState};
use super::ports::ProductAnalyticsConsentPort;

const CONSENT_KEY: &str = "product_analytics_consent_v1";
const GENERATION_KEY: &str = "product_analytics_consent_generation_v1";

#[derive(Clone)]
pub(super) struct SqliteProductAnalyticsConsent {
    store: Store,
}

impl SqliteProductAnalyticsConsent {
    pub(super) fn new(store: Store) -> Self {
        Self { store }
    }
}

impl ProductAnalyticsConsentPort for SqliteProductAnalyticsConsent {
    async fn state(&self) -> AppResult<ProductAnalyticsConsentState> {
        let (consent, generation) = sqlx::query_as(
            "SELECT
               MAX(CASE WHEN key = ?1 THEN value END),
               MAX(CASE WHEN key = ?2 THEN value END)
             FROM app_settings
             WHERE key IN (?1, ?2)",
        )
        .bind(CONSENT_KEY)
        .bind(GENERATION_KEY)
        .fetch_one(self.store.pool())
        .await?;
        stored_state(consent, generation)
    }

    async fn set_consent(
        &self,
        consent: ProductAnalyticsConsent,
    ) -> AppResult<ProductAnalyticsConsentState> {
        let mut transaction = self.store.pool().begin().await?;
        let (stored_consent, stored_generation) = sqlx::query_as(
            "SELECT
               MAX(CASE WHEN key = ?1 THEN value END),
               MAX(CASE WHEN key = ?2 THEN value END)
             FROM app_settings
             WHERE key IN (?1, ?2)",
        )
        .bind(CONSENT_KEY)
        .bind(GENERATION_KEY)
        .fetch_one(&mut *transaction)
        .await?;
        let current = stored_state(stored_consent, stored_generation)?;
        if current.consent == consent {
            transaction.commit().await?;
            return Ok(current);
        }
        let generation = current.generation.checked_add(1).ok_or_else(|| {
            AppError::Config("product analytics consent generation overflow".into())
        })?;
        sqlx::query(
            "INSERT INTO app_settings (key, value)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(CONSENT_KEY)
        .bind(consent.as_str())
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO app_settings (key, value)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(GENERATION_KEY)
        .bind(generation.to_string())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(ProductAnalyticsConsentState {
            consent,
            generation,
        })
    }
}

fn stored_state(
    consent: Option<String>,
    generation: Option<String>,
) -> AppResult<ProductAnalyticsConsentState> {
    let consent = match consent.as_deref() {
        None | Some("pending") => ProductAnalyticsConsent::Pending,
        Some("granted") => ProductAnalyticsConsent::Granted,
        Some("denied") => ProductAnalyticsConsent::Denied,
        Some(_) => {
            return Err(AppError::Config(
                "stored product analytics consent is invalid".into(),
            ));
        }
    };
    let generation = generation
        .as_deref()
        .unwrap_or("0")
        .parse::<u32>()
        .map_err(|_| AppError::Config("stored product analytics generation is invalid".into()))?;
    Ok(ProductAnalyticsConsentState {
        consent,
        generation,
    })
}
