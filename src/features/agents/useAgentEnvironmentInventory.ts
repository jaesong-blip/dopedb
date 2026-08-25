// Agent environment inventory merges current grants with stale bindings and
// owns the explicit reconfirmation needed before a session changes authority.

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { ConnectionProfile } from "../connections/domain";
import { bindKnowledgeEnvironmentConnectionWithRefresh } from "../knowledge/bindEnvironmentConnection";
import type { EnvironmentConnection } from "../knowledge/domain";
import { knowledgeInventoryQuery } from "../knowledge/inventory";
import { knowledgeQueryKeys } from "../knowledge/queryKeys";
import { listKnowledgeEnvironmentConnections } from "../knowledge/tauriAdapter";
import type { AgentKnowledgeEnvironment } from "./domain";
import { listAgentKnowledgeEnvironments } from "./tauriAdapter";

export type AgentEnvironmentChoice = AgentKnowledgeEnvironment & {
  binding: EnvironmentConnection | null;
  needsReconfirmation: boolean;
};

export function useAgentEnvironmentInventory({
  catalogScopeKey,
  connection,
  onError,
}: {
  catalogScopeKey: string;
  connection: ConnectionProfile;
  onError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [updatingEnvironmentId, setUpdatingEnvironmentId] = useState<
    string | null
  >(null);
  const agentEnvironmentsQuery = useQuery({
    queryKey: knowledgeQueryKeys.agentEnvironments(
      connection.id,
      catalogScopeKey,
    ),
    queryFn: () => listAgentKnowledgeEnvironments(connection.id),
    refetchOnWindowFocus: false,
  });
  const knowledgeInventory = useQuery(
    knowledgeInventoryQuery(catalogScopeKey),
  );
  const environmentConnectionsQuery = useQuery({
    queryKey: knowledgeQueryKeys.environmentConnections(
      undefined,
      catalogScopeKey,
    ),
    queryFn: () => listKnowledgeEnvironmentConnections(),
    refetchOnWindowFocus: false,
  });
  const available = useMemo(
    () => agentEnvironmentsQuery.data ?? [],
    [agentEnvironmentsQuery.data],
  );
  const choices = useMemo<AgentEnvironmentChoice[]>(() => {
    const byId = new Map<string, AgentEnvironmentChoice>(
      available.map((environment) => [
        environment.id,
        {
          ...environment,
          binding: null,
          needsReconfirmation: false,
        },
      ]),
    );
    const environmentIdentity = new Map(
      (knowledgeInventory.data?.projects ?? []).flatMap((project) =>
        project.environments.map((environment) => [
          environment.id,
          { environment, projectName: project.name },
        ] as const),
      ),
    );
    for (const binding of environmentConnectionsQuery.data ?? []) {
      if (binding.connectionId !== connection.id) continue;
      const identity = environmentIdentity.get(binding.projectEnvironmentId);
      if (!identity) continue;
      const existing = byId.get(binding.projectEnvironmentId);
      byId.set(binding.projectEnvironmentId, {
        id: binding.projectEnvironmentId,
        projectName: existing?.projectName ?? identity.projectName,
        name: existing?.name ?? identity.environment.name,
        riskClass: existing?.riskClass ?? identity.environment.riskClass,
        graphRevisionCount: existing?.graphRevisionCount ?? 0,
        binding,
        needsReconfirmation: binding.stale,
      });
    }
    return [...byId.values()].sort((left, right) =>
      `${left.projectName}\u0000${left.name}\u0000${left.id}`.localeCompare(
        `${right.projectName}\u0000${right.name}\u0000${right.id}`,
      ),
    );
  }, [
    available,
    connection.id,
    environmentConnectionsQuery.data,
    knowledgeInventory.data?.projects,
  ]);
  const loadError = agentEnvironmentsQuery.isError
    ? errMessage(agentEnvironmentsQuery.error)
    : choices.length === 0 && environmentConnectionsQuery.isError
      ? errMessage(environmentConnectionsQuery.error)
      : choices.length === 0 && knowledgeInventory.isError
        ? errMessage(knowledgeInventory.error)
        : null;

  const ensureAvailable = useCallback(
    async (environmentId: string) => {
      if (available.some((environment) => environment.id === environmentId)) {
        return true;
      }
      const choice = choices.find(
        (environment) => environment.id === environmentId,
      );
      if (!choice || updatingEnvironmentId !== null) return false;
      setUpdatingEnvironmentId(environmentId);
      onError(null);
      try {
        if (choice.needsReconfirmation) {
          if (!choice.binding) return false;
          await bindKnowledgeEnvironmentConnectionWithRefresh({
            projectEnvironmentId: environmentId,
            connectionId: connection.id,
            role: choice.binding.role,
            alias: choice.binding.alias,
          });
          await queryClient.invalidateQueries({
            queryKey: knowledgeQueryKeys.environmentConnections(),
          });
        }
        const refreshed = await agentEnvironmentsQuery.refetch();
        const ready = Boolean(
          refreshed.data?.some(
            (environment) => environment.id === environmentId,
          ),
        );
        if (!ready) onError(t("agent.acpEnvironmentReconfirmFailed"));
        return ready;
      } catch (reason) {
        onError(
          t("agent.acpEnvironmentReconfirmFailedWithError", {
            error: errMessage(reason),
          }),
        );
        return false;
      } finally {
        setUpdatingEnvironmentId(null);
      }
    },
    [
      agentEnvironmentsQuery,
      available,
      choices,
      connection.id,
      onError,
      queryClient,
      t,
      updatingEnvironmentId,
    ],
  );

  return {
    available,
    choices,
    ensureAvailable,
    loadError,
    pending:
      agentEnvironmentsQuery.isPending ||
      (available.length === 0 &&
        (environmentConnectionsQuery.isPending || knowledgeInventory.isPending)),
    success: agentEnvironmentsQuery.isSuccess,
    updatingEnvironmentId,
    refresh: agentEnvironmentsQuery.refetch,
  };
}
