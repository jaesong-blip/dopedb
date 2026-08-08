import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import ConfirmButton from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import {
  CheckboxField,
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
import type {
  GithubKnowledgeRepository,
  KnowledgeRevision,
} from "../../features/knowledge/domain";
import {
  beginKnowledgeGithubInstall,
  connectKnowledgeGithubSource,
  connectKnowledgeLocalFolder,
  createKnowledgeProject,
  listKnowledgeGithubRepositories,
  listKnowledgeProjects,
  listKnowledgeSources,
  revokeKnowledgeSource,
  searchKnowledgeGraph,
  syncKnowledgeSource,
} from "../../features/knowledge/tauriAdapter";

const projectKey = ["knowledge", "projects"] as const;
const sourceKey = ["knowledge", "sources"] as const;
const repositoryKey = ["knowledge", "github-repositories"] as const;

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

export default function Knowledge() {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: projectKey, queryFn: listKnowledgeProjects });
  const sources = useQuery({ queryKey: sourceKey, queryFn: listKnowledgeSources });
  const repositories = useQuery({
    queryKey: repositoryKey,
    queryFn: listKnowledgeGithubRepositories,
    retry: false,
  });
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [provider, setProvider] = useState<"github" | "local_folder">("github");
  const [repositoryId, setRepositoryId] = useState("");
  const [refName, setRefName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [environmentName, setEnvironmentName] = useState("Development");
  const [production, setProduction] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const selectedProject = useMemo(
    () => projects.data?.find((project) => project.id === projectId) ?? null,
    [projectId, projects.data],
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
    if (!repositories.data?.length || repositoryId) return;
    const repository = repositories.data.find((candidate) => !candidate.archived);
    if (!repository) return;
    setRepositoryId(repository.id);
    setRefName(repository.defaultBranch);
    setDisplayName(repository.fullName);
  }, [repositories.data, repositoryId]);

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
    onError: (error) => setActionError(errMessage(error)),
  });
  const connectLocal = useMutation({
    mutationFn: connectKnowledgeLocalFolder,
    onSuccess: async (source) => {
      if (!source) return;
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
    },
    onError: (error) => setActionError(errMessage(error)),
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
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
    },
    onError: (error) => setActionError(errMessage(error)),
  });
  const search = useMutation({
    mutationFn: ({ environmentId, query }: { environmentId: string; query: string }) =>
      searchKnowledgeGraph(environmentId, query),
    onError: (error) => setActionError(errMessage(error)),
    onSuccess: () => setActionError(null),
  });

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
          <CheckboxField
            checked={production}
            onChange={(event) => setProduction(event.target.checked)}
            label="Apply Production safeguards"
          />
          <div>
            <Button
              variant="primary"
              disabled={!projectName.trim() || !environmentName.trim() || createProject.isPending}
              onClick={() => createProject.mutate({
                name: projectName.trim(),
                environments: [{ name: environmentName.trim(), production }],
              })}
            >
              {createProject.isPending ? "Creating…" : "Create Project"}
            </Button>
          </div>
        </section>
      ) : null}

      {(projects.data?.length ?? 0) > 0 ? (
        <section data-primary-flow className="tw:grid tw:gap-4 tw:border-b tw:border-border-subtle tw:pb-5">
          <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:grid tw:gap-1">
              <h2 className="tw:m-0 tw:text-base tw:font-semibold">Connect a source</h2>
              <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">Choose the scope first; it will not change when a branch moves.</p>
            </div>
            <div className="tw:inline-flex tw:gap-1" role="group" aria-label="Source provider">
              <Button size="compact" variant={provider === "github" ? "selected" : "ghost"} onClick={() => setProvider("github")}>GitHub</Button>
              <Button size="compact" variant={provider === "local_folder" ? "selected" : "ghost"} onClick={() => setProvider("local_folder")}><Icon name="folder" />Local Folder</Button>
            </div>
          </div>

          <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[620px]:grid-cols-1">
            <Field label="Project">
              <SelectInput value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </SelectInput>
            </Field>
            <Field label="Environment">
              <SelectInput value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>
                {selectedProject?.environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>{environment.name}{environment.production ? " · Production" : ""}</option>
                ))}
              </SelectInput>
            </Field>
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

      <section className="tw:grid tw:gap-3">
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
          <h2 className="tw:m-0 tw:text-base tw:font-semibold">Sources</h2>
          <Button iconOnly size="compact" variant="ghost" title="Refresh sources" onClick={() => void sources.refetch()}><Icon name="refresh" /></Button>
        </div>
        {sources.isPending ? <LoadingLabel>Loading sources…</LoadingLabel> : (sources.data?.length ?? 0) === 0 ? (
          <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">No source is connected to this workspace yet.</p>
        ) : (
          <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
            {sources.data?.map((source) => {
              const tone: StatusTone = source.health === "ready" ? "success" : source.health === "failed" ? "danger" : "warning";
              return (
                <article key={source.sourceId} className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-3 tw:last:border-b-0 tw:@max-[560px]:grid-cols-1">
                  <div className="tw:grid tw:min-w-0 tw:gap-1">
                    <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
                      <strong className="tw:truncate tw:text-sm">{source.displayName}</strong>
                      <StatusBadge tone={tone} density="compact">{source.health}</StatusBadge>
                      <span className="badge kind">{source.provider === "github" ? "GitHub" : "Local Folder"}</span>
                    </div>
                    <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{source.projectName} / {source.environmentName} · {revisionLabel(source.revision)}</span>
                    {source.provider === "local_folder" && !source.localCapabilityAvailable ? (
                      <span className="tw:text-xs tw:text-warning">Choose the folder again on this device to restore access.</span>
                    ) : null}
                  </div>
                  <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:@max-[560px]:justify-start">
                    <Button size="compact" disabled={sync.isPending} onClick={() => sync.mutate(source.sourceId)}>
                      <Icon name="refresh" />{sync.isPending && sync.variables === source.sourceId ? "Syncing…" : "Sync"}
                    </Button>
                    <ConfirmButton size="compact" variant="dangerGhost" disabled={revoke.isPending || sync.isPending} onConfirm={() => revoke.mutate(source.sourceId)}>Remove</ConfirmButton>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {(sources.data?.length ?? 0) > 0 ? (
        <section data-primary-flow className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-5">
          <div className="tw:grid tw:gap-1">
            <h2 className="tw:m-0 tw:text-base tw:font-semibold">Explore</h2>
            <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">Search the active immutable revision. Results retain their exact source-qualified identity.</p>
          </div>
          <div className="tw:grid tw:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] tw:items-end tw:gap-2 tw:@max-[620px]:grid-cols-1">
            <Field label="Environment">
              <SelectInput value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>
                {projects.data?.flatMap((project) => project.environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>{project.name} / {environment.name}</option>
                )))}
              </SelectInput>
            </Field>
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
              ) : search.data.matches.map((node) => (
                <div key={node.id} className="tw:grid tw:min-w-0 tw:grid-cols-[auto_minmax(0,1fr)] tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:px-3 tw:py-2 tw:last:border-b-0">
                  <span className="badge kind">{node.kind}</span>
                  <span className="tw:grid tw:min-w-0 tw:gap-0.5">
                    <strong className="tw:truncate tw:text-sm">{node.name}</strong>
                    <span className="tw:truncate tw:font-mono tw:text-xs tw:text-muted-foreground">{node.qualifiedName}</span>
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
