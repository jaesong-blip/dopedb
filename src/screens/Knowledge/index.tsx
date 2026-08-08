import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import ConfirmButton from "../../components/ConfirmButton";
import DashboardVisualizationView from "../../components/DashboardVisualization";
import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import {
  Field,
  SelectInput,
  TextInput,
} from "../../design-system/components/FormControls";
import {
  InlineNotice,
  LoadingLabel,
  StatusBadge,
  StatusDot,
  type StatusTone,
} from "../../design-system/components/Status";
import { errMessage } from "../../ipc/types";
import { cancelQuery } from "../../ipc/commands";
import { listConnections } from "../../features/connections/tauriAdapter";
import type { ConnectionProfile } from "../../features/connections/domain";
import type {
  GithubKnowledgeRepository,
  FunnelAnalysisArtifact,
  FunnelAnalysisRun,
  KnowledgeEnvironment,
  KnowledgeRevision,
} from "../../features/knowledge/domain";
import {
  beginKnowledgeGithubInstall,
  bindKnowledgeEnvironmentConnection,
  connectKnowledgeGithubSource,
  connectKnowledgeLocalFolder,
  createKnowledgeProject,
  decideKnowledgeMapping,
  listKnowledgeGithubRepositories,
  listFunnelAnalysisArtifacts,
  listKnowledgeMappings,
  listKnowledgeEnvironmentConnections,
  listKnowledgeProjects,
  listKnowledgeSources,
  onKnowledgeSourceChanged,
  publishFunnelAnalysisArtifact,
  runFunnelAnalysisArtifact,
  revokeKnowledgeSource,
  revokeKnowledgeEnvironmentConnection,
  searchKnowledgeGraph,
  syncKnowledgeSource,
} from "../../features/knowledge/tauriAdapter";

const projectKey = ["knowledge", "projects"] as const;
const sourceKey = ["knowledge", "sources"] as const;
const repositoryKey = ["knowledge", "github-repositories"] as const;
const connectionsKey = ["connections"] as const;

function revisionLabel(revision: KnowledgeRevision): string {
  if (revision.kind === "github") {
    return `${revision.refName} · ${revision.commitSha.slice(0, 8)}`;
  }
  if (revision.kind === "local_git") {
    return `${revision.refName} · ${revision.commitSha.slice(0, 8)}${revision.dirty ? " · dirty" : ""}`;
  }
  return `Snapshot ${revision.snapshotSha256.slice(0, 8)}`;
}

function repositoryLabel(repository: GithubKnowledgeRepository): string {
  return `${repository.fullName}${repository.private ? " · Private" : ""}`;
}

function riskTone(riskClass: KnowledgeEnvironment["riskClass"]): StatusTone {
  if (riskClass === "production") return "danger";
  if (riskClass === "staging") return "warning";
  if (riskClass === "development") return "success";
  return "neutral";
}

function legacyEnvironmentMatches(
  connection: Pick<ConnectionProfile, "env">,
  environment: KnowledgeEnvironment | null,
): boolean {
  return Boolean(
    connection.env
    && environment
    && connection.env.trim().localeCompare(environment.name.trim(), undefined, {
      sensitivity: "accent",
    }) === 0,
  );
}

export default function Knowledge({
  analysisFocus,
}: {
  analysisFocus?: { environmentId: string; requestId: number } | null;
}) {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: projectKey, queryFn: listKnowledgeProjects });
  const sources = useQuery({ queryKey: sourceKey, queryFn: listKnowledgeSources });
  const repositories = useQuery({
    queryKey: repositoryKey,
    queryFn: listKnowledgeGithubRepositories,
    retry: false,
  });
  const connections = useQuery({ queryKey: connectionsKey, queryFn: listConnections });
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [provider, setProvider] = useState<"github" | "local_folder">("github");
  const [repositoryId, setRepositoryId] = useState("");
  const [refName, setRefName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [environmentName, setEnvironmentName] = useState("Development");
  const [riskClass, setRiskClass] = useState<KnowledgeEnvironment["riskClass"]>("development");
  const [actionError, setActionError] = useState<string | null>(null);
  const [analysisRuns, setAnalysisRuns] = useState(
    new Map<string, FunnelAnalysisRun>(),
  );
  const [analysisRunQueries, setAnalysisRunQueries] = useState(
    new Map<string, Map<string, string>>(),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [connectionRole, setConnectionRole] = useState("primary");
  const [connectionAlias, setConnectionAlias] = useState("");
  const [view, setView] = useState<"sources" | "databases" | "mappings" | "analysis" | "explore">(
    "sources",
  );
  const [sourceActivity, setSourceActivity] = useState(
    new Map<
      string,
      {
        state: "syncing" | "ready" | "failed";
        errorKind: string | null;
      }
    >(),
  );
  const environmentConnections = useQuery({
    queryKey: ["knowledge", "environment-connections", environmentId],
    queryFn: () => listKnowledgeEnvironmentConnections(environmentId),
    enabled: Boolean(environmentId),
  });
  const mappingsKey = ["knowledge", "mappings", environmentId] as const;
  const mappings = useQuery({
    queryKey: mappingsKey,
    queryFn: () => listKnowledgeMappings(environmentId),
    enabled: Boolean(environmentId),
  });
  const analyses = useQuery({
    queryKey: ["knowledge", "funnel-analysis", environmentId],
    queryFn: () => listFunnelAnalysisArtifacts(environmentId),
    enabled: Boolean(environmentId) && view === "analysis",
  });

  const selectedProject = useMemo(
    () => projects.data?.find((project) => project.id === projectId) ?? null,
    [projectId, projects.data],
  );
  const selectedEnvironment = selectedProject?.environments.find(
    (environment) => environment.id === environmentId,
  ) ?? null;
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
    if (!analysisFocus || !projects.data) return;
    const project = projects.data.find((candidate) =>
      candidate.environments.some(
        (environment) => environment.id === analysisFocus.environmentId,
      ),
    );
    if (!project) return;
    setProjectId(project.id);
    setEnvironmentId(analysisFocus.environmentId);
    setView("analysis");
  }, [analysisFocus, projects.data]);

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
        next.set(change.sourceId, {
          state: change.state,
          errorKind: change.errorKind,
        });
        return next;
      });
      if (change.state === "ready") {
        void queryClient.invalidateQueries({ queryKey: sourceKey });
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);

  const refreshInventory = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: sourceKey }),
      queryClient.invalidateQueries({ queryKey: repositoryKey }),
    ]);
  };

  const createProject = useMutation({
    mutationFn: createKnowledgeProject,
    onSuccess: async (project) => {
      setProjectName("");
      setProjectId(project.id);
      setEnvironmentId(project.environments[0]?.id ?? "");
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: projectKey });
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const connectGithub = useMutation({
    mutationFn: connectKnowledgeGithubSource,
    onSuccess: async () => {
      setActionError(null);
      await refreshInventory();
    },
    onError: async (error) => {
      setActionError(errMessage(error));
      await queryClient.invalidateQueries({ queryKey: sourceKey });
    },
  });
  const connectLocal = useMutation({
    mutationFn: connectKnowledgeLocalFolder,
    onSuccess: async (source) => {
      if (!source) return;
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
    },
    onError: async (error) => {
      setActionError(errMessage(error));
      await queryClient.invalidateQueries({ queryKey: sourceKey });
    },
  });
  const revoke = useMutation({
    mutationFn: revokeKnowledgeSource,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const sync = useMutation({
    mutationFn: syncKnowledgeSource,
    onMutate: (sourceId) => {
      setSourceActivity((current) => {
        const next = new Map(current);
        next.set(sourceId, { state: "syncing", errorKind: null });
        return next;
      });
    },
    onSuccess: async (_, sourceId) => {
      setSourceActivity((current) => {
        const next = new Map(current);
        next.set(sourceId, { state: "ready", errorKind: null });
        return next;
      });
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
    },
    onError: (error, sourceId) => {
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
    mutationFn: bindKnowledgeEnvironmentConnection,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({
        queryKey: ["knowledge", "environment-connections", environmentId],
      });
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const unbindConnection = useMutation({
    mutationFn: ({ environmentId: id, bindingId }: { environmentId: string; bindingId: string }) =>
      revokeKnowledgeEnvironmentConnection(id, bindingId),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({
        queryKey: ["knowledge", "environment-connections", environmentId],
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
  const publishAnalysis = useMutation({
    mutationFn: ({ artifactId, productionConfirmed }: { artifactId: string; productionConfirmed: boolean }) =>
      publishFunnelAnalysisArtifact(environmentId, artifactId, productionConfirmed),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({
        queryKey: ["knowledge", "funnel-analysis", environmentId],
      });
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const runAnalysis = useMutation({
    mutationFn: ({
      artifactId,
      tileRequests,
    }: {
      artifactId: string;
      tileRequests: Array<{ tileId: string; queryId: string }>;
    }) => runFunnelAnalysisArtifact(environmentId, artifactId, tileRequests),
    onMutate: ({ artifactId, tileRequests }) => {
      setActionError(null);
      setAnalysisRuns((current) => {
        const next = new Map(current);
        next.delete(artifactId);
        return next;
      });
      setAnalysisRunQueries((current) => {
        const next = new Map(current);
        next.set(
          artifactId,
          new Map(tileRequests.map((request) => [request.tileId, request.queryId])),
        );
        return next;
      });
    },
    onSuccess: (run, { artifactId }) => {
      setAnalysisRuns((current) => new Map(current).set(artifactId, run));
      setAnalysisRunQueries((current) => {
        const next = new Map(current);
        next.delete(artifactId);
        return next;
      });
    },
    onError: (error, { artifactId }) => {
      setActionError(errMessage(error));
      setAnalysisRunQueries((current) => {
        const next = new Map(current);
        next.delete(artifactId);
        return next;
      });
    },
  });

  function executeAnalysis(analysis: FunnelAnalysisArtifact) {
    const tileRequests = analysis.tiles
      .filter((tile) => Boolean(tile.dashboard))
      .map((tile) => ({ tileId: tile.definition.id, queryId: crypto.randomUUID() }));
    if (tileRequests.length === 0) return;
    runAnalysis.mutate({ artifactId: analysis.id, tileRequests });
  }

  function cancelAnalysis(artifactId: string) {
    const queryIds = analysisRunQueries.get(artifactId)?.values() ?? [];
    void Promise.all(Array.from(queryIds, (queryId) => cancelQuery(queryId)));
  }

  function cancelAnalysisTile(artifactId: string, tileId: string) {
    const queryId = analysisRunQueries.get(artifactId)?.get(tileId);
    if (queryId) void cancelQuery(queryId);
  }

  const pending = connectGithub.isPending || connectLocal.isPending;
  const sourceLoadError = projects.error ?? sources.error;

  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1100px] tw:gap-5 tw:p-5 tw:@max-[720px]:p-3">
      <header className="tw:grid tw:gap-1 tw:border-b tw:border-border-subtle tw:pb-4">
        <h1 className="tw:m-0 tw:text-xl tw:font-semibold tw:tracking-tight">Knowledge</h1>
        <p className="tw:m-0 tw:max-w-[720px] tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
          Connect code to one exact Project and Environment. DopeDB keeps GitHub access in the workspace and Local Folder access on this device.
        </p>
      </header>

      {sourceLoadError ? (
        <InlineNotice tone="danger" icon="alert" role="alert">
          {errMessage(sourceLoadError)}
        </InlineNotice>
      ) : null}
      {actionError ? (
        <InlineNotice tone="danger" icon="alert" role="alert">
          {actionError}
        </InlineNotice>
      ) : null}

      {!projects.isPending && (projects.data?.length ?? 0) === 0 ? (
        <section data-primary-flow className="tw:grid tw:gap-4 tw:border-b tw:border-border-subtle tw:pb-5">
          <div className="tw:grid tw:gap-1">
            <h2 className="tw:m-0 tw:text-base tw:font-semibold">Create the first Project</h2>
            <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
              A Project Environment is the shared boundary for source revisions, database access, and Agent evidence.
            </p>
          </div>
          <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[620px]:grid-cols-1">
            <Field label="Project name">
              <TextInput value={projectName} onChange={(event) => setProjectName(event.target.value)} />
            </Field>
            <Field label="Environment name">
              <TextInput value={environmentName} onChange={(event) => setEnvironmentName(event.target.value)} />
            </Field>
          </div>
          <Field label="Risk class">
            <SelectInput value={riskClass} onChange={(event) => setRiskClass(event.target.value as KnowledgeEnvironment["riskClass"])}>
              <option value="development">Development</option>
              <option value="staging">Staging</option>
              <option value="production">Production</option>
              <option value="test">Test</option>
              <option value="custom">Custom</option>
            </SelectInput>
          </Field>
          <div>
            <Button
              variant="primary"
              disabled={!projectName.trim() || !environmentName.trim() || createProject.isPending}
              onClick={() => createProject.mutate({
                name: projectName.trim(),
                environments: [{ name: environmentName.trim(), riskClass }],
              })}
            >
              {createProject.isPending ? "Creating…" : "Create Project"}
            </Button>
          </div>
        </section>
      ) : null}

      {(projects.data?.length ?? 0) > 0 ? (
        <section className="tw:grid tw:grid-cols-[minmax(190px,260px)_minmax(0,1fr)] tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:@max-[700px]:grid-cols-1">
          <nav
            className="tw:grid tw:content-start tw:gap-1 tw:border-r tw:border-border-subtle tw:bg-secondary/40 tw:p-2 tw:@max-[700px]:border-r-0 tw:@max-[700px]:border-b"
            aria-label="Project environments"
          >
            {projects.data?.map((project) => (
              <div key={project.id} className="tw:grid tw:gap-0.5">
                <div className="tw:flex tw:min-h-control-md tw:min-w-0 tw:items-center tw:gap-1.5 tw:px-1.5 tw:text-xs tw:font-semibold tw:text-foreground">
                  <Icon name="folder" />
                  <span className="tw:truncate">{project.name}</span>
                </div>
                <div className="tw:grid tw:gap-0.5 tw:pl-3">
                  {project.environments.map((environment) => {
                    const sourceCount = (sources.data ?? []).filter(
                      (source) =>
                        source.projectEnvironmentId === environment.id,
                    ).length;
                    return (
                      <button
                        key={environment.id}
                        type="button"
                        data-active={environment.id === environmentId}
                        className="tw:flex tw:min-h-control-md tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-2 tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-2 tw:text-left tw:font-sans tw:text-xs tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground"
                        onClick={() => {
                          setProjectId(project.id);
                          setEnvironmentId(environment.id);
                        }}
                      >
                        <StatusDot tone={riskTone(environment.riskClass)} />
                        <span className="tw:min-w-0 tw:flex-1 tw:truncate">
                          {environment.name}
                        </span>
                        <span className="tw:shrink-0 tw:text-[11px] tw:opacity-70">
                          {sourceCount}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          <div className="tw:grid tw:min-w-0 tw:content-start tw:gap-4 tw:p-4">
            <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
              <div className="tw:grid tw:min-w-0 tw:gap-1">
                <span className="tw:text-xs tw:text-muted-foreground">
                  {selectedProject?.name}
                </span>
                <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
                  <h2 className="tw:m-0 tw:truncate tw:text-lg tw:font-semibold">
                    {selectedEnvironment?.name}
                  </h2>
                  {selectedEnvironment ? (
                    <StatusBadge
                      density="compact"
                      tone={riskTone(selectedEnvironment.riskClass)}
                    >
                      {selectedEnvironment.riskClass}
                    </StatusBadge>
                  ) : null}
                </div>
              </div>
              <span className="tw:text-xs tw:text-muted-foreground">
                revision {selectedEnvironment?.revision ?? "—"}
              </span>
            </div>
            <div
              className="tw:flex tw:min-w-0 tw:gap-1 tw:overflow-x-auto"
              role="tablist"
              aria-label="Environment resources"
            >
              {(["sources", "databases", "mappings", "analysis", "explore"] as const).map(
                (candidate) => (
                  <Button
                    key={candidate}
                    size="compact"
                    variant={view === candidate ? "selected" : "ghost"}
                    role="tab"
                    aria-selected={view === candidate}
                    onClick={() => setView(candidate)}
                  >
                    <Icon
                      name={
                        candidate === "sources"
                          ? "branch"
                          : candidate === "databases"
                            ? "database"
                            : candidate === "mappings"
                              ? "table"
                              : candidate === "analysis"
                                ? "chart"
                              : "search"
                      }
                    />
                    {candidate === "sources"
                      ? "Sources"
                      : candidate === "databases"
                        ? "Databases"
                        : candidate === "mappings"
                          ? `Mappings${mappings.data?.some((mapping) => mapping.state === "proposed") ? ` (${mappings.data.filter((mapping) => mapping.state === "proposed").length})` : ""}`
                          : candidate === "analysis"
                            ? "Analysis"
                          : "Explore"}
                  </Button>
                ),
              )}
            </div>
          </div>
        </section>
      ) : null}

      {(projects.data?.length ?? 0) > 0 && view === "analysis" ? (
        <section data-primary-flow className="tw:grid tw:gap-4 tw:border-b tw:border-border-subtle tw:pb-5">
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:grid tw:gap-1">
              <h2 className="tw:m-0 tw:text-base tw:font-semibold">Funnel analysis drafts</h2>
              <p className="tw:m-0 tw:max-w-[760px] tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                Agent proposals are pinned to this Environment, its source graphs, and exact database revisions. Drafts remain private until a workspace editor reviews and publishes them.
              </p>
            </div>
            <Button iconOnly size="compact" variant="ghost" title="Refresh analysis drafts" onClick={() => void analyses.refetch()}>
              <Icon name="refresh" />
            </Button>
          </div>
          {analyses.isPending ? (
            <LoadingLabel>Loading funnel analysis drafts…</LoadingLabel>
          ) : analyses.error ? (
            <InlineNotice tone="danger" icon="alert">{errMessage(analyses.error)}</InlineNotice>
          ) : (analyses.data?.length ?? 0) === 0 ? (
            <div className="tw:grid tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-secondary/30 tw:p-4">
              <strong className="tw:text-sm">No draft has been proposed</strong>
              <p className="tw:m-0 tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                Start an Agent session for this Environment, run and save each verified query, then ask it to propose a funnel dashboard.
              </p>
            </div>
          ) : (
            <div className="tw:grid tw:gap-4">
              {analyses.data?.map((analysis) => {
                const connectionCount = new Set(
                  analysis.tiles.flatMap((tile) => tile.dashboard?.connectionId ? [tile.dashboard.connectionId] : []),
                ).size;
                const currentRun = analysisRuns.get(analysis.id);
                const running = analysisRunQueries.has(analysis.id);
                const executableTileCount = analysis.tiles.filter(
                  (tile) => tile.definition.kind !== "markdown",
                ).length;
                const readyTileCount = analysis.tiles.filter(
                  (tile) => tile.definition.kind !== "markdown" && tile.availability === "ready",
                ).length;
                return (
                  <article key={analysis.id} className="tw:grid tw:min-w-0 tw:gap-4 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-4">
                    <header className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
                      <div className="tw:grid tw:min-w-0 tw:gap-1">
                        <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
                          <h3 className="tw:m-0 tw:text-base tw:font-semibold">{analysis.title}</h3>
                          <StatusBadge density="compact">
                            {analysis.sourceAgent === "dopedb.acp.claude" ? "Claude" : "Codex"}
                          </StatusBadge>
                          <StatusBadge density="compact">{analysis.state}</StatusBadge>
                          <StatusBadge
                            density="compact"
                            tone={analysis.freshness === "current" ? "success" : "warning"}
                          >
                            {analysis.freshness.replace(/_/g, " ")}
                          </StatusBadge>
                          <StatusBadge
                            density="compact"
                            tone={readyTileCount === executableTileCount ? "success" : "warning"}
                          >
                            {readyTileCount}/{executableTileCount} runnable
                          </StatusBadge>
                          {analysis.warnings.length > 0 ? <StatusBadge density="compact" tone="warning">Review required</StatusBadge> : null}
                        </div>
                        <strong className="tw:text-sm tw:font-medium">{analysis.question}</strong>
                        <p className="tw:m-0 tw:text-sm tw:leading-relaxed tw:text-muted-foreground">{analysis.purpose}</p>
                      </div>
                      <span className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2">
                        <span className="tw:font-mono tw:text-[11px] tw:text-muted-foreground">r{analysis.revision} · {analysis.id.slice(0, 8)}</span>
                        {currentRun ? (
                          <span className="tw:text-[11px] tw:text-muted-foreground">
                            Local run {new Date(currentRun.completedAt).toLocaleString()}
                          </span>
                        ) : null}
                        {running ? (
                          <Button size="compact" variant="danger" onClick={() => cancelAnalysis(analysis.id)}>
                            Cancel run
                          </Button>
                        ) : (
                          <Button
                            size="compact"
                            variant="ghost"
                            disabled={
                              analysis.freshness === "graph_drift"
                              || analysis.freshness === "schema_drift"
                              || executableTileCount === 0
                            }
                            onClick={() => executeAnalysis(analysis)}
                          >
                            <Icon name="refresh" />
                            Run current data
                          </Button>
                        )}
                        {analysis.state === "draft" && selectedEnvironment?.riskClass === "production" ? (
                          <ConfirmButton
                            size="compact"
                            variant="primary"
                            confirmLabel="Publish this Production analysis?"
                            disabled={publishAnalysis.isPending}
                            onConfirm={() => publishAnalysis.mutate({ artifactId: analysis.id, productionConfirmed: true })}
                          >
                            Publish
                          </ConfirmButton>
                        ) : analysis.state === "draft" ? (
                          <Button
                            size="compact"
                            variant="primary"
                            disabled={publishAnalysis.isPending}
                            onClick={() => publishAnalysis.mutate({ artifactId: analysis.id, productionConfirmed: false })}
                          >
                            {publishAnalysis.isPending ? "Publishing…" : "Publish"}
                          </Button>
                        ) : null}
                      </span>
                    </header>

                    <dl className="tw:grid tw:grid-cols-4 tw:gap-px tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-border-subtle tw:@max-[720px]:grid-cols-2 tw:@max-[430px]:grid-cols-1">
                      {[
                        ["Environment", `revision ${analysis.environmentRevision}`],
                        ["Databases", String(connectionCount)],
                        ["Source graphs", String(analysis.graphRevisionIds.length)],
                        ["Time range", `${analysis.timeRange} · ${analysis.timezone}`],
                      ].map(([label, value]) => (
                        <div key={label} className="tw:grid tw:gap-0.5 tw:bg-card tw:px-3 tw:py-2">
                          <dt className="tw:text-[11px] tw:text-muted-foreground">{label}</dt>
                          <dd className="tw:m-0 tw:truncate tw:text-xs tw:font-medium">{value}</dd>
                        </div>
                      ))}
                    </dl>

                    <div className="tw:grid tw:gap-2">
                      <span className="tw:text-xs tw:font-semibold tw:text-foreground">Funnel steps</span>
                      <ol className="tw:m-0 tw:grid tw:list-none tw:gap-2 tw:p-0">
                        {analysis.steps.map((step, index) => (
                          <li key={step.id} className="tw:grid tw:grid-cols-[24px_minmax(0,1fr)_auto] tw:items-start tw:gap-2 tw:rounded-sm tw:bg-secondary/35 tw:px-3 tw:py-2 tw:@max-[520px]:grid-cols-[24px_minmax(0,1fr)]">
                            <span className="tw:flex tw:size-6 tw:items-center tw:justify-center tw:rounded-full tw:bg-primary tw:text-[11px] tw:font-semibold tw:text-primary-foreground">{index + 1}</span>
                            <span className="tw:grid tw:min-w-0 tw:gap-0.5">
                              <strong className="tw:truncate tw:text-xs">{step.label}</strong>
                              <span className="tw:text-xs tw:leading-relaxed tw:text-muted-foreground">{step.meaning}</span>
                              <code className="tw:truncate tw:text-[11px] tw:text-muted-foreground">{step.entityKey} · {step.timestampField}</code>
                            </span>
                            <span className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-1 tw:@max-[520px]:col-start-2 tw:@max-[520px]:justify-start">
                              <StatusBadge density="compact">{step.connectionRole}</StatusBadge>
                              <StatusBadge density="compact" tone={step.mappingState === "confirmed" ? "success" : "warning"}>{step.mappingState}</StatusBadge>
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>

                    <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[680px]:grid-cols-1">
                      <div className="tw:grid tw:gap-1 tw:rounded-md tw:border tw:border-border-subtle tw:p-3">
                        <span className="tw:text-[11px] tw:font-semibold tw:text-muted-foreground">DENOMINATOR</span>
                        <p className="tw:m-0 tw:text-xs tw:leading-relaxed">{analysis.denominatorSemantics}</p>
                      </div>
                      <div className="tw:grid tw:gap-1 tw:rounded-md tw:border tw:border-border-subtle tw:p-3">
                        <span className="tw:text-[11px] tw:font-semibold tw:text-muted-foreground">NUMERATOR</span>
                        <p className="tw:m-0 tw:text-xs tw:leading-relaxed">{analysis.numeratorSemantics}</p>
                      </div>
                    </div>

                    <div className="tw:grid tw:gap-1 tw:rounded-md tw:border tw:border-border-subtle tw:p-3">
                      <span className="tw:text-[11px] tw:font-semibold tw:text-muted-foreground">SEGMENTS & WINDOW</span>
                      <p className="tw:m-0 tw:text-xs tw:leading-relaxed">
                        {analysis.segmentFilters.length > 0
                          ? analysis.segmentFilters.join(" · ")
                          : "All records"}
                        {` · conversion window ${analysis.conversionWindowSeconds.toLocaleString()}s`}
                      </p>
                    </div>

                    {analysis.warnings.map((warning) => (
                      <InlineNotice key={warning} tone="warning" icon="alert">{warning}</InlineNotice>
                    ))}

                    <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[680px]:grid-cols-1">
                      {analysis.tiles.map((tile) => (
                        <section key={tile.definition.id} className="tw:grid tw:min-w-0 tw:content-start tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:p-3">
                          <div className="tw:flex tw:min-w-0 tw:items-center tw:justify-between tw:gap-2">
                            <strong className="tw:truncate tw:text-sm">{tile.definition.title}</strong>
                            <span className="tw:flex tw:items-center tw:gap-1">
                              <StatusBadge
                                density="compact"
                                tone={tile.availability === "ready" ? "success" : "warning"}
                              >
                                {tile.availability.replace(/_/g, " ")}
                              </StatusBadge>
                              <StatusBadge density="compact">{tile.definition.kind}</StatusBadge>
                            </span>
                          </div>
                          {tile.definition.markdown ? (
                            <p className="tw:m-0 tw:text-xs tw:leading-relaxed tw:text-muted-foreground">{tile.definition.markdown}</p>
                          ) : tile.definition.composition ? (
                            <span className="tw:text-xs tw:leading-relaxed tw:text-muted-foreground">
                              {tile.definition.composition.operation} of {tile.definition.composition.inputs.map((input) => input.label).join(" → ")}
                            </span>
                          ) : tile.dashboard ? (
                            <>
                              <span className="tw:truncate tw:text-xs tw:text-muted-foreground">
                                DB {tile.dashboard.connectionId.slice(0, 8)} · connection r{tile.connectionRevision} · dashboard r{tile.dashboard.revision}
                              </span>
                              {tile.definition.queryRunId ? (
                                <span className="tw:truncate tw:font-mono tw:text-[11px] tw:text-muted-foreground">
                                  Verified run {tile.definition.queryRunId}
                                </span>
                              ) : null}
                              <details className="tw:min-w-0 tw:text-xs">
                                <summary className="tw:cursor-pointer tw:text-muted-foreground">Review query</summary>
                                <pre className="tw:mt-2 tw:max-h-48 tw:overflow-auto tw:whitespace-pre-wrap tw:break-words tw:rounded-sm tw:bg-secondary tw:p-2 tw:font-mono tw:text-[11px]">{tile.dashboard.sql}</pre>
                              </details>
                            </>
                          ) : (
                            <InlineNotice tone="warning" icon="alert">
                              {tile.unavailableReason ?? "This tile is unavailable under the current member grant."}
                            </InlineNotice>
                          )}
                          {tile.availability !== "ready" && (tile.dashboard || tile.definition.composition) ? (
                            <InlineNotice tone="warning" icon="alert">
                              {tile.unavailableReason ?? "This tile cannot run with the current member grant."}
                            </InlineNotice>
                          ) : null}
                          {running && tile.dashboard ? (
                            <div className="tw:flex tw:min-w-0 tw:items-center tw:justify-between tw:gap-2">
                              <LoadingLabel>Running with your current grant…</LoadingLabel>
                              <Button
                                size="xs"
                                variant="dangerGhost"
                                onClick={() => cancelAnalysisTile(analysis.id, tile.definition.id)}
                              >
                                Cancel tile
                              </Button>
                            </div>
                          ) : running && tile.definition.composition ? (
                            <LoadingLabel>Calculating from current inputs…</LoadingLabel>
                          ) : (() => {
                            const tileRun = currentRun?.tiles.find(
                              (candidate) => candidate.tileId === tile.definition.id,
                            );
                            if (!tileRun) {
                              return tile.definition.kind === "markdown" ? null : (
                                <span className="tw:text-xs tw:text-muted-foreground">
                                  No current result. Run this analysis to query with your own grant.
                                </span>
                              );
                            }
                            if (tileRun.status !== "ok" || !tileRun.result) {
                              return (
                                <InlineNotice tone="warning" icon="alert">
                                  {tileRun.error ?? `Tile run ended as ${tileRun.status.replace(/_/g, " ")}.`}
                                </InlineNotice>
                              );
                            }
                            const visualization = tile.dashboard
                              ? {
                                  version: 1 as const,
                                  kind: tile.dashboard.visualization.kind,
                                  xColumn: tile.dashboard.visualization.xColumn ?? null,
                                  yColumns: tile.dashboard.visualization.yColumns,
                                }
                              : tile.definition.composition
                                ? {
                                    version: 1 as const,
                                    kind: tile.definition.composition.operation === "funnel" ? "table" as const : "metric" as const,
                                    xColumn: null,
                                    yColumns: [],
                                  }
                                : null;
                            if (!visualization) return null;
                            return (
                              <div className="tw:min-w-0 tw:overflow-hidden tw:border-t tw:border-border-subtle tw:pt-3">
                                <DashboardVisualizationView
                                  compact
                                  result={tileRun.result}
                                  visualization={visualization}
                                />
                              </div>
                            );
                          })()}
                        </section>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {(projects.data?.length ?? 0) > 0 && view === "sources" ? (
        <section data-primary-flow className="tw:grid tw:gap-4 tw:border-b tw:border-border-subtle tw:pb-5">
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:grid tw:gap-1">
              <h2 className="tw:m-0 tw:text-base tw:font-semibold">Connect a source</h2>
              <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
                Connect to {selectedProject?.name} / {selectedEnvironment?.name}. This scope will not change when a branch moves.
              </p>
            </div>
            <div className="tw:inline-flex tw:gap-1" role="group" aria-label="Source provider">
              <Button size="compact" variant={provider === "github" ? "selected" : "ghost"} onClick={() => setProvider("github")}>GitHub</Button>
              <Button size="compact" variant={provider === "local_folder" ? "selected" : "ghost"} onClick={() => setProvider("local_folder")}><Icon name="folder" />Local Folder</Button>
            </div>
          </div>

          {provider === "github" ? (
            repositories.isPending ? (
              <LoadingLabel>Loading GitHub repositories…</LoadingLabel>
            ) : repositories.error || (repositories.data?.length ?? 0) === 0 ? (
              <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-3">
                <span className="tw:text-sm tw:text-muted-foreground">Install the read-only DopeDB GitHub App, then refresh this list.</span>
                <Button onClick={async () => {
                  try {
                    setActionError(null);
                    await openUrl(await beginKnowledgeGithubInstall());
                  } catch (error) {
                    setActionError(errMessage(error));
                  }
                }}>Install GitHub App</Button>
                <Button variant="ghost" onClick={() => void repositories.refetch()}><Icon name="refresh" />Refresh</Button>
              </div>
            ) : (
              <>
                <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[620px]:grid-cols-1">
                  <Field label="Repository">
                    <SelectInput value={repositoryId} onChange={(event) => {
                      const repository = repositories.data?.find((candidate) => candidate.id === event.target.value);
                      setRepositoryId(event.target.value);
                      if (repository) {
                        setRefName(repository.defaultBranch);
                        setDisplayName(repository.fullName);
                      }
                    }}>
                      {repositories.data?.filter((repository) => !repository.archived).map((repository) => (
                        <option key={`${repository.installationId}:${repository.id}`} value={repository.id}>{repositoryLabel(repository)}</option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label="Branch or ref">
                    <TextInput value={refName} onChange={(event) => setRefName(event.target.value)} />
                  </Field>
                </div>
                <Field label="Display name">
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
                  }}>{connectGithub.isPending ? "Connecting…" : "Connect repository"}</Button>
                </div>
              </>
            )
          ) : (
            <>
              <Field label="Display name">
                <TextInput value={displayName} placeholder="Web app" onChange={(event) => setDisplayName(event.target.value)} />
              </Field>
              <p className="tw:m-0 tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                The selected path stays in the OS credential store. This source starts local-only and is never published automatically.
              </p>
              <div>
                <Button variant="primary" disabled={!environmentId || !displayName.trim() || pending} onClick={() => connectLocal.mutate({
                  projectId,
                  projectEnvironmentId: environmentId,
                  displayName: displayName.trim(),
                })}><Icon name="folder" />{connectLocal.isPending ? "Scanning…" : "Choose folder"}</Button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {(projects.data?.length ?? 0) > 0 && view === "mappings" ? (
        <section data-primary-flow className="tw:grid tw:gap-3 tw:border-b tw:border-border-subtle tw:pb-5">
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:grid tw:gap-1">
              <h2 className="tw:m-0 tw:text-base tw:font-semibold">Mapping review</h2>
              <p className="tw:m-0 tw:max-w-[720px] tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                Agents can propose code-to-table relations, but only your approval makes one trusted. Every proposal is pinned to the exact graph, connection, and schema revisions shown here.
              </p>
            </div>
            <Button iconOnly size="compact" variant="ghost" title="Refresh mappings" onClick={() => void mappings.refetch()}>
              <Icon name="refresh" />
            </Button>
          </div>
          {mappings.isPending ? (
            <LoadingLabel>Loading mapping proposals…</LoadingLabel>
          ) : mappings.error ? (
            <InlineNotice tone="danger" icon="alert">{errMessage(mappings.error)}</InlineNotice>
          ) : (mappings.data?.length ?? 0) === 0 ? (
            <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
              No mapping has been proposed in this Environment. Agents can propose one after resolving an exact live schema object.
            </p>
          ) : (
            <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
              {mappings.data?.map((mapping) => {
                const tone: StatusTone = mapping.state === "approved" ? "success" : mapping.state === "rejected" ? "danger" : mapping.state === "stale" ? "warning" : "neutral";
                return (
                  <article key={mapping.id} className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-3 tw:last:border-b-0 tw:@max-[680px]:grid-cols-1">
                    <div className="tw:grid tw:min-w-0 tw:gap-1.5">
                      <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
                        <StatusBadge tone={tone} density="compact">{mapping.state}</StatusBadge>
                        <StatusBadge density="compact">{mapping.targetKind}</StatusBadge>
                        <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{mapping.database}</span>
                      </div>
                      <div className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] tw:items-center tw:gap-2 tw:text-sm tw:@max-[560px]:grid-cols-1">
                        <code className="tw:truncate tw:text-xs">{mapping.fromNodeName}</code>
                        <span className="tw:text-xs tw:text-muted-foreground tw:@max-[560px]:hidden">→</span>
                        <code className="tw:truncate tw:text-xs">{mapping.targetIdentity}</code>
                      </div>
                      <span className="tw:truncate tw:font-mono tw:text-[11px] tw:text-muted-foreground">
                        graph {mapping.graphRevisionId.slice(0, 8)} · connection r{mapping.connectionRevision} · schema {mapping.schemaFingerprint.slice(0, 8)}
                      </span>
                    </div>
                    {mapping.state === "proposed" ? (
                      <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:@max-[680px]:justify-start">
                        <Button size="compact" variant="primary" disabled={decideMapping.isPending} onClick={() => decideMapping.mutate({ proposalId: mapping.id, graphRevisionId: mapping.graphRevisionId, decision: "approved" })}>
                          <Icon name="check" />Approve
                        </Button>
                        <Button size="compact" variant="dangerGhost" disabled={decideMapping.isPending} onClick={() => decideMapping.mutate({ proposalId: mapping.id, graphRevisionId: mapping.graphRevisionId, decision: "rejected" })}>
                          Reject
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
          <div className="tw:grid tw:gap-1">
            <h2 className="tw:m-0 tw:text-base tw:font-semibold">Environment databases</h2>
            <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
              Bind exact connection revisions to this Environment. A binding names a resource; it never grants credentials or wider access.
            </p>
          </div>
          <div className="tw:grid tw:grid-cols-[minmax(0,1.2fr)_minmax(0,.7fr)_minmax(0,1fr)_auto] tw:items-end tw:gap-2 tw:@max-[760px]:grid-cols-2 tw:@max-[520px]:grid-cols-1">
            <Field label="Database connection">
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
            <Field label="Role">
              <TextInput value={connectionRole} placeholder="primary" onChange={(event) => setConnectionRole(event.target.value)} />
            </Field>
            <Field label="Alias">
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
              {bindConnection.isPending ? "Binding…" : "Bind database"}
            </Button>
          </div>
          {assignableConnections.length > 0 ? (
            <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
              <div className="tw:grid tw:gap-1 tw:border-b tw:border-border-subtle tw:bg-surface-subtle tw:px-3 tw:py-2">
                <strong className="tw:text-sm">Connections not assigned to this Environment</strong>
                <span className="tw:text-xs tw:text-muted-foreground">
                  Legacy environment labels are suggestions only. Selecting one never changes its scope until you bind it above.
                </span>
              </div>
              {assignableConnections.map((connection) => {
                const suggestedHere = legacyEnvironmentMatches(connection, selectedEnvironment);
                return (
                  <div key={connection.id} className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-2 tw:last:border-b-0 tw:@max-[560px]:grid-cols-1">
                    <span className="tw:grid tw:min-w-0 tw:gap-1">
                      <strong className="tw:truncate tw:text-sm">{connection.name}</strong>
                      <span className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2 tw:text-xs tw:text-muted-foreground">
                        <span className="tw:truncate">{connection.engine} · {connection.database}</span>
                        {suggestedHere ? (
                          <StatusBadge tone="success" density="compact">Suggested here</StatusBadge>
                        ) : connection.env ? (
                          <StatusBadge tone="warning" density="compact">Legacy: {connection.env}</StatusBadge>
                        ) : (
                          <StatusBadge density="compact">No legacy environment</StatusBadge>
                        )}
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
                      {connection.id === connectionId ? "Selected" : "Review binding"}
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {environmentConnections.isPending ? (
            <LoadingLabel>Loading Environment databases…</LoadingLabel>
          ) : (environmentConnections.data?.length ?? 0) === 0 ? (
            <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">No database is bound to this Environment.</p>
          ) : (
            <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
              {environmentConnections.data?.map((binding) => (
                <div key={binding.id} className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-2 tw:last:border-b-0">
                  <span className="tw:grid tw:min-w-0 tw:gap-0.5">
                    <strong className="tw:truncate tw:text-sm">{binding.alias}</strong>
                    <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{binding.connectionName} · {binding.role} · revision {binding.connectionRevision}</span>
                  </span>
                  <span className="tw:flex tw:items-center tw:gap-2">
                    {binding.stale ? <StatusBadge tone="warning">Reconfirm</StatusBadge> : <StatusBadge tone="success">Pinned</StatusBadge>}
                    <ConfirmButton size="compact" variant="dangerGhost" disabled={unbindConnection.isPending} onConfirm={() => unbindConnection.mutate({ environmentId, bindingId: binding.id })}>Remove</ConfirmButton>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {(projects.data?.length ?? 0) > 0 && view === "sources" ? (
      <section className="tw:grid tw:gap-3">
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
          <h2 className="tw:m-0 tw:text-base tw:font-semibold">Sources</h2>
          <Button iconOnly size="compact" variant="ghost" title="Refresh sources" onClick={() => void sources.refetch()}><Icon name="refresh" /></Button>
        </div>
        {sources.isPending ? <LoadingLabel>Loading sources…</LoadingLabel> : selectedEnvironmentSources.length === 0 ? (
          <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">No source is connected to this Environment yet.</p>
        ) : (
          <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
            {selectedEnvironmentSources.map((source) => {
              const activity = sourceActivity.get(source.sourceId);
              const visibleHealth = activity?.state ?? source.health;
              const tone: StatusTone = visibleHealth === "ready" ? "success" : visibleHealth === "failed" ? "danger" : "warning";
              return (
                <article key={source.sourceId} className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-3 tw:last:border-b-0 tw:@max-[560px]:grid-cols-1">
                  <div className="tw:grid tw:min-w-0 tw:gap-1">
                    <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
                      <strong className="tw:truncate tw:text-sm">{source.displayName}</strong>
                      <StatusBadge tone={tone} density="compact">{visibleHealth}</StatusBadge>
                      <StatusBadge density="compact">
                        {source.provider === "github" ? "GitHub" : "Local Folder"}
                      </StatusBadge>
                    </div>
                    <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{source.projectName} / {source.environmentName} · {revisionLabel(source.revision)}</span>
                    {source.provider === "local_folder" && !source.localCapabilityAvailable ? (
                      <span className="tw:text-xs tw:text-warning">Choose the folder again on this device to restore access.</span>
                    ) : null}
                    {activity?.state === "failed" ? (
                      <span className="tw:text-xs tw:text-danger">
                        Automatic sync failed ({activity.errorKind ?? "unknown"}). The last healthy graph remains active.
                      </span>
                    ) : null}
                  </div>
                  <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:@max-[560px]:justify-start">
                    <Button size="compact" disabled={sync.isPending || activity?.state === "syncing"} onClick={() => sync.mutate(source.sourceId)}>
                      <Icon name="refresh" />{(sync.isPending && sync.variables === source.sourceId) || activity?.state === "syncing" ? "Syncing…" : activity?.state === "failed" ? "Retry" : "Sync"}
                    </Button>
                    <ConfirmButton size="compact" variant="dangerGhost" disabled={revoke.isPending || sync.isPending} onConfirm={() => revoke.mutate(source.sourceId)}>Remove</ConfirmButton>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      ) : null}

      {(projects.data?.length ?? 0) > 0 && view === "explore" ? (
        <section data-primary-flow className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-5">
          <div className="tw:grid tw:gap-1">
            <h2 className="tw:m-0 tw:text-base tw:font-semibold">Explore</h2>
            <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">Search the active immutable revision. Results retain their exact source-qualified identity.</p>
          </div>
          <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-2 tw:@max-[620px]:grid-cols-1">
            <Field label="Code, route, event, or table">
              <TextInput value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && searchQuery.trim() && environmentId) {
                  search.mutate({ environmentId, query: searchQuery.trim() });
                }
              }} />
            </Field>
            <Button variant="primary" disabled={!searchQuery.trim() || !environmentId || search.isPending} onClick={() => search.mutate({ environmentId, query: searchQuery.trim() })}>{search.isPending ? "Searching…" : "Search"}</Button>
          </div>
          {search.data ? (
            <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
              {search.data.matches.length === 0 ? (
                <p className="tw:m-0 tw:p-3 tw:text-sm tw:text-muted-foreground">No matching node in this graph revision.</p>
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
