import { invoke } from "../../ipc/core";

import type { SafetySettings } from "../../ipc/types";

export function getSafetySettings(
  connectionId: string,
): Promise<SafetySettings> {
  return invoke("get_safety", { id: connectionId });
}
