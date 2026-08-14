// Provider-access transport helpers own shared HTTP reads and normalize server
// failures while account and database controllers keep independent state.
import type { Integration, ManagedConnection, Provider, SharedConnection } from "./domain";
import type { WorkspaceLocale } from "../../lib/workspace-locale";
import { localizedProviderMessage } from "../../lib/workspace-provider-copy";

async function fetchProviderAccessSnapshot(
  workspaceId: string,
  includeManagedConnections: boolean,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/v1/workspaces/${workspaceId}/provider-integrations${
      includeManagedConnections ? "?includeManagedConnections=1" : ""
    }`,
    { cache: "no-store", signal },
  ).catch(() => null);
  if (!response?.ok) return { response, data: null };
  const body = await response.json().catch(() => null);
  if (
    !Array.isArray(body?.providers)
    || !Array.isArray(body?.integrations)
    || (
      includeManagedConnections
      && !Array.isArray(body?.managedConnections)
    )
  ) {
    return { response, data: null };
  }
  return {
    response,
    data: {
      providers: body.providers as Provider[],
      integrations: body.integrations as Integration[],
      managedConnections: includeManagedConnections
        ? body.managedConnections as ManagedConnection[]
        : null,
    },
  };
}

export function fetchProviderAccountSnapshot(workspaceId: string, signal?: AbortSignal) {
  return fetchProviderAccessSnapshot(workspaceId, false, signal);
}

export function fetchProviderAccessWithManagedConnections(
  workspaceId: string, signal?: AbortSignal,
) {
  return fetchProviderAccessSnapshot(workspaceId, true, signal);
}

export async function fetchSharedConnectionsSnapshot(
  workspaceId: string,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/v1/workspaces/${workspaceId}/connections`,
    { cache: "no-store", signal },
  ).catch(() => null);
  if (!response?.ok) return { response, data: null };
  const body = await response.json().catch(() => null);
  return {
    response,
    data: Array.isArray(body?.connections)
      ? { connections: body.connections as SharedConnection[] }
      : null,
  };
}

export async function providerResponseError(
  response: Response | null,
  fallback: string,
  locale: WorkspaceLocale,
) {
  const body = await response?.json().catch(() => null);
  return typeof body?.error === "string"
    ? localizedProviderMessage(body.error, locale, fallback)
    : fallback;
}
