import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import ConfirmButton from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import { EnvironmentBadge } from "../../design-system/components/EnvironmentBadge";
import {
  Field,
  SelectInput,
  TextInput,
} from "../../design-system/components/FormControls";
import { ProgressBar } from "../../design-system/components/Progress";
import {
  InlineNotice,
  LoadingLabel,
  StatusBadge,
  type StatusTone,
} from "../../design-system/components/Status";
import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import { queryResultPhase } from "../../lib/queryResultPhase";
import {
  sharedWorkspaceScopeAvailable,
  useCatalogScope,
} from "../../lib/queries";
import { captureProductEvent } from "../../features/productAnalytics/client";
import type {
  ProductAnalyticsEngine,
  ProductAnalyticsWorkspaceContextInput,
} from "../../features/productAnalytics/domain";
import {
  productAnalyticsAccessMode,
  productAnalyticsConnectionEngine,
  productAnalyticsWorkspaceContext,
} from "../../features/productAnalytics/outcomes";
import { workspaceAuthStateQuery } from "../../features/workspaces/queries";
import { requestWorkspaceLogin } from "../../features/workspaces/loginRequest";
import { connectionsQuery } from "../../features/connections/queries";
import type {
  GithubKnowledgeRepository,
  KnowledgeEnvironmentFocus,
  KnowledgeEnvironmentView,
} from "../../features/knowledge/domain";
import {
  knowledgeEnvironmentBadge,
  knowledgeRevisionLabel,
} from "../../features/knowledge/presentation";
import { knowledgeQueryKeys } from "../../features/knowledge/queryKeys";
import {
  knowledgeSyncOverallPercent,
  knowledgeSyncProgressQuery,
  knowledgeSyncRemainingFiles,
} from "../../features/knowledge/syncProgress";
import { bindKnowledgeEnvironmentConnectionWithRefresh } from "../../features/knowledge/bindEnvironmentConnection";
import {
  beginKnowledgeGithubInstall,
  connectKnowledgeGithubSource,
  connectKnowledgeLocalFolder,
  decideKnowledgeMapping,
  listKnowledgeGithubRepositories,
  listKnowledgeMappings,
  listKnowledgeEnvironmentConnections,
  onKnowledgeSourceChanged,
  revokeKnowledgeSource,
  revokeKnowledgeEnvironmentConnection,
  searchKnowledgeGraph,
  syncKnowledgeSource,
} from "../../features/knowledge/tauriAdapter";
import { knowledgeInventoryQuery } from "../../features/knowledge/inventory";
import AnalysisArticles from "./AnalysisArticles";

function repositoryLabel(
  repository: GithubKnowledgeRepository,
  privateLabel: string,
): string {
  return `${repository.fullName}${repository.private ? ` · ${privateLabel}` : ""}`;
}

const mappingStateKey = {
  proposed: "knowledge.mappingStateProposed",
  approved: "knowledge.mappingStateApproved",
  rejected: "knowledge.mappingStateRejected",
  stale: "knowledge.mappingStateStale",
} as const;

const mappingTargetKey = {
  table: "knowledge.mappingTargetTable",
  column: "knowledge.mappingTargetColumn",
} as const;

const sourceHealthKey = {
  ready: "knowledge.sourceHealthReady",
  syncing: "knowledge.sourceHealthSyncing",
  stale: "knowledge.sourceHealthStale",
  failed: "knowledge.sourceHealthFailed",
} as const;

const syncPhaseKey = {
  activating: "knowledge.syncPhaseActivating",
  indexing: "knowledge.syncPhaseIndexing",
  manifest: "knowledge.syncPhaseManifest",
} as const;

// Exact-commit GitHub browsing is the current default. Existing graph data is
// preserved for future use, but graph construction and graph UI stay dormant.
const KNOWLEDGE_GRAPH_UI_ENABLED = false;

type PendingKnowledgeSyncAnalytics = {
  attemptId: string;
  context: ProductAnalyticsWorkspaceContextInput;
  previousGraphRevisionId: string | null;
  sourceKind: "github" | "local_folder";
  syncReason: "initial" | "manual";
};

type GithubInstallState = "idle" | "waiting" | "returned-empty";

function captureKnowledgeSyncOutcome(
  attempt: PendingKnowledgeSyncAnalytics | null | undefined,
  outcome: "success" | "failed",
) {
  if (!attempt) return;
  void captureProductEvent({
    name: "knowledge_source_sync_completed",
    properties: {
      outcome,
      sourceKind: attempt.sourceKind,
      syncReason: attempt.syncReason,
    },
    context: attempt.context,
    dedupeId: attempt.attemptId,
  });
}

function finishKnowledgeSyncOutcome(
  pending: Map<string, PendingKnowledgeSyncAnalytics>,
  sourceId: string,
  outcome: "success" | "failed",
) {
  const attempt = pending.get(sourceId);
  if (!attempt) return;
  pending.delete(sourceId);
  captureKnowledgeSyncOutcome(attempt, outcome);
}

export default function Knowledge({
  environmentFocus,
  onOpenAgent,
  onNewConnection,
}: {
  environmentFocus?: KnowledgeEnvironmentFocus | null;
  onOpenAgent?: (
    connectionId: string,
    environmentId?: string,
    prompt?: string,
  ) => void;
  onNewConnection?: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const catalogScope = useCatalogScope();
  const workspaceAuth = useQuery(workspaceAuthStateQuery());
  const signedInPersonalAccount =
    catalogScope.workspaceKind === "personal" &&
    workspaceAuth.data?.authenticated === true
      ? workspaceAuth.data.user
      : null;
  const personalWorkspace = catalogScope.workspaceKind === "personal";
  const personalAuthResolved =
    !personalWorkspace || workspaceAuth.data !== undefined || workspaceAuth.isError;
  const inventoryKey = knowledgeQueryKeys.inventory(catalogScope.key);
  const sourceKey = inventoryKey;
  const repositoryKey = knowledgeQueryKeys.githubRepositories(catalogScope.key);
  const sharedWorkspace = sharedWorkspaceScopeAvailable(catalogScope);
  const githubProviderVisible = sharedWorkspace || personalWorkspace;
  const githubAvailable = sharedWorkspace || signedInPersonalAccount !== null;
  const inventoryQuery = knowledgeInventoryQuery(
    catalogScope.key,
    personalAuthResolved,
  );
  const projects = useQuery({
    ...inventoryQuery,
    select: (inventory) => inventory.projects,
  });
  const sources = useQuery({
    ...inventoryQuery,
    select: (inventory) => inventory.sources,
  });
  const projectsPhase = queryResultPhase(projects.data, projects.error);
  const sourcesPhase = queryResultPhase(sources.data, sources.error);
  const sourceRows = sources.data;
  const sourceSyncProgress = useQuery(
    knowledgeSyncProgressQuery(
      catalogScope.key,
      sharedWorkspace && KNOWLEDGE_GRAPH_UI_ENABLED,
    ),
  );
  const sourceSyncProgressById = useMemo(
    () => new Map(
      (sourceSyncProgress.data ?? []).map((progress) => [
        progress.sourceId,
        progress,
      ]),
    ),
    [sourceSyncProgress.data],
  );
  const repositories = useQuery({
    queryKey: repositoryKey,
    queryFn: listKnowledgeGithubRepositories,
    enabled: githubAvailable,
    retry: false,
  });
  const refetchRepositories = repositories.refetch;
  const connections = useQuery(connectionsQuery(catalogScope.key));
  const repositoryPhase = queryResultPhase(
    repositories.data,
    repositories.error,
  );
  const connectionsPhase = queryResultPhase(
    connections.data,
    connections.error,
  );
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [provider, setProvider] = useState<"github" | "local_folder">("github");
  const [repositoryId, setRepositoryId] = useState("");
  const [refName, setRefName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [githubInstallState, setGithubInstallState] =
    useState<GithubInstallState>("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [connectionRole, setConnectionRole] = useState("primary");
  const [connectionAlias, setConnectionAlias] = useState("");
  const [view, setView] = useState<KnowledgeEnvironmentView>("sources");
  const pendingSourceSyncAnalytics = useRef(
    new Map<string, PendingKnowledgeSyncAnalytics>(),
  );
  const pendingGithubConnectAnalytics =
    useRef<PendingKnowledgeSyncAnalytics | null>(null);
  const pendingLocalConnectAnalytics =
    useRef<PendingKnowledgeSyncAnalytics | null>(null);
  const pendingBindingAnalytics = useRef<{
    context: ProductAnalyticsWorkspaceContextInput;
    engine: ProductAnalyticsEngine;
    accessMode: "local" | "managed";
  } | null>(null);
  const githubInstallStateRef = useRef<GithubInstallState>("idle");
  const githubInstallAttempt = useRef(0);
  const githubExternalWindowActive = useRef(false);
  const githubRefreshInFlight = useRef(false);
  const [sourceActivity, setSourceActivity] = useState(
    new Map<
      string,
      {
        state: "syncing" | "ready" | "failed";
        errorKind: string | null;
        previousGraphRevisionId?: string | null;
      }
    >(),
  );
  const hasSelectedEnvironmentSource = Boolean(
    environmentId &&
    sources.data?.some(
      (source) => source.projectEnvironmentId === environmentId,
    ),
  );
  const environmentConnections = useQuery({
    queryKey: knowledgeQueryKeys.environmentConnections(
      undefined,
      catalogScope.key,
    ),
    queryFn: () => listKnowledgeEnvironmentConnections(),
    enabled: Boolean(environmentId),
  });
  const environmentConnectionsPhase = queryResultPhase(
    environmentConnections.data,
    environmentConnections.error,
  );
  const mappingsKey = knowledgeQueryKeys.mappings(
    environmentId,
    catalogScope.key,
  );
  const mappings = useQuery({
    queryKey: mappingsKey,
    queryFn: () => listKnowledgeMappings(environmentId),
    enabled:
      sharedWorkspace &&
      KNOWLEDGE_GRAPH_UI_ENABLED &&
      Boolean(environmentId) &&
      view === "sources" &&
      hasSelectedEnvironmentSource,
  });
  const selectedProject = useMemo(
    () => projects.data?.find((project) => project.id === projectId) ?? null,
    [projectId, projects.data],
  );
  const selectedEnvironment = selectedProject?.environments.find(
    (environment) => environment.id === environmentId,
  ) ?? null;
  const selectedEnvironmentConnections = useMemo(
    () =>
      (environmentConnections.data ?? []).filter(
        (binding) => binding.projectEnvironmentId === environmentId,
      ),
    [environmentConnections.data, environmentId],
  );
  const boundConnectionIds = useMemo(
    () => new Set(
      (environmentConnections.data ?? []).flatMap((binding) =>
        binding.connectionId ? [binding.connectionId] : []
      ),
    ),
    [environmentConnections.data],
  );
  const assignableConnections = useMemo(
    () => (connections.data ?? []).filter(
      (connection) => !boundConnectionIds.has(connection.id),
    ),
    [boundConnectionIds, connections.data],
  );
  const selectedEnvironmentSources = useMemo(
    () =>
      (sources.data ?? []).filter(
        (source) => source.projectEnvironmentId === environmentId,
      ),
    [environmentId, sources.data],
  );
  const selectedRepository = repositories.data?.find(
    (repository) => repository.id === repositoryId,
  ) ?? null;

  useEffect(() => {
    setProjectId("");
    setEnvironmentId("");
    setView("sources");
    setProvider(githubProviderVisible ? "github" : "local_folder");
    setActionError(null);
    githubInstallAttempt.current += 1;
    githubInstallStateRef.current = "idle";
    githubExternalWindowActive.current = false;
    githubRefreshInFlight.current = false;
    setGithubInstallState("idle");
  }, [catalogScope.key, githubProviderVisible]);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: number | null = null;
    const refreshAfterGithubReturn = () => {
      if (
        githubInstallStateRef.current !== "waiting"
        || githubRefreshInFlight.current
      ) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      const attempt = githubInstallAttempt.current;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (
          disposed
          || attempt !== githubInstallAttempt.current
          || githubInstallStateRef.current !== "waiting"
          || githubRefreshInFlight.current
        ) return;
        githubRefreshInFlight.current = true;
        void (async () => {
          try {
            const result = await refetchRepositories();
            if (disposed || attempt !== githubInstallAttempt.current) return;
            if (result.error) {
              githubInstallStateRef.current = "idle";
              setGithubInstallState("idle");
              return;
            }
            const nextState: GithubInstallState = result.data?.length
              ? "idle"
              : "returned-empty";
            githubInstallStateRef.current = nextState;
            setGithubInstallState(nextState);
            if (nextState === "idle") setActionError(null);
          } catch (error) {
            if (disposed || attempt !== githubInstallAttempt.current) return;
            githubInstallStateRef.current = "idle";
            setGithubInstallState("idle");
            setActionError(errMessage(error));
          } finally {
            githubRefreshInFlight.current = false;
          }
        })();
      }, 300);
    };
    const onBlur = () => {
      if (githubInstallStateRef.current === "waiting") {
        githubExternalWindowActive.current = true;
      }
    };
    const onFocus = () => {
      if (!githubExternalWindowActive.current) return;
      githubExternalWindowActive.current = false;
      refreshAfterGithubReturn();
    };
    const onVisibilityChange = () => {
      if (
        document.visibilityState !== "visible"
        && githubInstallStateRef.current === "waiting"
      ) {
        githubExternalWindowActive.current = true;
        return;
      }
      if (
        document.visibilityState === "visible"
        && githubExternalWindowActive.current
      ) {
        githubExternalWindowActive.current = false;
        refreshAfterGithubReturn();
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refetchRepositories]);

  useEffect(() => {
    if (!repositories.data?.length || githubInstallStateRef.current === "idle") return;
    githubInstallStateRef.current = "idle";
    setGithubInstallState("idle");
  }, [repositories.data]);

  useEffect(() => {
    if (!projects.data?.length || projectId) return;
    setProjectId(projects.data[0].id);
    setEnvironmentId(projects.data[0].environments[0]?.id ?? "");
  }, [projectId, projects.data]);

  useEffect(() => {
    if (!selectedProject) return;
    if (!selectedProject.environments.some((environment) => environment.id === environmentId)) {
      setEnvironmentId(selectedProject.environments[0]?.id ?? "");
    }
  }, [environmentId, selectedProject]);

  useEffect(() => {
    if (!environmentFocus || !projects.data) return;
    setView(
      environmentFocus.view === "mappings" || environmentFocus.view === "explore"
        ? "sources"
        : environmentFocus.view,
    );
    if (environmentFocus.environmentId === null) return;
    const project = projects.data.find((candidate) =>
      candidate.environments.some(
        (environment) => environment.id === environmentFocus.environmentId,
      ),
    );
    if (!project) return;
    setProjectId(project.id);
    setEnvironmentId(environmentFocus.environmentId);
  }, [environmentFocus, projects.data]);

  useEffect(() => {
    if (!repositories.data?.length || repositoryId) return;
    const repository = repositories.data.find((candidate) => !candidate.archived);
    if (!repository) return;
    setRepositoryId(repository.id);
    setRefName(repository.defaultBranch);
    setDisplayName(repository.fullName);
  }, [repositories.data, repositoryId]);

  useEffect(() => {
    const selected = assignableConnections.find(
      (connection) => connection.id === connectionId,
    );
    if (selected) return;
    const next = assignableConnections[0];
    setConnectionId(next?.id ?? "");
    setConnectionAlias(next?.name ?? "");
  }, [assignableConnections, connectionId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onKnowledgeSourceChanged((change) => {
      if (disposed) return;
      setSourceActivity((current) => {
        const next = new Map(current);
        const previous = next.get(change.sourceId);
        next.set(change.sourceId, {
          state: change.state,
          errorKind: change.errorKind,
          previousGraphRevisionId: previous?.previousGraphRevisionId,
        });
        return next;
      });
      if (change.state === "ready") {
        finishKnowledgeSyncOutcome(
          pendingSourceSyncAnalytics.current,
          change.sourceId,
          "success",
        );
        void queryClient.invalidateQueries({
          queryKey: knowledgeQueryKeys.inventory(),
        });
        void queryClient.invalidateQueries({
          queryKey: knowledgeQueryKeys.agentEnvironments(),
        });
        void queryClient.invalidateQueries({
          queryKey: knowledgeQueryKeys.sourceSyncProgress(catalogScope.key),
        });
      } else if (change.state === "failed") {
        finishKnowledgeSyncOutcome(
          pendingSourceSyncAnalytics.current,
          change.sourceId,
          "failed",
        );
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [catalogScope.key, queryClient]);

  useEffect(() => {
    if (!sources.data) return;
    for (const [sourceId, pending] of pendingSourceSyncAnalytics.current) {
      const source = sources.data.find(
        (candidate) => candidate.sourceId === sourceId,
      );
      if (!source) continue;
      if (source.health === "failed" || source.health === "stale") {
        finishKnowledgeSyncOutcome(
          pendingSourceSyncAnalytics.current,
          sourceId,
          "failed",
        );
        continue;
      }
      if (
        source.health === "ready" &&
        source.graphRevisionId !== pending.previousGraphRevisionId
      ) {
        finishKnowledgeSyncOutcome(
          pendingSourceSyncAnalytics.current,
          sourceId,
          "success",
        );
      }
    }
    setSourceActivity((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [sourceId, activity] of current) {
        if (
          activity.state !== "syncing"
          || activity.previousGraphRevisionId === undefined
        ) continue;
        const source = sources.data.find((candidate) => candidate.sourceId === sourceId);
        if (!source) {
          next.delete(sourceId);
          changed = true;
          continue;
        }
        if (source?.health === "failed" || source?.health === "stale") {
          next.set(sourceId, { state: "failed", errorKind: "cloud_index" });
          changed = true;
          continue;
        }
        if (
          source?.provider === "github"
          && source.graphRevisionId !== null
          && source.graphRevisionId !== activity.previousGraphRevisionId
        ) {
          next.set(sourceId, { state: "ready", errorKind: null });
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sources.data]);

  const refreshInventory = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: sourceKey }),
      queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.sourceSyncProgress(catalogScope.key),
      }),
      queryClient.invalidateQueries({ queryKey: repositoryKey }),
      queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.agentEnvironments(),
      }),
    ]);
  };

  const connectGithub = useMutation({
    mutationFn: connectKnowledgeGithubSource,
    onMutate: () => {
      const context = productAnalyticsWorkspaceContext(catalogScope);
      pendingGithubConnectAnalytics.current = context
        ? {
            attemptId: crypto.randomUUID(),
            context,
            previousGraphRevisionId: null,
            sourceKind: "github",
            syncReason: "initial",
          }
        : null;
    },
    onSuccess: async (source) => {
      const analyticsAttempt = pendingGithubConnectAnalytics.current;
      pendingGithubConnectAnalytics.current = null;
      if (analyticsAttempt) {
        if (source.health === "ready") {
          captureKnowledgeSyncOutcome(analyticsAttempt, "success");
        } else {
          pendingSourceSyncAnalytics.current.set(
            source.sourceId,
            {
              ...analyticsAttempt,
              previousGraphRevisionId: source.graphRevisionId,
            },
          );
        }
      }
      setSourceActivity((current) => {
        const next = new Map(current);
        next.set(source.sourceId, {
          state: "syncing",
          errorKind: null,
          previousGraphRevisionId: null,
        });
        return next;
      });
      setActionError(null);
      await refreshInventory();
    },
    onError: async (error) => {
      captureKnowledgeSyncOutcome(
        pendingGithubConnectAnalytics.current,
        "failed",
      );
      pendingGithubConnectAnalytics.current = null;
      setActionError(errMessage(error));
      await queryClient.invalidateQueries({ queryKey: sourceKey });
    },
  });
  const connectLocal = useMutation({
    mutationFn: connectKnowledgeLocalFolder,
    onMutate: () => {
      const context = productAnalyticsWorkspaceContext(catalogScope);
      pendingLocalConnectAnalytics.current = context
        ? {
            attemptId: crypto.randomUUID(),
            context,
            previousGraphRevisionId: null,
            sourceKind: "local_folder",
            syncReason: "initial",
          }
        : null;
    },
    onSuccess: async (source) => {
      const analyticsAttempt = pendingLocalConnectAnalytics.current;
      pendingLocalConnectAnalytics.current = null;
      if (!source) return;
      if (analyticsAttempt) {
        if (source.health === "ready") {
          captureKnowledgeSyncOutcome(analyticsAttempt, "success");
        } else {
          pendingSourceSyncAnalytics.current.set(
            source.sourceId,
            {
              ...analyticsAttempt,
              previousGraphRevisionId: source.graphRevisionId,
            },
          );
        }
      }
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
      await queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.agentEnvironments(),
      });
    },
    onError: async (error) => {
      captureKnowledgeSyncOutcome(
        pendingLocalConnectAnalytics.current,
        "failed",
      );
      pendingLocalConnectAnalytics.current = null;
      setActionError(errMessage(error));
      await queryClient.invalidateQueries({ queryKey: sourceKey });
    },
  });
  const revoke = useMutation({
    mutationFn: revokeKnowledgeSource,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
      await queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.sourceSyncProgress(catalogScope.key),
      });
      await queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.agentEnvironments(),
      });
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const sync = useMutation({
    mutationFn: syncKnowledgeSource,
    onMutate: (sourceId) => {
      const source = sourceRows?.find(
        (candidate) => candidate.sourceId === sourceId,
      );
      const context = productAnalyticsWorkspaceContext(catalogScope);
      if (source && context) {
        pendingSourceSyncAnalytics.current.set(sourceId, {
          attemptId: crypto.randomUUID(),
          context,
          previousGraphRevisionId: source.graphRevisionId,
          sourceKind: source.provider,
          syncReason: "manual",
        });
      }
      setSourceActivity((current) => {
        const next = new Map(current);
        next.set(sourceId, { state: "syncing", errorKind: null });
        return next;
      });
    },
    onSuccess: async (result, sourceId) => {
      if (result.state === "ready") {
        finishKnowledgeSyncOutcome(
          pendingSourceSyncAnalytics.current,
          sourceId,
          "success",
        );
      }
      setSourceActivity((current) => {
        const next = new Map(current);
        next.set(sourceId, {
          state: result.state,
          errorKind: null,
          previousGraphRevisionId:
            result.state === "syncing" ? result.graphRevisionId : undefined,
        });
        return next;
      });
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
      await queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.sourceSyncProgress(catalogScope.key),
      });
      await queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.agentEnvironments(),
      });
    },
    onError: (error, sourceId) => {
      finishKnowledgeSyncOutcome(
        pendingSourceSyncAnalytics.current,
        sourceId,
        "failed",
      );
      setSourceActivity((current) => {
        const next = new Map(current);
        next.set(sourceId, { state: "failed", errorKind: "manual_sync" });
        return next;
      });
      setActionError(errMessage(error));
    },
  });
  const search = useMutation({
    mutationFn: ({ environmentId, query }: { environmentId: string; query: string }) =>
      searchKnowledgeGraph(environmentId, query),
    onError: (error) => setActionError(errMessage(error)),
    onSuccess: () => setActionError(null),
  });
  const bindConnection = useMutation({
    mutationFn: bindKnowledgeEnvironmentConnectionWithRefresh,
    onMutate: (input) => {
      const context = productAnalyticsWorkspaceContext(catalogScope);
      const connection = connections.data?.find(
        (candidate) => candidate.id === input.connectionId,
      );
      const engine = connection
        ? productAnalyticsConnectionEngine(connection.engine)
        : null;
      const accessMode = connection
        ? productAnalyticsAccessMode(connection.credentialMode)
        : null;
      pendingBindingAnalytics.current = context && engine && accessMode
        ? { context, engine, accessMode }
        : null;
    },
    onSuccess: async (binding) => {
      const analyticsAttempt = pendingBindingAnalytics.current;
      pendingBindingAnalytics.current = null;
      if (analyticsAttempt) {
        void captureProductEvent({
          name: "environment_connection_bound",
          properties: {
            accessMode: analyticsAttempt.accessMode,
            engine: analyticsAttempt.engine,
          },
          context: analyticsAttempt.context,
          dedupeId: binding.id,
        });
      }
      setActionError(null);
      await queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.environmentConnections(),
      });
      await queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.agentEnvironments(),
      });
    },
    onError: (error) => {
      pendingBindingAnalytics.current = null;
      setActionError(errMessage(error));
    },
  });
  const unbindConnection = useMutation({
    mutationFn: ({ environmentId: id, bindingId }: { environmentId: string; bindingId: string }) =>
      revokeKnowledgeEnvironmentConnection(id, bindingId),
    onSuccess: () => {
      setActionError(null);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.environmentConnections(),
      });
      await queryClient.invalidateQueries({
        queryKey: knowledgeQueryKeys.agentEnvironments(),
      });
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const decideMapping = useMutation({
    mutationFn: ({
      proposalId,
      graphRevisionId,
      decision,
    }: {
      proposalId: string;
      graphRevisionId: string;
      decision: "approved" | "rejected";
    }) =>
      decideKnowledgeMapping(
        environmentId,
        proposalId,
        graphRevisionId,
        decision,
      ),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: mappingsKey });
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const pending = connectGithub.isPending || connectLocal.isPending;
  const sourceLoadFailure = projects.error
    ? {
        hasData: projectsPhase === "staleError",
        message: t("knowledge.projectsLoadFailed", {
          error: errMessage(projects.error),
        }),
        retry: () => projects.refetch(),
      }
    : sources.error
      ? {
          hasData: sourcesPhase === "staleError",
          message: t("knowledge.sourcesLoadFailed", {
            error: errMessage(sources.error),
          }),
          retry: () => sources.refetch(),
        }
      : view === "databases" && connections.error
        ? {
            hasData: connectionsPhase === "staleError",
            message: t(
              connectionsPhase === "staleError"
                ? "knowledge.connectionsRefreshFailed"
                : "knowledge.connectionsLoadFailed",
              { error: errMessage(connections.error) },
            ),
            retry: () => connections.refetch(),
          }
      : null;
  if (view === "analyses" && selectedProject && selectedEnvironment) {
    return (
      <AnalysisArticles
        projectName={selectedProject.name}
        environment={selectedEnvironment}
        bindings={selectedEnvironmentConnections}
        sharedWorkspace={sharedWorkspace}
        scopeKey={catalogScope.key}
        focusId={environmentFocus?.resourceId}
        onOpenAgent={onOpenAgent}
        onNewConnection={onNewConnection}
      />
    );
  }
  const viewTitle =
    view === "databases"
      ? t("knowledge.viewDatabases")
      : view === "mappings"
          ? t("knowledge.viewMappings")
          : view === "explore"
            ? t("knowledge.viewExplore")
            : t("knowledge.viewSources");

  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1100px] tw:gap-5 tw:p-5 tw:@max-[720px]:p-3">
      <header className="tw:flex tw:min-h-control-lg tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:pb-3">
        <Icon
          name={
            view === "databases"
              ? "database"
              : "branch"
          }
          className="tw:shrink-0 tw:text-muted-foreground"
        />
        <h1 className="tw:m-0 tw:min-w-0 tw:truncate tw:text-base tw:font-semibold tw:tracking-tight">
          {viewTitle}
        </h1>
        {selectedProject && selectedEnvironment ? (
          <span className="tw:min-w-0 tw:truncate tw:text-xs tw:text-muted-foreground">
            {selectedProject.name} / {selectedEnvironment.name}
          </span>
        ) : null}
        {selectedEnvironment ? (
          <EnvironmentBadge
            environment={knowledgeEnvironmentBadge(
              selectedEnvironment.riskClass,
            )}
          />
        ) : null}
        {selectedEnvironment ? (
          <span className="tw:ml-auto tw:font-mono tw:text-2xs tw:text-muted-foreground">
            r{selectedEnvironment.revision}
          </span>
        ) : null}
      </header>

      {sourceLoadFailure ? (
        <InlineNotice
          tone={sourceLoadFailure.hasData ? "warning" : "danger"}
          icon="alert"
          role={sourceLoadFailure.hasData ? "status" : "alert"}
          action={(
            <Button size="compact" onClick={() => void sourceLoadFailure.retry()}>
              {t("knowledge.retry")}
            </Button>
          )}
        >
          {sourceLoadFailure.message}
        </InlineNotice>
      ) : null}
      {actionError ? (
        <InlineNotice tone="danger" icon="alert" role="alert">
          {actionError}
        </InlineNotice>
      ) : null}

      {projects.isSuccess && (projects.data?.length ?? 0) === 0 ? (
        <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
          {t("knowledge.emptyProjects")}
        </p>
      ) : null}

      {(projects.data?.length ?? 0) > 0 && view === "sources" ? (
        <section data-primary-flow className="tw:grid tw:gap-4 tw:border-b tw:border-border-subtle tw:pb-5">
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:grid tw:gap-1">
              <h2 className="tw:m-0 tw:text-base tw:font-semibold">{t("knowledge.connectSource")}</h2>
              <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
                {t("knowledge.connectSourceScope", {
                  project: selectedProject?.name ?? "",
                  environment: selectedEnvironment?.name ?? "",
                })}
              </p>
            </div>
            <div className="tw:inline-flex tw:gap-1" role="group" aria-label={t("knowledge.sourceProvider")}>
              {githubProviderVisible ? (
                <Button size="compact" variant={provider === "github" ? "selected" : "ghost"} onClick={() => setProvider("github")}>GitHub</Button>
              ) : null}
              {KNOWLEDGE_GRAPH_UI_ENABLED ? (
                <Button size="compact" variant={provider === "local_folder" ? "selected" : "ghost"} onClick={() => setProvider("local_folder")}><Icon name="folder" />{t("knowledge.localFolder")}</Button>
              ) : null}
            </div>
          </div>

          {provider === "github" && githubProviderVisible ? (
            !personalAuthResolved ? (
              <LoadingLabel>{t("workspace.loginChecking")}</LoadingLabel>
            ) : !githubAvailable ? (
              <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-surface-subtle tw:p-3">
                <div className="tw:grid tw:min-w-0 tw:gap-1">
                  <strong className="tw:text-sm tw:font-semibold">
                    {t("knowledge.githubSignInTitle")}
                  </strong>
                  <span className="tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                    {t("knowledge.githubSignInHint")}
                  </span>
                </div>
                <Button variant="primary" onClick={requestWorkspaceLogin}>
                  <Icon name="user" />
                  {t("workspace.login")}
                </Button>
              </div>
            ) : repositoryPhase === "coldLoading" ? (
              <LoadingLabel>{t("knowledge.loadingRepositories")}</LoadingLabel>
            ) : repositoryPhase === "coldError" && repositories.error ? (
              <InlineNotice
                tone="danger"
                icon="alert"
                role="alert"
                action={(
                  <Button size="compact" onClick={() => void repositories.refetch()}>
                    {t("knowledge.retry")}
                  </Button>
                )}
              >
                {t("knowledge.repositoriesLoadFailed", {
                  error: errMessage(repositories.error),
                })}
              </InlineNotice>
            ) : (repositories.data?.length ?? 0) === 0 ? (
              <>
              {repositories.error ? (
                <InlineNotice
                  tone="warning"
                  icon="alert"
                  role="status"
                  action={(
                    <Button size="compact" onClick={() => void repositories.refetch()}>
                      {t("knowledge.retry")}
                    </Button>
                  )}
                >
                  {t("knowledge.repositoriesRefreshFailed", {
                    error: errMessage(repositories.error),
                  })}
                </InlineNotice>
              ) : null}
              {githubInstallState === "returned-empty" && !repositories.error ? (
                <InlineNotice
                  tone="warning"
                  icon="info"
                  role="status"
                >
                  {t("knowledge.githubAccessIncomplete")}
                </InlineNotice>
              ) : null}
              <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-3">
                {githubInstallState === "waiting" ? (
                  <LoadingLabel>{t("knowledge.githubAccessWaiting")}</LoadingLabel>
                ) : (
                  <span className="tw:text-sm tw:text-muted-foreground">{t("knowledge.githubAccessHint")}</span>
                )}
                <Button disabled={githubInstallState === "waiting"} onClick={async () => {
                  try {
                    setActionError(null);
                    const authorizationUrl = await beginKnowledgeGithubInstall();
                    githubInstallAttempt.current += 1;
                    githubInstallStateRef.current = "waiting";
                    githubExternalWindowActive.current = false;
                    setGithubInstallState("waiting");
                    await openUrl(authorizationUrl);
                  } catch (error) {
                    githubInstallStateRef.current = "idle";
                    setGithubInstallState("idle");
                    setActionError(errMessage(error));
                  }
                }}>{t("knowledge.githubAccessAction")}</Button>
                <Button variant="ghost" onClick={() => void refetchRepositories()}><Icon name="refresh" />{t("knowledge.refresh")}</Button>
              </div>
              </>
            ) : (
              <>
                {repositories.error ? (
                  <InlineNotice
                    tone="warning"
                    icon="alert"
                    role="status"
                    action={(
                      <Button size="compact" onClick={() => void repositories.refetch()}>
                        {t("knowledge.retry")}
                      </Button>
                    )}
                  >
                    {t("knowledge.repositoriesRefreshFailed", {
                      error: errMessage(repositories.error),
                    })}
                  </InlineNotice>
                ) : null}
                <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[620px]:grid-cols-1">
                  <Field label={t("knowledge.repository")}>
                    <SelectInput value={repositoryId} onChange={(event) => {
                      const repository = repositories.data?.find((candidate) => candidate.id === event.target.value);
                      setRepositoryId(event.target.value);
                      if (repository) {
                        setRefName(repository.defaultBranch);
                        setDisplayName(repository.fullName);
                      }
                    }}>
                      {repositories.data?.filter((repository) => !repository.archived).map((repository) => (
                        <option key={`${repository.installationId}:${repository.id}`} value={repository.id}>{repositoryLabel(repository, t("knowledge.privateRepository"))}</option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label={t("knowledge.branchRef")}>
                    <TextInput value={refName} onChange={(event) => setRefName(event.target.value)} />
                  </Field>
                </div>
                <Field label={t("knowledge.displayName")}>
                  <TextInput value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </Field>
                <div>
                  <Button variant="primary" disabled={!selectedRepository || !environmentId || !refName.trim() || !displayName.trim() || pending} onClick={() => {
                    if (!selectedRepository) return;
                    connectGithub.mutate({
                      projectId,
                      projectEnvironmentId: environmentId,
                      installationId: selectedRepository.installationId,
                      repositoryId: selectedRepository.id,
                      repository: selectedRepository.fullName,
                      refName: refName.trim(),
                      displayName: displayName.trim(),
                    });
                  }}>{connectGithub.isPending ? t("knowledge.connecting") : t("knowledge.connectRepository")}</Button>
                </div>
              </>
            )
          ) : (
            <>
              <Field label={t("knowledge.displayName")}>
                <TextInput value={displayName} placeholder={t("knowledge.localPlaceholder")} onChange={(event) => setDisplayName(event.target.value)} />
              </Field>
              <p className="tw:m-0 tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                {t("knowledge.localSafety")}
              </p>
              <div>
                <Button variant="primary" disabled={!environmentId || !displayName.trim() || pending} onClick={() => connectLocal.mutate({
                  projectId,
                  projectEnvironmentId: environmentId,
                  displayName: displayName.trim(),
                })}><Icon name="folder" />{connectLocal.isPending ? t("knowledge.scanning") : t("knowledge.chooseFolder")}</Button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {KNOWLEDGE_GRAPH_UI_ENABLED &&
      sharedWorkspace &&
      (projects.data?.length ?? 0) > 0 &&
      view === "sources" &&
      selectedEnvironmentSources.length > 0 ? (
        <section data-primary-flow className="tw:grid tw:gap-3 tw:border-b tw:border-border-subtle tw:pb-5">
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:grid tw:gap-1">
              <h2 className="tw:m-0 tw:text-base tw:font-semibold">{t("knowledge.mappingTitle")}</h2>
              <p className="tw:m-0 tw:max-w-[720px] tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                {t("knowledge.mappingBody")}
              </p>
            </div>
            <Button iconOnly size="compact" variant="ghost" title={t("knowledge.refreshMappings")} onClick={() => void mappings.refetch()}>
              <Icon name="refresh" />
            </Button>
          </div>
          {mappings.isPending ? (
            <LoadingLabel>{t("knowledge.loadingMappings")}</LoadingLabel>
          ) : mappings.error ? (
            <InlineNotice tone="danger" icon="alert">{errMessage(mappings.error)}</InlineNotice>
          ) : (mappings.data?.length ?? 0) === 0 ? (
            <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
              {t("knowledge.emptyMappings")}
            </p>
          ) : (
            <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
              {mappings.data?.map((mapping) => {
                const tone: StatusTone = mapping.state === "approved" ? "success" : mapping.state === "rejected" ? "danger" : mapping.state === "stale" ? "warning" : "neutral";
                return (
                  <article key={mapping.id} className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-3 tw:last:border-b-0 tw:@max-[680px]:grid-cols-1">
                    <div className="tw:grid tw:min-w-0 tw:gap-1.5">
                      <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
                        <StatusBadge tone={tone} density="compact">{t(mappingStateKey[mapping.state])}</StatusBadge>
                        <StatusBadge density="compact">{t(mappingTargetKey[mapping.targetKind])}</StatusBadge>
                        <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{mapping.database}</span>
                      </div>
                      <div className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] tw:items-center tw:gap-2 tw:text-sm tw:@max-[560px]:grid-cols-1">
                        <code className="tw:truncate tw:text-xs">{mapping.fromNodeName}</code>
                        <span className="tw:text-xs tw:text-muted-foreground tw:@max-[560px]:hidden">→</span>
                        <code className="tw:truncate tw:text-xs">{mapping.targetIdentity}</code>
                      </div>
                      <span className="tw:truncate tw:font-mono tw:text-[11px] tw:text-muted-foreground">
                        {t("knowledge.mappingRevision", {
                          graph: mapping.graphRevisionId.slice(0, 8),
                          connection: mapping.connectionRevision,
                          schema: mapping.schemaFingerprint.slice(0, 8),
                        })}
                      </span>
                    </div>
                    {mapping.state === "proposed" ? (
                      <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:@max-[680px]:justify-start">
                        <Button size="compact" variant="primary" disabled={decideMapping.isPending} onClick={() => decideMapping.mutate({ proposalId: mapping.id, graphRevisionId: mapping.graphRevisionId, decision: "approved" })}>
                          <Icon name="check" />{t("knowledge.approve")}
                        </Button>
                        <Button size="compact" variant="dangerGhost" disabled={decideMapping.isPending} onClick={() => decideMapping.mutate({ proposalId: mapping.id, graphRevisionId: mapping.graphRevisionId, decision: "rejected" })}>
                          {t("knowledge.reject")}
                        </Button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {(projects.data?.length ?? 0) > 0 && view === "databases" ? (
        <section className="tw:grid tw:gap-3 tw:border-b tw:border-border-subtle tw:pb-5">
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:grid tw:min-w-0 tw:gap-1">
              <h2 className="tw:m-0 tw:text-base tw:font-semibold">{t("knowledge.environmentDatabases")}</h2>
              <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
                {t("knowledge.environmentDatabasesBody")}
              </p>
            </div>
            {onNewConnection ? (
              <Button size="compact" onClick={onNewConnection}>
                <Icon name="plus" />
                {t("knowledge.newConnection")}
              </Button>
            ) : null}
          </div>
          {connectionsPhase === "coldLoading" ? (
            <LoadingLabel>{t("knowledge.loadingConnections")}</LoadingLabel>
          ) : connections.data !== undefined ? (
            <>
          <div className="tw:grid tw:grid-cols-[minmax(0,1.2fr)_minmax(0,.7fr)_minmax(0,1fr)_auto] tw:items-end tw:gap-2 tw:@max-[760px]:grid-cols-2 tw:@max-[520px]:grid-cols-1">
            <Field label={t("knowledge.databaseConnection")}>
              <SelectInput value={connectionId} onChange={(event) => {
                const connection = connections.data?.find((candidate) => candidate.id === event.target.value);
                setConnectionId(event.target.value);
                if (connection) setConnectionAlias(connection.name);
              }}>
                {assignableConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>{connection.name}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label={t("knowledge.role")}>
              <TextInput value={connectionRole} placeholder={t("knowledge.rolePlaceholder")} onChange={(event) => setConnectionRole(event.target.value)} />
            </Field>
            <Field label={t("knowledge.alias")}>
              <TextInput value={connectionAlias} onChange={(event) => setConnectionAlias(event.target.value)} />
            </Field>
            <Button
              variant="primary"
              disabled={!environmentId || !connectionId || !connectionRole.trim() || !connectionAlias.trim() || bindConnection.isPending}
              onClick={() => bindConnection.mutate({
                projectEnvironmentId: environmentId,
                connectionId,
                role: connectionRole.trim(),
                alias: connectionAlias.trim(),
              })}
            >
              {bindConnection.isPending ? t("knowledge.binding") : t("knowledge.bindDatabase")}
            </Button>
          </div>
          {assignableConnections.length > 0 ? (
            <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
              <div className="tw:grid tw:gap-1 tw:border-b tw:border-border-subtle tw:bg-surface-subtle tw:px-3 tw:py-2">
                <strong className="tw:text-sm">{t("knowledge.unassignedConnections")}</strong>
                <span className="tw:text-xs tw:text-muted-foreground">
                  {t("knowledge.unassignedConnectionsBody")}
                </span>
              </div>
              {assignableConnections.map((connection) => (
                  <div key={connection.id} className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-2 tw:last:border-b-0 tw:@max-[560px]:grid-cols-1">
                    <span className="tw:grid tw:min-w-0 tw:gap-1">
                      <strong className="tw:truncate tw:text-sm">{connection.name}</strong>
                      <span className="tw:truncate tw:text-xs tw:text-muted-foreground">
                        {connection.engine} · {connection.database}
                      </span>
                    </span>
                    <Button
                      size="compact"
                      variant={connection.id === connectionId ? "selected" : "ghost"}
                      onClick={() => {
                        setConnectionId(connection.id);
                        setConnectionAlias(connection.name);
                      }}
                    >
                      {connection.id === connectionId ? t("knowledge.selected") : t("knowledge.reviewBinding")}
                    </Button>
                  </div>
                ))}
            </div>
          ) : null}
            </>
          ) : null}
          {environmentConnectionsPhase === "coldLoading" ? (
            <LoadingLabel>{t("knowledge.loadingDatabases")}</LoadingLabel>
          ) : environmentConnectionsPhase === "coldError" && environmentConnections.error ? (
            <InlineNotice
              tone="danger"
              icon="alert"
              role="alert"
              action={(
                <Button size="compact" onClick={() => void environmentConnections.refetch()}>
                  {t("knowledge.retry")}
                </Button>
              )}
            >
              {t("knowledge.databaseBindingsLoadFailed", {
                error: errMessage(environmentConnections.error),
              })}
            </InlineNotice>
          ) : environmentConnections.data !== undefined ? (
            <>
            {environmentConnectionsPhase === "staleError" && environmentConnections.error ? (
              <InlineNotice
                tone="warning"
                icon="alert"
                role="status"
                action={(
                  <Button size="compact" onClick={() => void environmentConnections.refetch()}>
                    {t("knowledge.retry")}
                  </Button>
                )}
              >
                {t("knowledge.databaseBindingsRefreshFailed", {
                  error: errMessage(environmentConnections.error),
                })}
              </InlineNotice>
            ) : null}
            {selectedEnvironmentConnections.length === 0 ? (
              <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">{t("knowledge.emptyDatabases")}</p>
            ) : (
            <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
              {selectedEnvironmentConnections.map((binding) => (
                <div key={binding.id} className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-2 tw:last:border-b-0">
                  <span className="tw:grid tw:min-w-0 tw:gap-0.5">
                    <strong className="tw:truncate tw:text-sm">{binding.alias}</strong>
                    <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{t("knowledge.bindingMeta", { name: binding.connectionName, role: binding.role, revision: binding.connectionRevision })}</span>
                  </span>
                  <span className="tw:flex tw:items-center tw:gap-2">
                    {binding.stale && binding.connectionId ? (
                      <Button
                        size="compact"
                        variant="ghost"
                        disabled={bindConnection.isPending}
                        onClick={() => bindConnection.mutate({
                          projectEnvironmentId: environmentId,
                          connectionId: binding.connectionId!,
                          role: binding.role,
                          alias: binding.alias,
                        })}
                      >
                        {t("knowledge.reconfirm")}
                      </Button>
                    ) : binding.stale ? (
                      <StatusBadge tone="warning">{t("knowledge.reconfirm")}</StatusBadge>
                    ) : (
                      <StatusBadge tone="success">{t("knowledge.pinned")}</StatusBadge>
                    )}
                    <ConfirmButton size="compact" variant="dangerGhost" disabled={unbindConnection.isPending} onConfirm={() => unbindConnection.mutate({ environmentId, bindingId: binding.id })}>{t("knowledge.remove")}</ConfirmButton>
                  </span>
                </div>
              ))}
            </div>
            )}
            </>
          ) : null}
        </section>
      ) : null}

      {(projects.data?.length ?? 0) > 0 && view === "sources" ? (
      <section className="tw:grid tw:gap-3">
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
          <h2 className="tw:m-0 tw:text-base tw:font-semibold">{t("knowledge.sources")}</h2>
          <Button iconOnly size="compact" variant="ghost" title={t("knowledge.refreshSources")} onClick={() => void sources.refetch()}><Icon name="refresh" /></Button>
        </div>
        {sourcesPhase === "coldLoading" ? <LoadingLabel>{t("knowledge.loadingSources")}</LoadingLabel> : sourcesPhase === "coldError" ? null : selectedEnvironmentSources.length === 0 ? (
          <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">{t("knowledge.emptySources")}</p>
        ) : (
          <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
            {selectedEnvironmentSources.map((source) => {
              const activity = sourceActivity.get(source.sourceId);
              const progress = sourceSyncProgressById.get(source.sourceId);
              const visibleHealth = !KNOWLEDGE_GRAPH_UI_ENABLED && source.provider === "github"
                ? source.health
                : progress
                ? "syncing"
                : activity?.state ?? source.health;
              const tone: StatusTone = visibleHealth === "ready" ? "success" : visibleHealth === "failed" ? "danger" : "warning";
              const overallProgress = progress
                ? knowledgeSyncOverallPercent(progress)
                : null;
              return (
                <article key={source.sourceId} className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-3 tw:last:border-b-0 tw:@max-[560px]:grid-cols-1">
                  <div className="tw:grid tw:min-w-0 tw:gap-1">
                    <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
                      <strong className="tw:truncate tw:text-sm">{source.displayName}</strong>
                      <StatusBadge tone={tone} density="compact">{t(sourceHealthKey[visibleHealth])}</StatusBadge>
                      <StatusBadge density="compact">
                        {source.provider === "github" ? "GitHub" : t("knowledge.localFolder")}
                      </StatusBadge>
                    </div>
                    <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{source.projectName} / {source.environmentName} · {knowledgeRevisionLabel(source.revision, {
                      dirty: t("knowledge.revisionDirty"),
                      snapshot: t("knowledge.revisionSnapshot"),
                    })}</span>
                    {source.provider === "github" && !KNOWLEDGE_GRAPH_UI_ENABLED ? (
                      <span className="tw:text-xs tw:text-muted-foreground">
                        {t("knowledge.sourceBrowseMode")}
                      </span>
                    ) : null}
                    {progress ? (
                      <div className="tw:grid tw:gap-1.5 tw:pt-1">
                        <span className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-x-2 tw:gap-y-0.5 tw:text-xs tw:text-muted-foreground">
                          <span>{t(syncPhaseKey[progress.phase])}</span>
                          <span>
                            {progress.totalFiles > 0
                              ? t("knowledge.syncProgressFiles", {
                                  completed: progress.completedFiles.toLocaleString(),
                                  total: progress.totalFiles.toLocaleString(),
                                  remaining: knowledgeSyncRemainingFiles(progress).toLocaleString(),
                                })
                              : t("knowledge.syncProgressPreparing")}
                          </span>
                          <span>
                            {progress.retryAt
                              ? t("knowledge.syncRetryAt", {
                                  attempt: progress.attempt.toLocaleString(),
                                  time: new Date(progress.retryAt).toLocaleTimeString(),
                                })
                              : t("knowledge.syncUpdatedAt", {
                                  time: new Date(progress.updatedAt).toLocaleTimeString(),
                                })}
                          </span>
                        </span>
                        <ProgressBar
                          density="compact"
                          value={overallProgress}
                          label={overallProgress === null
                            ? t("knowledge.syncProgressPreparing")
                            : t("knowledge.syncProgressPercent", {
                                count: overallProgress.toFixed(0),
                              })}
                        />
                      </div>
                    ) : null}
                    {source.provider === "local_folder" && !source.localCapabilityAvailable ? (
                      <span className="tw:text-xs tw:text-warning">{t("knowledge.restoreLocalFolder")}</span>
                    ) : null}
                    {activity?.state === "failed" ? (
                      <span className="tw:text-xs tw:text-danger">
                        {t("knowledge.syncFailed", {
                          error: activity.errorKind ?? t("knowledge.unknownSyncError"),
                        })}
                      </span>
                    ) : null}
                  </div>
                  <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:@max-[560px]:justify-start">
                    {KNOWLEDGE_GRAPH_UI_ENABLED ? (
                      <Button size="compact" disabled={sync.isPending || activity?.state === "syncing" || Boolean(progress)} onClick={() => sync.mutate(source.sourceId)}>
                        <Icon name="refresh" />{(sync.isPending && sync.variables === source.sourceId) || activity?.state === "syncing" || progress ? t("knowledge.syncing") : activity?.state === "failed" ? t("knowledge.retry") : t("knowledge.sync")}
                      </Button>
                    ) : null}
                    <ConfirmButton size="compact" variant="dangerGhost" disabled={revoke.isPending} onConfirm={() => revoke.mutate(source.sourceId)}>{t("knowledge.remove")}</ConfirmButton>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      ) : null}

      {KNOWLEDGE_GRAPH_UI_ENABLED && (projects.data?.length ?? 0) > 0 && view === "explore" ? (
        <section data-primary-flow className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-5">
          <div className="tw:grid tw:gap-1">
            <h2 className="tw:m-0 tw:text-base tw:font-semibold">{t("knowledge.viewExplore")}</h2>
            <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">{t("knowledge.exploreBody")}</p>
          </div>
          <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-2 tw:@max-[620px]:grid-cols-1">
            <Field label={t("knowledge.searchField")}>
              <TextInput value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && searchQuery.trim() && environmentId) {
                  search.mutate({ environmentId, query: searchQuery.trim() });
                }
              }} />
            </Field>
            <Button variant="primary" disabled={!searchQuery.trim() || !environmentId || search.isPending} onClick={() => search.mutate({ environmentId, query: searchQuery.trim() })}>{search.isPending ? t("knowledge.searching") : t("knowledge.search")}</Button>
          </div>
          {search.data ? (
            <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
              {search.data.matches.length === 0 ? (
                <p className="tw:m-0 tw:p-3 tw:text-sm tw:text-muted-foreground">{t("knowledge.emptySearch")}</p>
              ) : search.data.matches.map((match) => (
                <div key={`${match.graphRevisionId}:${match.node.id}`} className="tw:grid tw:min-w-0 tw:grid-cols-[auto_minmax(0,1fr)] tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:px-3 tw:py-2 tw:last:border-b-0">
                  <StatusBadge density="compact">{match.node.kind}</StatusBadge>
                  <span className="tw:grid tw:min-w-0 tw:gap-0.5">
                    <strong className="tw:truncate tw:text-sm">{match.node.name}</strong>
                    <span className="tw:truncate tw:font-mono tw:text-xs tw:text-muted-foreground">{match.node.qualifiedName}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
