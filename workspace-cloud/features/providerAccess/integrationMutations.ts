// Provider-account mutations remain separate from the read snapshots so account
// authorization state and managed-connection inventory keep independent failure paths.

export function connectProviderIntegration(
  workspaceId: string,
  provider: string,
  configuration: object | undefined,
) {
  return fetch(`/api/v1/workspaces/${workspaceId}/provider-integrations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, configuration }),
  }).catch(() => null);
}

export function disconnectProviderIntegration(
  workspaceId: string,
  integrationId: string,
) {
  return fetch(
    `/api/v1/workspaces/${workspaceId}/provider-integrations/${integrationId}`,
    { method: "DELETE" },
  ).catch(() => null);
}
