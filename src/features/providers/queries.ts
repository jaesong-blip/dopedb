import { queryOptions } from "@tanstack/react-query";

import {
  listProviderCredentialBindings,
  listProviderIntegrations,
} from "./tauriAdapter";

const PROVIDER_INVENTORY_TIMEOUT_MS = 8_000;

async function withProviderInventoryTimeout<T>(
  operation: Promise<T>,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Provider inventory request timed out")),
      PROVIDER_INVENTORY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export const providerCredentialQueryKeys = {
  bindings: () => ["providerCredentials", "bindings"] as const,
  integrations: () => ["providerCredentials", "integrations"] as const,
};

export function providerIntegrationsQuery() {
  return queryOptions({
    queryKey: providerCredentialQueryKeys.integrations(),
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      withProviderInventoryTimeout(listProviderIntegrations()),
  });
}

export function providerCredentialBindingsQuery() {
  return queryOptions({
    queryKey: providerCredentialQueryKeys.bindings(),
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      withProviderInventoryTimeout(
        listProviderCredentialBindings(),
      ),
  });
}
