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
    let disposed = false;
    let secondFrame = 0;
    let idleCallback: number | undefined;
    const scheduleVisibleRefresh = () => {
      if (disposed || document.hidden) return;
      const run = () => {
        if (!disposed && !document.hidden) void refresh();
      };
      if (typeof window.requestIdleCallback === "function") {
        idleCallback = window.requestIdleCallback(run, { timeout: 1_500 });
      } else {
        run();
      }
    };
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(scheduleVisibleRefresh);
    });
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, UPDATE_CHECK_INTERVAL_MS);
    const onVisibility = () => {
      if (
        !document.hidden &&
        Date.now() - lastCheckAt.current >= UPDATE_CHECK_INTERVAL_MS
      ) {
        scheduleVisibleRefresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      if (idleCallback !== undefined) window.cancelIdleCallback(idleCallback);
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
