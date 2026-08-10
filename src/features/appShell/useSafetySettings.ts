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
  const requestGeneration = useRef(0);

  const load = useCallback((id: string, clearCurrent: boolean) => {
    const generation = ++requestGeneration.current;
    if (clearCurrent) setSafety(null);
    setError(null);
    loadSafetyBounded(id)
      .then((settings) => {
        if (requestGeneration.current === generation) setSafety(settings);
      })
      .catch((loadError) => {
        if (requestGeneration.current === generation) {
          setError(errMessage(loadError));
        }
      });
  }, []);

  useEffect(() => {
    if (connectionId) {
      load(connectionId, true);
      return;
    }
    requestGeneration.current += 1;
    setSafety(null);
    setError(null);
  }, [connectionId, load]);

  return {
    safety,
    error,
    refresh: useCallback(() => {
      if (connectionId) load(connectionId, false);
    }, [connectionId, load]),
    accept: useCallback(
      (id: string, settings: SafetySettings) => {
        if (connectionId !== id) return;
        requestGeneration.current += 1;
        setSafety(settings);
        setError(null);
      },
      [connectionId],
    ),
    clear: useCallback(() => {
      requestGeneration.current += 1;
      setSafety(null);
      setError(null);
    }, []),
  };
}
