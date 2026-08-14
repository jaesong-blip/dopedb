"use client";

// Cloud-account access owns provider inventory, account mutations, and the GCP
// OAuth-return setup flow without depending on shared connection inventory.
import { useCallback, useEffect } from "react";

import { emptyNeon, type Integration, type Provider } from "./domain";
import { useProviderAccessState } from "./state";
import {
  fetchProviderAccessWithManagedConnections,
  fetchProviderAccountSnapshot,
  providerResponseError,
} from "./transport";
import { useGcpProviderSetup } from "./useGcpProviderSetup";
import { useWorkspaceLocale } from "../../app/components/WorkspaceLocale";
import { workspaceMessages } from "../../lib/workspace-messages";

export function useProviderAccountAccess(
  workspaceId: string,
  gcpSetupId: string | null = null,
) {
  const locale = useWorkspaceLocale();
  const copy = workspaceMessages[locale].providerAccess;
  const [state, setField] = useProviderAccessState();
  const {
    providers,
    integrations,
    managedConnections,
    managedConnectionsLoaded,
    setupProviderId,
    neonConfiguration,
    gcpSetupInventory,
    gcpSetupInstances,
    selectedGcpProjectId,
    selectedGcpInstanceId,
    gcpEnvironmentClassification,
    gcpProductionApproved,
    gcpRestartApproved,
    gcpPermissionCheck,
    gcpIamRoleGrantApproved,
    gcpSetupError,
    gcpSetupReconnectRequired,
    loading,
    mutation,
    error,
  } = state;
  const setProviders = setField("providers");
  const setIntegrations = setField("integrations");
  const setManagedConnections = setField("managedConnections");
  const setManagedConnectionsLoaded = setField("managedConnectionsLoaded");
  const setSetupProviderId = setField("setupProviderId");
  const setNeonConfiguration = setField("neonConfiguration");
  const setGcpEnvironmentClassification = setField("gcpEnvironmentClassification");
  const setGcpProductionApproved = setField("gcpProductionApproved");
  const setGcpRestartApproved = setField("gcpRestartApproved");
  const setGcpIamRoleGrantApproved = setField("gcpIamRoleGrantApproved");
  const setLoading = setField("loading");
  const setMutation = setField("mutation");
  const setError = setField("error");
  const setupProvider = providers.find((item) => item.id === setupProviderId) ?? null;

  const loadAccountAccess = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setManagedConnectionsLoaded(false);
    const { response, data } = await fetchProviderAccountSnapshot(workspaceId, signal);
    if (signal?.aborted) return;
    if (!response?.ok) {
      setError(await providerResponseError(response, copy.loadError, locale));
      setLoading(false);
      return;
    }
    if (!data) {
      setError(copy.shapeError);
      setLoading(false);
      return;
    }
    setProviders(data.providers);
    setIntegrations(data.integrations);
    setError("");
    setLoading(false);

    // Managed database inventory enriches account cards, but it is not part of
    // the account authorization boundary. Its failure must not hide accounts.
    const inventory = await fetchProviderAccessWithManagedConnections(
      workspaceId,
      signal,
    );
    if (signal?.aborted) return;
    if (inventory.response?.ok && inventory.data?.managedConnections) {
      setManagedConnections(inventory.data.managedConnections);
      setManagedConnectionsLoaded(true);
    }
  }, [
    copy,
    locale,
    setError,
    setIntegrations,
    setLoading,
    setManagedConnections,
    setManagedConnectionsLoaded,
    setProviders,
    workspaceId,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    void loadAccountAccess(controller.signal);
    return () => controller.abort();
  }, [loadAccountAccess]);

  const gcpSetup = useGcpProviderSetup({
    workspaceId,
    gcpSetupId,
    locale,
    copy,
    state,
    setField,
  });

  async function connect(provider: Provider, configuration?: object) {
    if (mutation) return;
    setMutation(`connect:${provider.id}`);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: provider.id, configuration }),
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await providerResponseError(response, copy.connectError, locale));
        return;
      }
      const body = await response.json().catch(() => null);
      if (provider.setupKind === "oauth") {
        if (typeof body?.authorizationUrl !== "string") {
          setError(copy.authorizationUrlError);
          return;
        }
        window.location.assign(body.authorizationUrl);
        return;
      }
      setNeonConfiguration(emptyNeon);
      setSetupProviderId("");
      await loadAccountAccess();
    } finally {
      setMutation("");
    }
  }

  function beginConnect(provider: Provider) {
    if (provider.setupKind === "oauth") {
      void connect(provider);
      return;
    }
    const next = setupProviderId === provider.id ? "" : provider.id;
    if (next !== "neon") setNeonConfiguration(emptyNeon);
    setSetupProviderId(next);
    setError("");
  }

  function reconnectGcpSetup() {
    gcpSetup.reconnectGcpSetup(connect);
  }

  async function disconnect(integration: Integration) {
    if (mutation || !window.confirm(copy.disconnectConfirm)) return;
    setMutation(`disconnect:${integration.id}`);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations/${integration.id}`,
        { method: "DELETE" },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await providerResponseError(response, copy.disconnectError, locale));
        return;
      }
      await loadAccountAccess();
    } finally {
      setMutation("");
    }
  }

  const {
    completeGcpSetup,
    selectGcpInstance,
    selectGcpProject,
  } = gcpSetup;

  return {
    providers,
    integrations,
    managedConnections,
    managedConnectionsLoaded,
    setupProvider,
    neonConfiguration,
    gcpSetupId,
    gcpSetupInventory,
    gcpSetupInstances,
    selectedGcpProjectId,
    selectedGcpInstanceId,
    gcpEnvironmentClassification,
    gcpProductionApproved,
    gcpRestartApproved,
    gcpPermissionCheck,
    gcpIamRoleGrantApproved,
    gcpSetupError,
    gcpSetupReconnectRequired,
    loading,
    mutation,
    error,
    beginConnect,
    completeGcpSetup,
    connect,
    disconnect,
    reconnectGcpSetup,
    selectGcpInstance,
    selectGcpProject,
    setGcpEnvironmentClassification,
    setGcpIamRoleGrantApproved,
    setGcpProductionApproved,
    setGcpRestartApproved,
    setNeonConfiguration,
  };
}

export type ProviderAccountAccessController = ReturnType<
  typeof useProviderAccountAccess
>;
