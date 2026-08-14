use reqwest::StatusCode;
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::hosted_control_plane;
use crate::state::AppState;

use super::domain::{ProductAnalyticsBatchV1, ProductAnalyticsConsent};

const PRODUCT_ANALYTICS_ROUTE: &str = "/api/v1/product-analytics/events";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductAnalyticsStatus {
    enabled: bool,
    consent: ProductAnalyticsConsent,
    generation: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductAnalyticsSubmitReceipt {
    accepted: bool,
}

fn enabled() -> bool {
    matches!(option_env!("DOPEDB_PRODUCT_ANALYTICS_ENABLED"), Some("1"))
        && !cfg!(feature = "packaged-benchmark")
}

#[tauri::command]
pub async fn product_analytics_status(
    state: State<'_, AppState>,
) -> AppResult<ProductAnalyticsStatus> {
    let analytics = state.services.product_analytics.state().await?;
    Ok(ProductAnalyticsStatus {
        enabled: enabled(),
        consent: analytics.consent,
        generation: analytics.generation,
    })
}

#[tauri::command]
pub async fn set_product_analytics_consent(
    state: State<'_, AppState>,
    consent: ProductAnalyticsConsent,
) -> AppResult<ProductAnalyticsStatus> {
    let analytics = state
        .services
        .product_analytics
        .set_consent(consent)
        .await?;
    Ok(ProductAnalyticsStatus {
        enabled: enabled(),
        consent: analytics.consent,
        generation: analytics.generation,
    })
}

#[tauri::command]
pub async fn submit_product_analytics_batch(
    state: State<'_, AppState>,
    batch: ProductAnalyticsBatchV1,
) -> AppResult<ProductAnalyticsSubmitReceipt> {
    if !enabled() {
        return Ok(ProductAnalyticsSubmitReceipt { accepted: false });
    }
    if state.services.product_analytics.state().await?.consent != ProductAnalyticsConsent::Granted {
        return Err(AppError::Blocked {
            reason: "product analytics require explicit consent".into(),
        });
    }
    batch
        .validate(chrono::Utc::now())
        .map_err(|reason| AppError::Blocked {
            reason: reason.to_string(),
        })?;

    let endpoint = format!(
        "{}{}",
        hosted_control_plane::origin()?,
        PRODUCT_ANALYTICS_ROUTE
    );
    let response = hosted_control_plane::client()?
        .post(endpoint)
        .header("x-dopedb-product-analytics-contract", "1")
        .json(&batch)
        .send()
        .await
        .map_err(|error| {
            hosted_control_plane::request_error("submitting product analytics", error)
        })?;

    if response.status() != StatusCode::ACCEPTED {
        return Err(hosted_control_plane::response_error(response).await);
    }
    Ok(ProductAnalyticsSubmitReceipt { accepted: true })
}
