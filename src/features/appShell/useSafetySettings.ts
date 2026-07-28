import { useCallback, useEffect, useRef, useState } from "react";

import { getSafetySettings } from "../safetySettings/tauriAdapter";
import { errMessage, type SafetySettings } from "../../ipc/types";

const SAFETY_LOAD_TIMEOUT_MS = 5_000;

async function loadSafetyBounded(id: string) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Safety settings request timed out")),
      SAFETY_LOAD_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([getSafetySettings(id), timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export function useSafetySettings(connectionId: string | null) {
  const [safety, setSafety] = useState<SafetySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);

  const load = useCallback((id: string) => {
    requestId.current = id;
    setSafety(null);
    setError(null);
    loadSafetyBounded(id)
      .then((settings) => {
        if (requestId.current === id) setSafety(settings);
      })
      .catch((loadError) => {
        if (requestId.current === id) setError(errMessage(loadError));
      });
  }, []);

  useEffect(() => {
    if (connectionId) {
      load(connectionId);
      return;
    }
    requestId.current = null;
    setSafety(null);
  }, [connectionId, load]);

  return {
    safety,
    error,
    refresh: useCallback(() => {
      if (connectionId) load(connectionId);
    }, [connectionId, load]),
    clear: useCallback(() => {
      requestId.current = null;
      setSafety(null);
      setError(null);
    }, []),
  };
}
