import { useEffect, useState } from "react";
import { CheckboxField } from "../../../design-system/components/FormControls";
import { SettingsGroup } from "../../../design-system/components/Settings";
import {
  saveAgentDebugDetails,
  useAgentDebugDetails,
} from "../../../features/agents/displayPreferences";
import { useI18n } from "../../../lib/i18n";
import {
  getAutomationRunnerSettings,
  setAutomationRunnerBackgroundAllowed,
} from "../../../features/automationRunner/settings";

export default function AdvancedSettings() {
  const { t } = useI18n();
  const agentDebugDetails = useAgentDebugDetails();
  const [backgroundAllowed, setBackgroundAllowed] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [monitoringBusy, setMonitoringBusy] = useState(true);
  const [monitoringError, setMonitoringError] = useState("");

  useEffect(() => {
    void getAutomationRunnerSettings().then((settings) => {
      setBackgroundAllowed(settings.backgroundAllowed);
      setLaunchAtLogin(settings.launchAtLogin);
      setMonitoringBusy(false);
    }).catch((error) => {
      setMonitoringError(error instanceof Error ? error.message : String(error));
      setMonitoringBusy(false);
    });
  }, []);

  async function changeBackgroundMonitoring(allowed: boolean) {
    setMonitoringBusy(true);
    setMonitoringError("");
    try {
      const settings = await setAutomationRunnerBackgroundAllowed(allowed);
      setBackgroundAllowed(settings.backgroundAllowed);
      setLaunchAtLogin(settings.launchAtLogin);
    } catch (error) {
      setMonitoringError(error instanceof Error ? error.message : String(error));
    } finally {
      setMonitoringBusy(false);
    }
  }

  return (
    <div className="tw:grid tw:w-full tw:max-w-[800px] tw:gap-4 tw:p-4 tw:@max-[700px]:p-0">
      <div className="tw:grid tw:gap-1">
        <h2 className="tw:m-0">{t("settings.advanced")}</h2>
        <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
          {t("settings.advancedBody")}
        </p>
      </div>

      <SettingsGroup title={t("settings.debugging")}>
        <div className="tw:grid tw:min-w-0 tw:gap-1 tw:py-2">
          <CheckboxField
            checked={agentDebugDetails}
            onChange={(event) => saveAgentDebugDetails(event.target.checked)}
            label={t("settings.agentDebugDetails")}
          />
          <p className="tw:m-0 tw:pl-6 tw:text-xs tw:leading-body tw:text-muted-foreground">
            {t("settings.agentDebugDetailsBody")}
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.monitoring")}>
        <div className="tw:grid tw:min-w-0 tw:gap-1 tw:py-2">
          <CheckboxField
            checked={backgroundAllowed}
            disabled={monitoringBusy}
            onChange={(event) => void changeBackgroundMonitoring(event.target.checked)}
            label={t("settings.backgroundMonitoring")}
          />
          <p className="tw:m-0 tw:pl-6 tw:text-xs tw:leading-body tw:text-muted-foreground">
            {t("settings.backgroundMonitoringBody")}
          </p>
          <p className="tw:m-0 tw:pl-6 tw:font-mono tw:text-xs tw:text-muted-foreground">
            {t(launchAtLogin ? "settings.launchAtLoginEnabled" : "settings.launchAtLoginDisabled")}
          </p>
          {monitoringError ? (
            <p className="tw:m-0 tw:pl-6 tw:text-xs tw:text-danger">{monitoringError}</p>
          ) : null}
        </div>
      </SettingsGroup>
    </div>
  );
}
