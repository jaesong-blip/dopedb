import { useState } from "react";

import { Button } from "../../../design-system/components/Button";
import { CheckboxField } from "../../../design-system/components/FormControls";
import { SettingsGroup } from "../../../design-system/components/Settings";
import {
  denyProductAnalyticsConsent,
  grantProductAnalyticsConsent,
  useProductAnalyticsSnapshot,
} from "../../../features/productAnalytics/client";
import { openProductAnalyticsPrivacyPolicy } from "../../../features/productAnalytics/privacyPolicy";
import { useI18n } from "../../../lib/i18n";

export default function PrivacySettings() {
  const { t } = useI18n();
  const analytics = useProductAnalyticsSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function updateConsent(granted: boolean) {
    setBusy(true);
    setError(false);
    const saved = granted
      ? await grantProductAnalyticsConsent()
      : await denyProductAnalyticsConsent();
    if (!saved) setError(true);
    setBusy(false);
  }

  const canChange = analytics.availability === "available" ||
    analytics.consent === "granted";

  return (
    <div className="tw:grid tw:w-full tw:max-w-[800px] tw:gap-4 tw:p-4 tw:@max-[700px]:p-0">
      <div className="tw:grid tw:gap-1">
        <h2 className="tw:m-0">{t("productAnalytics.settingsTitle")}</h2>
        <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
          {t("productAnalytics.settingsBody")}
        </p>
      </div>

      <SettingsGroup title={t("settings.privacy")}>
        <div className="tw:grid tw:min-w-0 tw:gap-1 tw:py-2">
          <CheckboxField
            checked={analytics.consent === "granted"}
            disabled={busy || analytics.availability === "checking" || !canChange}
            onChange={(event) => void updateConsent(event.target.checked)}
            label={t("productAnalytics.settingLabel")}
          />
          <p className="tw:m-0 tw:pl-6 tw:text-xs tw:leading-body tw:text-muted-foreground">
            {t("productAnalytics.description")}
          </p>
          <p className="tw:m-0 tw:pl-6 tw:text-xs tw:leading-body tw:text-muted-foreground">
            {t("productAnalytics.identityDescription")}
          </p>
          <p className="tw:m-0 tw:pl-6 tw:text-xs tw:leading-body tw:text-muted-foreground">
            {t("productAnalytics.retentionDescription")}
          </p>
          <p className="tw:m-0 tw:pl-6 tw:text-xs tw:leading-body tw:text-muted-foreground">
            {t("productAnalytics.revokeBody")}
          </p>
          <div className="tw:flex tw:justify-start tw:pl-4">
            <Button
              size="compact"
              variant="ghost"
              onClick={() => void openProductAnalyticsPrivacyPolicy()}
            >
              {t("productAnalytics.privacyPolicy")}
            </Button>
          </div>
          {error ? (
            <p
              role="alert"
              className="tw:m-0 tw:pl-6 tw:text-xs tw:leading-body tw:text-danger"
            >
              {t("productAnalytics.updateFailed")}
            </p>
          ) : null}
        </div>
      </SettingsGroup>

      {analytics.availability === "unavailable" ? (
        <SettingsGroup title={t("productAnalytics.disabledTitle")}>
          <p className="tw:m-0 tw:py-2 tw:text-sm tw:leading-body tw:text-muted-foreground">
            {t("productAnalytics.disabledBody")}
          </p>
        </SettingsGroup>
      ) : null}
    </div>
  );
}
