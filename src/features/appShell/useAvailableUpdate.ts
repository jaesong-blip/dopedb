import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function useAvailableUpdate() {
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const checkInFlight = useRef(false);
  const lastCheckAt = useRef(0);

  const refresh = useCallback(async () => {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    try {
      setAvailableUpdate(await check());
    } catch {
      // Update discovery is advisory; settings exposes the explicit retry surface.
    } finally {
      lastCheckAt.current = Date.now();
      checkInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), UPDATE_CHECK_INTERVAL_MS);
    const onVisibility = () => {
      if (
        !document.hidden &&
        Date.now() - lastCheckAt.current >= UPDATE_CHECK_INTERVAL_MS
      ) {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const sync = useCallback((update: Update | null) => {
    lastCheckAt.current = Date.now();
    setAvailableUpdate(update);
  }, []);

  return { availableUpdate, sync };
}
