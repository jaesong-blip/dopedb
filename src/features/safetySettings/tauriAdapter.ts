import { invoke } from "../../ipc/core";

import type { SafetySettings } from "../../ipc/types";

export function getSafetySettings(
  connectionId: string,
): Promise<SafetySettings> {
  return invoke("get_safety", { id: connectionId });
}

export function setSafetySettings(
  connectionId: string,
  settings: SafetySettings,
): Promise<void> {
  return invoke("set_safety", { id: connectionId, settings });
}
