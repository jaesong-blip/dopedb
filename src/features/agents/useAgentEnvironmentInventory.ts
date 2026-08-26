// Agent environment inventory merges current grants with stale bindings and
// owns the explicit reconfirmation needed before a session changes authority.

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import {
  connectionId as asConnectionId,
  type ConnectionId,
  type ConnectionProfile,
} from "../connections/domain";
import { bindKnowledgeEnvironmentConnectionWithRefresh } from "../knowledge/bindEnvironmentConnection";
import type { EnvironmentConnection } from "../knowledge/domain";
import { knowledgeInventoryQuery } from "../knowledge/inventory";
import { knowledgeQueryKeys } from "../knowledge/queryKeys";
import { listKnowledgeEnvironmentConnections } from "../knowledge/tauriAdapter";
import type { AgentKnowledgeEnvironment } from "./domain";
import { listAgentKnowledgeEnvironments } from "./tauriAdapter";

export type AgentEnvironmentChoice = AgentKnowledgeEnvironment & {
  projectId: string;
  bindings: EnvironmentConnection[];
  needsReconfirmation: boolean;
};

type AgentScopeChoiceBase = {
  key: string;
  environmentId: string;
  connectionId: ConnectionId;
  environmentConnectionIds: ConnectionId[] | null;
  needsReconfirmation: boolean;
};

export type AgentProjectScopeChoice = AgentScopeChoiceBase & {
  kind: "project";
  projectId: string;
  projectName: string;
  databaseCount: number;
};

export type AgentDatabaseScopeChoice = AgentScopeChoiceBase & {
  kind: "database";
  projectId: string;
  projectName: string;
  databaseName: string;
  riskClass: AgentKnowledgeEnvironment["riskClass"];
};

export type AgentScopeChoice =
  | AgentProjectScopeChoice
  | AgentDatabaseScopeChoice;

export function agentProjectScopeKey(environmentId: string) {
  return `project:${environmentId}`;
}

export function agentDatabaseScopeKey(
  environmentId: string,
  connectionId: string,
) {
  return `database:${environmentId}:${connectionId}`;
}

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
    const environmentIdentity = new Map(
      (knowledgeInventory.data?.projects ?? []).flatMap((project) =>
        project.environments.map((environment) => [
          environment.id,
          { environment, projectId: project.id, projectName: project.name },
        ] as const),
      ),
    );
    const byId = new Map<string, AgentEnvironmentChoice>(
      available.map((environment) => {
        const identity = environmentIdentity.get(environment.id);
        return [
          environment.id,
          {
            ...environment,
            projectId: identity?.projectId ?? environment.projectName,
            bindings: [],
            needsReconfirmation: false,
          },
        ] as const;
      }),
    );
    for (const binding of environmentConnectionsQuery.data ?? []) {
      if (binding.connectionId === null) continue;
      const identity = environmentIdentity.get(binding.projectEnvironmentId);
      if (!identity) continue;
      const existing = byId.get(binding.projectEnvironmentId);
      const bindings = [
        ...(existing?.bindings ?? []),
        binding,
      ].sort((left, right) =>
        `${left.alias}\u0000${left.connectionName}\u0000${left.id}`.localeCompare(
          `${right.alias}\u0000${right.connectionName}\u0000${right.id}`,
        ),
      );
      byId.set(binding.projectEnvironmentId, {
        id: binding.projectEnvironmentId,
        projectId: existing?.projectId ?? identity.projectId,
        projectName: existing?.projectName ?? identity.projectName,
        name: existing?.name ?? identity.environment.name,
        riskClass: existing?.riskClass ?? identity.environment.riskClass,
        graphRevisionCount: existing?.graphRevisionCount ?? 0,
        bindings,
        needsReconfirmation: bindings.some((candidate) => candidate.stale),
      });
    }
    return [...byId.values()].sort((left, right) =>
      `${left.projectName}\u0000${left.name}\u0000${left.id}`.localeCompare(
        `${right.projectName}\u0000${right.name}\u0000${right.id}`,
      ),
    );
  }, [
    available,
    environmentConnectionsQuery.data,
    knowledgeInventory.data?.projects,
  ]);
  const projects = useMemo(() => {
    const byId = new Map<
      string,
      { id: string; name: string; boundaries: AgentEnvironmentChoice[] }
    >();
    for (const boundary of choices) {
      const project = byId.get(boundary.projectId);
      if (project) project.boundaries.push(boundary);
      else {
        byId.set(boundary.projectId, {
          id: boundary.projectId,
          name: boundary.projectName,
          boundaries: [boundary],
        });
      }
    }
    const riskOrder: Record<AgentKnowledgeEnvironment["riskClass"], number> = {
      production: 0,
      staging: 1,
      development: 2,
      test: 3,
      custom: 4,
    };
    return [...byId.values()]
      .map((project) => ({
        ...project,
        boundaries: project.boundaries.sort(
          (left, right) =>
            riskOrder[left.riskClass] - riskOrder[right.riskClass] ||
            `${left.name}\u0000${left.id}`.localeCompare(
              `${right.name}\u0000${right.id}`,
            ),
        ),
      }))
      .sort((left, right) =>
        `${left.name}\u0000${left.id}`.localeCompare(
          `${right.name}\u0000${right.id}`,
        ),
      );
  }, [choices]);
  const projectScopes = useMemo<AgentProjectScopeChoice[]>(
    () =>
      projects.flatMap((project) => {
        const productionBoundaries = project.boundaries.filter(
          (boundary) => boundary.riskClass === "production",
        );
        if (productionBoundaries.length !== 1) return [];
        const boundary = productionBoundaries[0]!;
        const bindings = boundary.bindings.flatMap((binding) =>
          binding.connectionId === null
            ? []
            : [
                {
                  ...binding,
                  connectionId: asConnectionId(binding.connectionId),
                },
              ],
        );
        const anchor =
          bindings.find((binding) => binding.connectionId === connection.id) ??
          bindings[0];
        if (!anchor) return [];
        return [
          {
            key: agentProjectScopeKey(boundary.id),
            kind: "project" as const,
            projectId: project.id,
            projectName: project.name,
            databaseCount: bindings.length,
            environmentId: boundary.id,
            connectionId: anchor.connectionId,
            environmentConnectionIds: null,
            needsReconfirmation: boundary.needsReconfirmation,
          },
        ];
      }),
    [connection.id, projects],
  );
  const databaseScopes = useMemo<AgentDatabaseScopeChoice[]>(
    () =>
      choices
        .flatMap((environment) =>
          environment.bindings.flatMap((binding) => {
            if (binding.connectionId === null) return [];
            const scopedConnectionId = asConnectionId(binding.connectionId);
            return [
              {
                key: agentDatabaseScopeKey(
                  environment.id,
                  scopedConnectionId,
                ),
                kind: "database" as const,
                projectId: environment.projectId,
                projectName: environment.projectName,
                databaseName: binding.alias || binding.connectionName,
                riskClass: environment.riskClass,
                environmentId: environment.id,
                connectionId: scopedConnectionId,
                environmentConnectionIds: [scopedConnectionId],
                needsReconfirmation: environment.needsReconfirmation,
              },
            ];
          }),
        )
        .sort((left, right) =>
          `${left.databaseName}\u0000${left.projectName}\u0000${left.connectionId}`.localeCompare(
            `${right.databaseName}\u0000${right.projectName}\u0000${right.connectionId}`,
          ),
        ),
    [choices],
  );
  const scopes = useMemo<AgentScopeChoice[]>(
    () => [...projectScopes, ...databaseScopes],
    [databaseScopes, projectScopes],
  );
  const loadError = agentEnvironmentsQuery.isError
    ? errMessage(agentEnvironmentsQuery.error)
    : environmentConnectionsQuery.isError
      ? errMessage(environmentConnectionsQuery.error)
      : knowledgeInventory.isError
        ? errMessage(knowledgeInventory.error)
        : null;

  const ensureAvailable = useCallback(
    async (environmentId: string, targetConnectionId = connection.id) => {
      const choice = choices.find(
        (environment) => environment.id === environmentId,
      );
      if (!choice || updatingEnvironmentId !== null) return false;
      setUpdatingEnvironmentId(environmentId);
      onError(null);
      try {
        for (const binding of choice.bindings) {
          if (!binding.stale || binding.connectionId === null) continue;
          await bindKnowledgeEnvironmentConnectionWithRefresh({
            projectEnvironmentId: environmentId,
            connectionId: binding.connectionId,
            role: binding.role,
            alias: binding.alias,
          });
        }
        if (choice.needsReconfirmation) {
          await queryClient.invalidateQueries({
            queryKey: knowledgeQueryKeys.environmentConnections(),
          });
        }
        const targetQueryKey = knowledgeQueryKeys.agentEnvironments(
          targetConnectionId,
          catalogScopeKey,
        );
        await queryClient.invalidateQueries({ queryKey: targetQueryKey });
        const refreshed = await queryClient.fetchQuery({
          queryKey: targetQueryKey,
          queryFn: () => listAgentKnowledgeEnvironments(targetConnectionId),
        });
        const ready = Boolean(
          refreshed.some((environment) => environment.id === environmentId),
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
      catalogScopeKey,
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
    projectScopes,
    databaseScopes,
    scopes,
    ensureAvailable,
    loadError,
    pending:
      agentEnvironmentsQuery.isPending ||
      environmentConnectionsQuery.isPending ||
      knowledgeInventory.isPending,
    success:
      agentEnvironmentsQuery.isSuccess &&
      environmentConnectionsQuery.isSuccess &&
      knowledgeInventory.isSuccess,
    updatingEnvironmentId,
    refresh: agentEnvironmentsQuery.refetch,
  };
}
