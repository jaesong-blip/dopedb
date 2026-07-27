import { queryOptions } from "@tanstack/react-query";

import {
  listProviderCredentialBindings,
  listProviderIntegrations,
} from "./tauriAdapter";

export const providerCredentialQueryKeys = {
  bindings: () => ["providerCredentials", "bindings"] as const,
  integrations: () => ["providerCredentials", "integrations"] as const,
};

export function providerIntegrationsQuery() {
  return queryOptions({
    queryKey: providerCredentialQueryKeys.integrations(),
    staleTime: 30_000,
    retry: false,
    queryFn: listProviderIntegrations,
  });
}

export function providerCredentialBindingsQuery() {
  return queryOptions({
    queryKey: providerCredentialQueryKeys.bindings(),
    staleTime: 30_000,
    retry: false,
    queryFn: listProviderCredentialBindings,
  });
}
