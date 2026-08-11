import { invoke } from "../../ipc/core";

export interface AutomationRunnerSettings {
  backgroundAllowed: boolean;
  launchAtLogin: boolean;
}

export function getAutomationRunnerSettings() {
  return invoke<AutomationRunnerSettings>("automation_runner_settings");
}

export function setAutomationRunnerBackgroundAllowed(allowed: boolean) {
  return invoke<AutomationRunnerSettings>("set_automation_runner_background_allowed", {
    allowed,
  });
}
