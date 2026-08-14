import { openUrl } from "@tauri-apps/plugin-opener";

export const PRODUCT_ANALYTICS_PRIVACY_URL = "https://dopedb.dev/privacy";

export function openProductAnalyticsPrivacyPolicy() {
  return openUrl(PRODUCT_ANALYTICS_PRIVACY_URL).catch(() => undefined);
}
