import { useCallback, useEffect, useState } from "react";

import type { ConnectionProfile } from "../connections/domain";
import { listConnections } from "../connections/tauriAdapter";
import { errMessage } from "../../ipc/types";
import { isTransientDbError } from "../../lib/queries";

export function useConnectionProfiles() {
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(
    async function refreshProfiles(attempt = 0): Promise<ConnectionProfile[]> {
      try {
        const profiles = await listConnections();
        setConnections(profiles);
        setLoadError(null);
        return profiles;
      } catch (error) {
        if (attempt < 3 && isTransientDbError(error)) {
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8_000)),
          );
          return refreshProfiles(attempt + 1);
        }
        setLoadError(errMessage(error));
        return [];
      }
    },
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    connections,
    setConnections,
    loadError,
    refresh,
    clear: useCallback(() => setConnections([]), []),
  };
}
