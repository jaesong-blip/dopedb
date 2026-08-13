import { queryOptions } from "@tanstack/react-query";

import { getSafetySettings } from "./tauriAdapter";

const SAFETY_LOAD_TIMEOUT_MS = 5_000;

async function loadSafetyBounded(connectionId: string) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Safety settings request timed out")),
      SAFETY_LOAD_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([getSafetySettings(connectionId), timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export const safetyQueryKeys = {
  detail: (connectionId: string) => ["safety", connectionId] as const,
};

export function safetySettingsQuery(connectionId: string | null) {
  return queryOptions({
    queryKey: safetyQueryKeys.detail(connectionId ?? ""),
    enabled: connectionId !== null,
    retry: false,
    queryFn: () => loadSafetyBounded(connectionId!),
  });
}
