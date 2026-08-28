import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import {
  ModalBackdrop,
  ModalFooter,
  ModalSurface,
  ModalTitleBar,
} from "../../design-system/components/Modal";
import { InlineNotice, LoadingLabel } from "../../design-system/components/Status";
import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type {
  ConnectionId,
  ConnectionProfile,
} from "../connections/domain";
import { githubSourceRevisionLabel } from "../knowledge/presentation";
import type {
  ExternalAgentConfig,
  ExternalAgentRequestSummary,
} from "./externalAgentDomain";
import {
  listExternalAgentRequests,
  onExternalAgentRequestFinished,
  onExternalAgentRequested,
  respondExternalAgentRequest,
} from "./externalAgentTauriAdapter";
import { agentResourceScopes } from "./useAgentScopeSelection";
import {
  type AgentDatabaseResourceChoice,
  type AgentProjectResourceChoice,
  type AgentSourceResourceChoice,
  useAgentEnvironmentInventory,
} from "./useAgentEnvironmentInventory";

type ResourceSelection = {
  projectId: string | null;
  databaseIds: ConnectionId[];
  sourceIds: string[];
  writeConnectionId: ConnectionId | null;
};

const EMPTY_SELECTION: ResourceSelection = {
  projectId: null,
  databaseIds: [],
  sourceIds: [],
  writeConnectionId: null,
};

export function ExternalAgentRequestGate({
  catalogScopeKey,
  connections,
  selectedConnection,
}: {
  catalogScopeKey: string;
  connections: ConnectionProfile[];
  selectedConnection: ConnectionProfile | null;
}) {
  const { t } = useI18n();
  const [requests, setRequests] = useState<ExternalAgentRequestSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRequests(await listExternalAgentRequests());
    } catch (reason) {
      setError(t("agent.externalRequestLoadFailed", { error: errMessage(reason) }));
    }
  }, [t]);

  useEffect(() => {
    let disposed = false;
    let unlistens: (() => void)[] = [];
    void Promise.all([
      onExternalAgentRequested((request) => {
        if (disposed) return;
        setRequests((current) =>
          current.some((candidate) => candidate.id === request.id)
            ? current
            : [...current, request],
        );
      }),
      onExternalAgentRequestFinished((requestId) => {
        if (disposed) return;
        setRequests((current) =>
          current.filter((request) => request.id !== requestId),
        );
      }),
    ])
      .then((stops) => {
        if (disposed) stops.forEach((stop) => stop());
        else {
          unlistens = stops;
          // Subscribe before listing so a CLI request cannot land in the gap
          // between the initial snapshot and event registration.
          void refresh();
        }
      })
      .catch((reason) => {
        if (disposed) return;
        setError(
          t("agent.externalRequestLoadFailed", { error: errMessage(reason) }),
        );
        void refresh();
      });
    return () => {
      disposed = true;
      unlistens.forEach((stop) => stop());
    };
  }, [refresh, t]);

  const active = requests[0] ?? null;
  const requestedAnchor = active?.config?.anchorConnectionId;
  const anchor =
    connections.find((connection) => connection.id === requestedAnchor) ??
    selectedConnection ??
    connections[0] ??
    null;

  const respond = useCallback(
    async (approved: boolean, config: ExternalAgentConfig | null) => {
      if (!active || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        await respondExternalAgentRequest(active.id, approved, config);
        setRequests((current) =>
          current.filter((request) => request.id !== active.id),
        );
      } catch (reason) {
        setError(
          t("agent.externalRequestResponseFailed", { error: errMessage(reason) }),
        );
        // A timeout or exited CLI can race with the click. Reconcile the
        // snapshot so an already-finished request never traps the modal open.
        try {
          setRequests(await listExternalAgentRequests());
        } catch {
          // Keep the response error visible; the next lifecycle event or app
          // reload will reconcile the registry.
        }
      } finally {
        setSubmitting(false);
      }
    },
    [active, submitting, t],
  );

  if (!active) return null;
  if (!anchor) {
    return (
      <ExternalAgentUnavailableDialog
        request={active}
        error={error}
        submitting={submitting}
        onReject={() => void respond(false, null)}
      />
    );
  }
  return (
    <ExternalAgentRequestDialog
      key={active.id}
      request={active}
      anchor={anchor}
      connections={connections}
      catalogScopeKey={catalogScopeKey}
      error={error}
      submitting={submitting}
      onApprove={(config) => void respond(true, config)}
      onReject={() => void respond(false, null)}
    />
  );
}

function ExternalAgentUnavailableDialog({
  request,
  error,
  submitting,
  onReject,
}: {
  request: ExternalAgentRequestSummary;
  error: string | null;
  submitting: boolean;
  onReject: () => void;
}) {
  const { t } = useI18n();
  return (
    <ModalBackdrop>
      <ModalSurface
        aria-labelledby="external-agent-unavailable-title"
        dismissible={!submitting}
        onRequestClose={onReject}
      >
        <ModalTitleBar
          title={t("agent.externalRequestTitle")}
          titleId="external-agent-unavailable-title"
          closeLabel={t("common.close")}
          closeDisabled={submitting}
          onClose={onReject}
        />
        <div className="tw:grid tw:gap-3 tw:p-5">
          <InlineNotice tone="danger" icon="alert" role="alert">
            {error ?? t("agent.externalNoConnection")}
          </InlineNotice>
          <RequestIdentity request={request} />
        </div>
        <ModalFooter>
          <Button disabled={submitting} onClick={onReject}>
            {t("agent.externalReject")}
          </Button>
        </ModalFooter>
      </ModalSurface>
    </ModalBackdrop>
  );
}

function ExternalAgentRequestDialog({
  request,
  anchor,
  connections,
  catalogScopeKey,
  error,
  submitting,
  onApprove,
  onReject,
}: {
  request: ExternalAgentRequestSummary;
  anchor: ConnectionProfile;
  connections: ConnectionProfile[];
  catalogScopeKey: string;
  error: string | null;
  submitting: boolean;
  onApprove: (config: ExternalAgentConfig | null) => void;
  onReject: () => void;
}) {
  const { t } = useI18n();
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const inventory = useAgentEnvironmentInventory({
    catalogScopeKey,
    connection: anchor,
    connections,
    onError: setInventoryError,
  });

  return (
    <ModalBackdrop>
      <ModalSurface
        size="wide"
        fill
        aria-labelledby="external-agent-request-title"
        dismissible={!submitting}
        onRequestClose={onReject}
      >
        <ModalTitleBar
          title={
            request.kind === "configure"
              ? t("agent.externalConfigureTitle")
              : t("agent.externalStartTitle")
          }
          titleId="external-agent-request-title"
          closeLabel={t("common.close")}
          closeDisabled={submitting}
          onClose={onReject}
        />
        <div className="tw:grid tw:min-h-0 tw:flex-1 tw:grid-cols-[minmax(0,1fr)_minmax(260px,0.42fr)] tw:overflow-hidden tw:max-[760px]:grid-cols-1">
          <div className="tw:min-h-0 tw:overflow-auto tw:p-5">
            {inventory.pending ? (
              <LoadingLabel>{t("agent.externalLoadingResources")}</LoadingLabel>
            ) : request.kind === "configure" ? (
              <ExternalAgentConfigurationPicker
                request={request}
                projects={inventory.projects}
                disabled={submitting || inventory.updatingEnvironmentId !== null}
                ensureAvailable={inventory.ensureAvailable}
                onApprove={onApprove}
              />
            ) : (
              <ExternalAgentStartReview
                request={request}
                projects={inventory.projects}
              />
            )}
          </div>
          <aside className="tw:grid tw:content-start tw:gap-4 tw:border-l tw:border-border-subtle tw:bg-muted tw:p-5 tw:max-[760px]:border-t tw:max-[760px]:border-l-0">
            <RequestIdentity request={request} />
            <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
              {t("agent.externalSecurityBody")}
            </p>
          </aside>
        </div>
        {error || inventoryError || inventory.loadError ? (
          <div className="tw:px-5 tw:pb-3">
            <InlineNotice tone="danger" icon="alert" role="alert">
              {error ?? inventoryError ?? inventory.loadError}
            </InlineNotice>
          </div>
        ) : null}
        <ModalFooter>
          <Button disabled={submitting} onClick={onReject}>
            {t("agent.externalReject")}
          </Button>
          {request.kind === "start" ? (
            <StartApprovalButton
              request={request}
              projects={inventory.projects}
              disabled={submitting || inventory.pending || Boolean(inventory.loadError)}
              ensureAvailable={inventory.ensureAvailable}
              onApprove={() => onApprove(null)}
            />
          ) : null}
        </ModalFooter>
      </ModalSurface>
    </ModalBackdrop>
  );
}

function ExternalAgentConfigurationPicker({
  request,
  projects,
  disabled,
  ensureAvailable,
  onApprove,
}: {
  request: ExternalAgentRequestSummary;
  projects: AgentProjectResourceChoice[];
  disabled: boolean;
  ensureAvailable: (
    environmentId: string,
    authorityConnectionId: ConnectionId,
  ) => Promise<boolean>;
  onApprove: (config: ExternalAgentConfig) => void;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<ResourceSelection>(EMPTY_SELECTION);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (selection.projectId !== null || projects.length === 0) return;
    const project = projects[0];
    const database = project.databases[0];
    const source = database ? undefined : project.sources[0];
    setSelection({
      projectId: project.id,
      databaseIds: database ? [database.connectionId] : [],
      sourceIds: source ? [source.sourceId] : [],
      writeConnectionId: null,
    });
  }, [projects, selection.projectId]);

  const resources = selectedResources(projects, selection);
  const resourceCount = resources.databases.length + resources.sources.length;
  const config = useMemo<ExternalAgentConfig | null>(() => {
    const anchorConnectionId =
      selection.writeConnectionId ??
      resources.databases[0]?.connectionId ??
      resources.sources[0]?.authorityConnectionId;
    if (!resources.project || !anchorConnectionId || resourceCount === 0) return null;
    return {
      schemaVersion: 1,
      provider: request.provider,
      projectId: resources.project.id,
      anchorConnectionId,
      resourceScopes: agentResourceScopes(resources.databases, resources.sources),
      ...(selection.writeConnectionId
        ? { writeConnectionId: selection.writeConnectionId }
        : {}),
    };
  }, [request.provider, resourceCount, resources, selection.writeConnectionId]);

  function toggle(resource: AgentDatabaseResourceChoice | AgentSourceResourceChoice) {
    if (disabled || preparing) return;
    setSelection((current) => {
      const sameProject = current.projectId === resource.projectId;
      const databaseIds = sameProject ? [...current.databaseIds] : [];
      const sourceIds = sameProject ? [...current.sourceIds] : [];
      if (resource.kind === "database") {
        const index = databaseIds.indexOf(resource.connectionId);
        if (index >= 0) databaseIds.splice(index, 1);
        else databaseIds.push(resource.connectionId);
      } else {
        const index = sourceIds.indexOf(resource.sourceId);
        if (index >= 0) sourceIds.splice(index, 1);
        else sourceIds.push(resource.sourceId);
      }
      if (databaseIds.length + sourceIds.length === 0) return current;
      return {
        projectId: resource.projectId,
        databaseIds,
        sourceIds,
        writeConnectionId:
          sameProject &&
          current.writeConnectionId !== null &&
          databaseIds.includes(current.writeConnectionId)
            ? current.writeConnectionId
            : null,
      };
    });
  }

  async function approve() {
    if (!config || disabled || preparing) return;
    setPreparing(true);
    try {
      for (const boundary of resourceBoundaries(
        resources.databases,
        resources.sources,
      )) {
        if (
          boundary.stale &&
          !(await ensureAvailable(
            boundary.environmentId,
            boundary.authorityConnectionId,
          ))
        ) {
          return;
        }
      }
      onApprove(config);
    } finally {
      setPreparing(false);
    }
  }

  return (
    <div className="tw:grid tw:gap-5">
      <div>
        <h2 className="tw:m-0 tw:text-base tw:font-semibold">
          {t("agent.externalChooseResources")}
        </h2>
        <p className="tw:mt-1 tw:mb-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
          {t("agent.externalChooseResourcesBody")}
        </p>
      </div>
      {projects.map((project) => (
        <section key={project.id} className="tw:grid tw:gap-2">
          <h3 className="tw:m-0 tw:flex tw:items-center tw:gap-2 tw:text-sm tw:font-semibold">
            <Icon name="folder" className="tw:text-muted-foreground" />
            {project.name}
          </h3>
          <div className="tw:grid tw:grid-cols-2 tw:gap-2 tw:max-[760px]:grid-cols-1">
            {[...project.databases, ...project.sources].map((resource) => {
              const checked =
                resource.kind === "database"
                  ? selection.databaseIds.includes(resource.connectionId)
                  : selection.sourceIds.includes(resource.sourceId);
              const resourceDisabled =
                disabled || preparing || (checked && resourceCount === 1);
              return (
                <label
                  key={resource.key}
                  className="tw:flex tw:min-h-control-xl tw:cursor-pointer tw:items-center tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:px-3 tw:py-2 tw:data-[checked=true]:border-ring tw:data-[checked=true]:bg-selection tw:data-[disabled=true]:cursor-default tw:data-[disabled=true]:opacity-55"
                  data-checked={checked}
                  data-disabled={resourceDisabled}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={resourceDisabled}
                    onChange={() => toggle(resource)}
                    className="tw:size-4 tw:accent-primary"
                  />
                  <Icon
                    name={resource.kind === "database" ? "database" : "branch"}
                    className="tw:text-muted-foreground"
                  />
                  <span className="tw:grid tw:min-w-0 tw:flex-1 tw:gap-0.5">
                    <span className="tw:truncate tw:text-sm tw:font-medium">
                      {resource.kind === "database"
                        ? resource.databaseName
                        : resource.displayName}
                    </span>
                    <span className="tw:truncate tw:text-xs tw:font-normal tw:text-muted-foreground">
                      {resource.kind === "database"
                        ? resource.engine
                        : githubSourceRevisionLabel(
                            resource.repository,
                            resource.commitSha,
                          )}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
      ))}
      {resources.databases.length > 0 ? (
        <fieldset className="tw:grid tw:gap-2 tw:border-0 tw:p-0">
          <legend className="tw:text-sm tw:font-semibold">
            {t("agent.acpWriteTarget")}
          </legend>
          <label className="tw:flex tw:items-center tw:gap-2 tw:text-sm">
            <input
              type="radio"
              checked={selection.writeConnectionId === null}
              disabled={disabled || preparing}
              onChange={() =>
                setSelection((current) => ({ ...current, writeConnectionId: null }))
              }
              className="tw:size-4 tw:accent-primary"
            />
            {t("agent.acpReadOnlyContext")}
          </label>
          {resources.databases
            .filter((database) => database.writable)
            .map((database) => (
              <label
                key={database.connectionId}
                className="tw:flex tw:items-center tw:gap-2 tw:text-sm"
              >
                <input
                  type="radio"
                  checked={selection.writeConnectionId === database.connectionId}
                  disabled={disabled || preparing}
                  onChange={() =>
                    setSelection((current) => ({
                      ...current,
                      writeConnectionId: database.connectionId,
                    }))
                  }
                  className="tw:size-4 tw:accent-primary"
                />
                {database.databaseName}
              </label>
            ))}
        </fieldset>
      ) : null}
      <Button
        variant="primary"
        disabled={disabled || preparing || !config}
        data-modal-initial-focus
        onClick={() => void approve()}
      >
        {t("agent.externalSaveConfig")}
      </Button>
    </div>
  );
}

function ExternalAgentStartReview({
  request,
  projects,
}: {
  request: ExternalAgentRequestSummary;
  projects: AgentProjectResourceChoice[];
}) {
  const { t } = useI18n();
  const review = requestedResources(request.config, projects);
  if (!request.config || !review.complete) {
    return (
      <InlineNotice tone="danger" icon="alert" role="alert">
        {t("agent.externalConfiguredResourcesMissing")}
      </InlineNotice>
    );
  }
  return (
    <div className="tw:grid tw:gap-4">
      <div>
        <h2 className="tw:m-0 tw:text-base tw:font-semibold">
          {review.project?.name ?? request.config.projectId}
        </h2>
        <p className="tw:mt-1 tw:mb-0 tw:text-sm tw:text-muted-foreground">
          {t("agent.externalReviewExactScope")}
        </p>
      </div>
      <ResourceReviewList
        databases={review.databases}
        sources={review.sources}
        writeConnectionId={request.config.writeConnectionId ?? null}
      />
      {review.needsRefresh ? (
        <InlineNotice tone="warning" icon="alert" role="status">
          {t("agent.externalResourcesChanged")}
        </InlineNotice>
      ) : null}
    </div>
  );
}

function StartApprovalButton({
  request,
  projects,
  disabled,
  ensureAvailable,
  onApprove,
}: {
  request: ExternalAgentRequestSummary;
  projects: AgentProjectResourceChoice[];
  disabled: boolean;
  ensureAvailable: (
    environmentId: string,
    authorityConnectionId: ConnectionId,
  ) => Promise<boolean>;
  onApprove: () => void;
}) {
  const { t } = useI18n();
  const [preparing, setPreparing] = useState(false);
  const review = requestedResources(request.config, projects);

  async function approve() {
    if (!review.complete || disabled || preparing) return;
    setPreparing(true);
    try {
      const boundaries = resourceBoundaries(
        review.databases,
        review.sources,
      );
      for (const boundary of boundaries) {
        if (
          boundary.stale &&
          !(await ensureAvailable(
            boundary.environmentId,
            boundary.authorityConnectionId,
          ))
        ) {
          return;
        }
      }
      // Reconfirmation can advance a connection revision. Make the user review
      // the newly loaded exact resources before granting a process capability.
      if (boundaries.some((boundary) => boundary.stale)) return;
      onApprove();
    } finally {
      setPreparing(false);
    }
  }

  return (
    <Button
      variant="primary"
      disabled={disabled || preparing || !review.complete}
      data-modal-initial-focus
      onClick={() => void approve()}
    >
      {review.needsRefresh
        ? t("agent.externalRefreshResources")
        : t("agent.externalApproveStart")}
    </Button>
  );
}

function ResourceReviewList({
  databases,
  sources,
  writeConnectionId,
}: {
  databases: AgentDatabaseResourceChoice[];
  sources: AgentSourceResourceChoice[];
  writeConnectionId: ConnectionId | null;
}) {
  const { t } = useI18n();
  return (
    <div className="tw:grid tw:gap-2">
      {databases.map((database) => (
        <div
          key={database.connectionId}
          className="tw:flex tw:items-center tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:px-3 tw:py-2"
        >
          <Icon name="database" className="tw:text-muted-foreground" />
          <span className="tw:grid tw:min-w-0 tw:flex-1">
            <span className="tw:truncate tw:text-sm tw:font-medium">
              {database.databaseName}
            </span>
            <span className="tw:truncate tw:text-xs tw:text-muted-foreground">
              {t("agent.externalDatabaseRevision", {
                engine: database.engine,
                revision: database.connectionRevision,
              })}
            </span>
          </span>
          <span className="tw:text-xs tw:text-muted-foreground">
            {database.connectionId === writeConnectionId
              ? t("agent.externalWriteTarget")
              : t("agent.acpReadOnlyContext")}
          </span>
        </div>
      ))}
      {sources.map((source) => (
        <div
          key={source.sourceId}
          className="tw:flex tw:items-center tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:px-3 tw:py-2"
        >
          <Icon name="branch" className="tw:text-muted-foreground" />
          <span className="tw:grid tw:min-w-0 tw:flex-1">
            <span className="tw:truncate tw:text-sm tw:font-medium">
              {source.displayName}
            </span>
            <span className="tw:truncate tw:text-xs tw:text-muted-foreground">
              {githubSourceRevisionLabel(source.repository, source.commitSha)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function RequestIdentity({ request }: { request: ExternalAgentRequestSummary }) {
  const { t } = useI18n();
  return (
    <dl className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:gap-x-3 tw:gap-y-2 tw:text-sm">
      <dt className="tw:text-muted-foreground">{t("agent.externalProvider")}</dt>
      <dd className="tw:m-0 tw:font-medium">
        {request.provider === "codex" ? "Codex" : "Claude Code"}
      </dd>
      <dt className="tw:text-muted-foreground">{t("agent.externalDirectory")}</dt>
      <dd className="tw:m-0 tw:min-w-0 tw:break-all tw:font-mono tw:text-xs">
        {request.workingDirectory}
      </dd>
    </dl>
  );
}

function selectedResources(
  projects: AgentProjectResourceChoice[],
  selection: ResourceSelection,
) {
  const project = projects.find((candidate) => candidate.id === selection.projectId);
  return {
    project,
    databases:
      project?.databases.filter((database) =>
        selection.databaseIds.includes(database.connectionId),
      ) ?? [],
    sources:
      project?.sources.filter((source) => selection.sourceIds.includes(source.sourceId)) ?? [],
  };
}

function requestedResources(
  config: ExternalAgentConfig | undefined,
  projects: AgentProjectResourceChoice[],
) {
  const project = projects.find((candidate) => candidate.id === config?.projectId);
  const databases: AgentDatabaseResourceChoice[] = [];
  const sources: AgentSourceResourceChoice[] = [];
  let exact = Boolean(config && project);
  for (const scope of config?.resourceScopes ?? []) {
    const scopedDatabases = scope.connectionIds.flatMap((connectionId) => {
      const database = project?.databases.find(
        (candidate) =>
          candidate.connectionId === connectionId &&
          candidate.environmentId === scope.projectEnvironmentId,
      );
      return database ? [database] : [];
    });
    const scopedSources = scope.sourceIds.flatMap((sourceId) => {
      const source = project?.sources.find(
        (candidate) =>
          candidate.sourceId === sourceId &&
          candidate.environmentId === scope.projectEnvironmentId,
      );
      return source ? [source] : [];
    });
    const authorityAvailable = [...scopedDatabases, ...scopedSources].some(
      (resource) => resource.authorityConnectionId === scope.authorityConnectionId,
    );
    exact &&=
      scopedDatabases.length === scope.connectionIds.length &&
      scopedSources.length === scope.sourceIds.length &&
      authorityAvailable;
    databases.push(...scopedDatabases);
    sources.push(...scopedSources);
  }
  const selectedDatabaseIds = new Set(
    databases.map((database) => database.connectionId),
  );
  const selectedSourceIds = new Set(sources.map((source) => source.sourceId));
  const anchorAvailable = Boolean(
    config &&
      (selectedDatabaseIds.has(config.anchorConnectionId) ||
        [...databases, ...sources].some(
          (resource) =>
            resource.authorityConnectionId === config.anchorConnectionId,
        )),
  );
  const writeAvailable =
    !config?.writeConnectionId ||
    databases.some(
      (database) =>
        database.connectionId === config.writeConnectionId && database.writable,
    );
  return {
    project,
    databases,
    sources,
    complete:
      exact &&
      anchorAvailable &&
      writeAvailable &&
      selectedDatabaseIds.size === databases.length &&
      selectedSourceIds.size === sources.length &&
      databases.length + sources.length > 0,
    needsRefresh: [...databases, ...sources].some(
      (resource) => resource.needsReconfirmation,
    ),
  };
}

function resourceBoundaries(
  databases: AgentDatabaseResourceChoice[],
  sources: AgentSourceResourceChoice[],
) {
  const boundaries = new Map<
    string,
    {
      environmentId: string;
      authorityConnectionId: ConnectionId;
      stale: boolean;
    }
  >();
  for (const resource of [...databases, ...sources]) {
    const current = boundaries.get(resource.environmentId);
    boundaries.set(resource.environmentId, {
      environmentId: resource.environmentId,
      authorityConnectionId:
        current?.authorityConnectionId ?? resource.authorityConnectionId,
      stale: Boolean(current?.stale || resource.needsReconfirmation),
    });
  }
  return [...boundaries.values()];
}
