import { useState } from "react";

import { Button } from "../../design-system/components/Button";
import { useI18n } from "../../lib/i18n";
import {
  denyProductAnalyticsConsent,
  grantProductAnalyticsConsent,
  useProductAnalyticsSnapshot,
} from "./client";
import { openProductAnalyticsPrivacyPolicy } from "./privacyPolicy";

export function ProductAnalyticsConsentPrompt() {
  const { t } = useI18n();
  const analytics = useProductAnalyticsSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  if (
    analytics.availability !== "available" ||
    analytics.consent !== "pending"
  ) {
    return null;
  }

  async function choose(granted: boolean) {
    setBusy(true);
    setError(false);
    const saved = granted
      ? await grantProductAnalyticsConsent()
      : await denyProductAnalyticsConsent();
    if (!saved) setError(true);
    setBusy(false);
  }

  return (
    <section
      aria-labelledby="product-analytics-consent-title"
      className="tw:mb-4 tw:grid tw:gap-2 tw:border-b tw:border-border-subtle tw:pb-4"
    >
      <h2 id="product-analytics-consent-title" className="tw:m-0 tw:text-base">
        {t("productAnalytics.onboardingTitle")}
      </h2>
      <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
        {t("productAnalytics.onboardingBody")}
      </p>
      <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">
        {t("productAnalytics.description")}
      </p>
      <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">
        {t("productAnalytics.identityDescription")}
      </p>
      <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">
        {t("productAnalytics.retentionDescription")}
      </p>
      <div className="tw:grid tw:grid-cols-2 tw:gap-2">
        <Button
          size="compact"
          disabled={busy}
          onClick={() => void choose(true)}
        >
          {t("productAnalytics.accept")}
        </Button>
        <Button
          size="compact"
          disabled={busy}
          onClick={() => void choose(false)}
        >
          {t("productAnalytics.decline")}
        </Button>
      </div>
      <div className="tw:flex tw:justify-start">
        <Button
          size="compact"
          variant="ghost"
          onClick={() => void openProductAnalyticsPrivacyPolicy()}
        >
          {t("productAnalytics.privacyPolicy")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="tw:m-0 tw:text-xs tw:text-danger">
          {t("productAnalytics.updateFailed")}
        </p>
      ) : null}
    </section>
  );
}
