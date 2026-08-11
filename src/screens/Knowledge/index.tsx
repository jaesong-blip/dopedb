import { useEffect, useMemo, useState } from "react";
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
import {
  InlineNotice,
  LoadingLabel,
  StatusBadge,
  type StatusTone,
} from "../../design-system/components/Status";
import { errMessage } from "../../ipc/types";
import { useCatalogScope } from "../../lib/queries";
import { listConnections } from "../../features/connections/tauriAdapter";
import type {
  GithubKnowledgeRepository,
  KnowledgeEnvironmentFocus,
  KnowledgeEnvironmentView,
} from "../../features/knowledge/domain";
import {
  knowledgeEnvironmentBadge,
  knowledgeRevisionLabel,
} from "../../features/knowledge/presentation";
import {
  beginKnowledgeGithubInstall,
  bindKnowledgeEnvironmentConnection,
  connectKnowledgeGithubSource,
  connectKnowledgeLocalFolder,
  decideKnowledgeMapping,
  listKnowledgeGithubRepositories,
  listKnowledgeMappings,
  listKnowledgeEnvironmentConnections,
  listKnowledgeProjects,
  listKnowledgeSources,
  onKnowledgeSourceChanged,
  revokeKnowledgeSource,
  revokeKnowledgeEnvironmentConnection,
  searchKnowledgeGraph,
  syncKnowledgeSource,
} from "../../features/knowledge/tauriAdapter";
import AnalysisArticles from "./AnalysisArticles";

function repositoryLabel(repository: GithubKnowledgeRepository): string {
  return `${repository.fullName}${repository.private ? " · Private" : ""}`;
}

export default function Knowledge({
  environmentFocus,
  onOpenAgent,
  onNewConnection,
}: {
  environmentFocus?: KnowledgeEnvironmentFocus | null;
  onOpenAgent?: (connectionId: string) => void;
  onNewConnection?: () => void;
}) {
  const queryClient = useQueryClient();
  const catalogScope = useCatalogScope();
  const projectKey = ["knowledge", "projects", catalogScope.key] as const;
  const sourceKey = ["knowledge", "sources", catalogScope.key] as const;
  const repositoryKey = [
    "knowledge",
    "github-repositories",
    catalogScope.key,
  ] as const;
  const sharedWorkspace =
    catalogScope.accountScope !== null &&
    catalogScope.accountScope !== "personal";
  const connectionsKey = ["connections", catalogScope.key] as const;
  const projects = useQuery({ queryKey: projectKey, queryFn: listKnowledgeProjects });
  const sources = useQuery({ queryKey: sourceKey, queryFn: listKnowledgeSources });
  const repositories = useQuery({
    queryKey: repositoryKey,
    queryFn: listKnowledgeGithubRepositories,
    enabled: sharedWorkspace,
    retry: false,
  });
  const connections = useQuery({ queryKey: connectionsKey, queryFn: listConnections });
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [provider, setProvider] = useState<"github" | "local_folder">("github");
  const [repositoryId, setRepositoryId] = useState("");
  const [refName, setRefName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [connectionRole, setConnectionRole] = useState("primary");
  const [connectionAlias, setConnectionAlias] = useState("");
  const [view, setView] = useState<KnowledgeEnvironmentView>("sources");
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
    queryKey: [
      "knowledge",
      "environment-connections",
      environmentId,
      catalogScope.key,
    ],
    queryFn: () => listKnowledgeEnvironmentConnections(environmentId),
    enabled: Boolean(environmentId),
  });
  const mappingsKey = [
    "knowledge",
    "mappings",
    environmentId,
    catalogScope.key,
  ] as const;
  const mappings = useQuery({
    queryKey: mappingsKey,
    queryFn: () => listKnowledgeMappings(environmentId),
    enabled:
      sharedWorkspace &&
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
    setProvider(sharedWorkspace ? "github" : "local_folder");
    setActionError(null);
  }, [catalogScope.key, sharedWorkspace]);

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
    setView(environmentFocus.view);
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
        next.set(change.sourceId, {
          state: change.state,
          errorKind: change.errorKind,
        });
        return next;
      });
      if (change.state === "ready") {
        void queryClient.invalidateQueries({ queryKey: sourceKey });
        void queryClient.invalidateQueries({
          queryKey: ["agentKnowledgeEnvironments"],
        });
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

  useEffect(() => {
    const waitingForCloudIndex = sources.data?.some(
      (source) => source.provider === "github" && source.health === "syncing",
    ) || [...sourceActivity.values()].some(
      (activity) => activity.state === "syncing"
        && activity.previousGraphRevisionId !== undefined,
    );
    if (!waitingForCloudIndex) return;
    const timer = window.setInterval(() => {
      void sources.refetch();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [sourceActivity, sources.data, sources.refetch]);

  useEffect(() => {
    if (!sources.data) return;
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
      queryClient.invalidateQueries({ queryKey: repositoryKey }),
      queryClient.invalidateQueries({
        queryKey: ["agentKnowledgeEnvironments"],
      }),
    ]);
  };

  const connectGithub = useMutation({
    mutationFn: connectKnowledgeGithubSource,
    onSuccess: async (source) => {
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
      await queryClient.invalidateQueries({
        queryKey: ["agentKnowledgeEnvironments"],
      });
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
      await queryClient.invalidateQueries({
        queryKey: ["agentKnowledgeEnvironments"],
      });
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
    onSuccess: async (result, sourceId) => {
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
        queryKey: ["agentKnowledgeEnvironments"],
      });
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
      await queryClient.invalidateQueries({
        queryKey: ["agentKnowledgeEnvironments"],
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
      await queryClient.invalidateQueries({
        queryKey: ["agentKnowledgeEnvironments"],
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
  const sourceLoadError = projects.error ?? sources.error;
  if (view === "analyses" && selectedProject && selectedEnvironment) {
    return (
      <AnalysisArticles
        projectName={selectedProject.name}
        environment={selectedEnvironment}
        bindings={environmentConnections.data ?? []}
        sharedWorkspace={sharedWorkspace}
        focusId={environmentFocus?.resourceId}
        onOpenAgent={onOpenAgent}
        onNewConnection={onNewConnection}
      />
    );
  }
  const viewTitle =
    view === "databases"
      ? "Databases"
      : view === "mappings"
          ? "Mapping review"
          : view === "explore"
            ? "Explore"
            : "Data sources";

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

      {projects.isSuccess && (projects.data?.length ?? 0) === 0 ? (
        <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
          Create a Project from the Projects section in Explorer to organize this workspace.
        </p>
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
              {sharedWorkspace ? (
                <Button size="compact" variant={provider === "github" ? "selected" : "ghost"} onClick={() => setProvider("github")}>GitHub</Button>
              ) : null}
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

      {sharedWorkspace &&
      (projects.data?.length ?? 0) > 0 &&
      view === "sources" &&
      selectedEnvironmentSources.length > 0 ? (
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
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:grid tw:min-w-0 tw:gap-1">
              <h2 className="tw:m-0 tw:text-base tw:font-semibold">Environment databases</h2>
              <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
                Bind exact connection revisions to this Environment. A binding names a resource; it never grants credentials or wider access.
              </p>
            </div>
            {onNewConnection ? (
              <Button size="compact" onClick={onNewConnection}>
                <Icon name="plus" />
                New connection
              </Button>
            ) : null}
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
                  Select a connection to review it, then create an exact Environment binding above.
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
                      {connection.id === connectionId ? "Selected" : "Review binding"}
                    </Button>
                  </div>
                ))}
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
                    <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{source.projectName} / {source.environmentName} · {knowledgeRevisionLabel(source.revision)}</span>
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
