import { useCallback, useEffect, useRef, useState } from "react";

import { getSafetySettings } from "../safetySettings/tauriAdapter";
import { errMessage, type SafetySettings } from "../../ipc/types";

export function useSafetySettings(connectionId: string | null) {
  const [safety, setSafety] = useState<SafetySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);

  const load = useCallback((id: string) => {
    requestId.current = id;
    setSafety(null);
    setError(null);
    getSafetySettings(id)
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
