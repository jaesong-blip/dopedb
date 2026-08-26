// AI Chat scope selection keeps the workbench connection independent from the
// exact Environment or single-database grant chosen for a new ACP session.

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ConnectionId,
  ConnectionProfile,
} from "../connections/domain";
import type {
  AcpSessionSummary,
  AgentComposerRequest,
} from "./domain";
import {
  agentDatabaseScopeKey,
  agentEnvironmentScopeKey,
  type useAgentEnvironmentInventory,
} from "./useAgentEnvironmentInventory";

type EnvironmentInventory = ReturnType<typeof useAgentEnvironmentInventory>;

export function useAgentScopeConnection(
  defaultConnection: ConnectionProfile,
  connections: ConnectionProfile[],
) {
  const [connectionId, setConnectionId] = useState(defaultConnection.id);
  useEffect(() => setConnectionId(defaultConnection.id), [defaultConnection.id]);
  const connection = useMemo(
    () =>
      connections.find((candidate) => candidate.id === connectionId) ??
      defaultConnection,
    [connectionId, connections, defaultConnection],
  );
  return { connection, select: setConnectionId };
}

export function useAgentScopeSelection({
  active,
  composerRequest,
  connectionId,
  inventory,
  onClearError,
  onSelectConnection,
  selectionLocked,
}: {
  active: AcpSessionSummary | null;
  composerRequest: AgentComposerRequest | null;
  connectionId: ConnectionId;
  inventory: EnvironmentInventory;
  onClearError: () => void;
  onSelectConnection: (connectionId: ConnectionId) => void;
  selectionLocked: boolean;
}) {
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [environmentConnectionIds, setEnvironmentConnectionIds] = useState<
    ConnectionId[] | null
  >(null);

  useEffect(() => {
    if (active?.projectEnvironmentId) {
      setEnvironmentId(active.projectEnvironmentId);
      setEnvironmentConnectionIds(
        active.environmentConnections.length === 1
          ? [active.environmentConnections[0]!.connectionId as ConnectionId]
          : null,
      );
      return;
    }
    if (composerRequest?.connectionId === connectionId) {
      setEnvironmentId(composerRequest.projectEnvironmentId);
      setEnvironmentConnectionIds(null);
      return;
    }
    if (
      environmentId &&
      inventory.available.some((environment) => environment.id === environmentId)
    ) {
      return;
    }
    setEnvironmentId(
      inventory.available.length === 1 ? inventory.available[0]!.id : null,
    );
    setEnvironmentConnectionIds(null);
  }, [
    active,
    composerRequest,
    connectionId,
    environmentId,
    inventory.available,
  ]);

  const select = useCallback(
    async (scopeKey: string | null) => {
      if (
        scopeKey === null ||
        selectionLocked ||
        inventory.updatingEnvironmentId !== null
      ) {
        return;
      }
      const scope = inventory.scopes.find((candidate) => candidate.key === scopeKey);
      if (!scope) return;
      onClearError();
      if (!(await inventory.ensureAvailable(scope.environmentId, scope.connectionId))) {
        return;
      }
      onSelectConnection(scope.connectionId);
      setEnvironmentId(scope.environmentId);
      setEnvironmentConnectionIds(scope.environmentConnectionIds);
    },
    [inventory, onClearError, onSelectConnection, selectionLocked],
  );

  const selectedScopeKey = environmentId
    ? environmentConnectionIds?.length === 1
      ? agentDatabaseScopeKey(environmentId, environmentConnectionIds[0]!)
      : agentEnvironmentScopeKey(environmentId)
    : null;
  const selectedEnvironment = inventory.available.find(
    (environment) => environment.id === environmentId,
  );
  const newScopeReady =
    inventory.success &&
    inventory.updatingEnvironmentId === null &&
    selectedEnvironment !== undefined &&
    (environmentConnectionIds === null ||
      environmentConnectionIds.includes(connectionId));

  return {
    environmentConnectionIds,
    environmentId,
    newScopeReady,
    select,
    selectedScopeKey,
  };
}
