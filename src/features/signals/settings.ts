import { invoke } from "../../ipc/core";

export interface SignalRunnerSettings {
  backgroundAllowed: boolean;
  launchAtLogin: boolean;
}

export function getSignalRunnerSettings() {
  return invoke<SignalRunnerSettings>("signal_runner_settings");
}

export function setSignalRunnerBackgroundAllowed(allowed: boolean) {
  return invoke<SignalRunnerSettings>("set_signal_runner_background_allowed", { allowed });
}
