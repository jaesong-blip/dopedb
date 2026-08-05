import { useCallback, useEffect, useState } from "react";

import type { ConnectionProfile } from "../connections/domain";
import { listConnections } from "../connections/tauriAdapter";
import { errMessage } from "../../ipc/types";
import { isTransientDbError } from "../../lib/queries";

function runtimeFingerprint(profile: ConnectionProfile): string {
  return JSON.stringify([
    profile.engine,
    profile.provider,
    profile.driverId,
    profile.host,
    profile.port,
    profile.database,
    profile.username,
    profile.sslmode,
    Object.entries(profile.extraParams).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
    profile.readonlyDefault,
    profile.allowWrites,
    profile.secretRef,
    profile.env,
    profile.workspaceAccess,
    profile.credentialMode,
    profile.providerTarget,
  ]);
}

export function changedConnectionRuntimeIds(
  previous: readonly ConnectionProfile[],
  next: readonly ConnectionProfile[],
): string[] {
  const previousById = new Map(
    previous.map((profile) => [profile.id, runtimeFingerprint(profile)]),
  );
  const nextById = new Map(
    next.map((profile) => [profile.id, runtimeFingerprint(profile)]),
  );
  return [...new Set([...previousById.keys(), ...nextById.keys()])]
    .filter((id) => previousById.get(id) !== nextById.get(id));
}

export function useConnectionProfiles() {
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(
    async function refreshProfiles(
      attempt = 0,
    ): Promise<ConnectionProfile[] | null> {
      try {
        const profiles = await listConnections();
        setConnections(profiles);
        setLoadError(null);
        setLoaded(true);
        return profiles;
      } catch (error) {
        if (attempt < 3 && isTransientDbError(error)) {
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8_000)),
          );
          return refreshProfiles(attempt + 1);
        }
        setLoadError(errMessage(error));
        setLoaded(true);
        return null;
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
    loaded,
    loadError,
    refresh,
    clear: useCallback(() => {
      setConnections([]);
      setLoaded(false);
    }, []),
  };
}
