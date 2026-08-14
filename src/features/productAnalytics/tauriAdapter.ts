// Native product analytics owns endpoint availability and authenticated batch
// delivery. The WebView never receives a URL, token, or generic HTTP primitive.
import { invoke } from "../../ipc/core";
import type {
  ProductAnalyticsBatch,
  ProductAnalyticsConsent,
  ProductAnalyticsStatus,
  ProductAnalyticsSubmitReceipt,
} from "./domain";

export function productAnalyticsStatus(): Promise<ProductAnalyticsStatus> {
  return invoke("product_analytics_status");
}

export function setProductAnalyticsConsent(
  consent: ProductAnalyticsConsent,
): Promise<ProductAnalyticsStatus> {
  return invoke("set_product_analytics_consent", { consent });
}

export function submitProductAnalyticsBatch(
  batch: ProductAnalyticsBatch,
): Promise<ProductAnalyticsSubmitReceipt> {
  return invoke("submit_product_analytics_batch", { batch });
}
