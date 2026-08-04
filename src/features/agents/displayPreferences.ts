import { useEffect, useState } from "react";

const DEBUG_DETAILS_STORAGE_KEY = "dopedb.agent-debug-details.v1";
const DEBUG_DETAILS_CHANGE_EVENT = "dopedb:agent-debug-details-changed";

export function loadAgentDebugDetails() {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(DEBUG_DETAILS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAgentDebugDetails(enabled: boolean) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DEBUG_DETAILS_STORAGE_KEY, enabled ? "1" : "0");
    window.dispatchEvent(new Event(DEBUG_DETAILS_CHANGE_EVENT));
  } catch {
    // Keep the safe default when browser storage is unavailable.
  }
}

export function useAgentDebugDetails() {
  const [enabled, setEnabled] = useState(loadAgentDebugDetails);

  useEffect(() => {
    const sync = () => setEnabled(loadAgentDebugDetails());
    window.addEventListener(DEBUG_DETAILS_CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(DEBUG_DETAILS_CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return enabled;
}
