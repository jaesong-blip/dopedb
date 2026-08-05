"use client";

// Dashboard management deliberately receives definitions and immutable revision
// metadata only. Query results are executed by Desktop with member-specific access
// and have no field in this component's HTTP contracts.
import { useCallback, useEffect, useMemo, useState } from "react";

import { ControlButton, ControlField, ControlSelect } from "../components/Controls";
import { useWorkspaceLocale } from "../components/WorkspaceLocale";
import { workspaceMessages } from "../../lib/workspace-messages";

type DashboardState = "draft" | "published" | "archived";
type DashboardVisualization = {
  version: 1;
  kind: "auto" | "metric" | "line" | "bar" | "table";
  xColumn: string | null;
  yColumns: string[];
};
type SharedDashboard = {
  id: string;
  connectionId: string;
  title: string;
  description: string;
  sql: string;
  visualization: DashboardVisualization;
  state: DashboardState;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
type DashboardRevision = {
  revision: number;
  baseRevision: number;
  operation: string;
  payload: {
    connectionId: string;
    title: string;
    description: string;
    sql: string;
    visualization: DashboardVisualization;
    state: DashboardState;
    ownerMemberId: string;
    deleted: boolean;
  };
  createdByMemberId: string;
  createdAt: string;
};
type WorkspaceMember = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
};

const dashboardStates = ["draft", "published", "archived"] as const;
const dashboardKinds = ["auto", "metric", "line", "bar", "table"] as const;
const dashboardOperations = [
  "create",
  "update",
  "publish",
  "archive",
  "restore",
  "transfer",
  "delete",
  "conflict_copy",
] as const;
const workspaceRoles = ["viewer", "analyst", "editor", "admin", "owner"] as const;

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
    ? record
    : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).valueOf());
}

function validVisualization(value: unknown): value is DashboardVisualization {
  const row = exactRecord(value, ["version", "kind", "xColumn", "yColumns"]);
  return Boolean(
    row
    && row.version === 1
    && typeof row.kind === "string"
    && dashboardKinds.includes(row.kind as (typeof dashboardKinds)[number])
    && (row.xColumn === null || typeof row.xColumn === "string")
    && Array.isArray(row.yColumns)
    && row.yColumns.length <= 4
    && row.yColumns.every((column) => typeof column === "string"),
  );
}

function validDashboard(value: unknown): value is SharedDashboard {
  const row = exactRecord(value, [
    "id",
    "connectionId",
    "title",
    "description",
    "sql",
    "visualization",
    "state",
    "ownerMemberId",
    "updatedByMemberId",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  if (!row) return false;
  return typeof row.id === "string"
    && typeof row.connectionId === "string"
    && typeof row.title === "string"
    && typeof row.description === "string"
    && typeof row.sql === "string"
    && validVisualization(row.visualization)
    && typeof row.state === "string"
    && dashboardStates.includes(row.state as DashboardState)
    && typeof row.ownerMemberId === "string"
    && typeof row.updatedByMemberId === "string"
    && Number.isSafeInteger(row.revision)
    && (row.revision as number) >= 1
    && validDate(row.createdAt)
    && validDate(row.updatedAt);
}

function validMember(value: unknown): value is WorkspaceMember {
  const row = exactRecord(value, ["id", "userId", "name", "email", "role"]);
  if (!row) return false;
  return typeof row.id === "string"
    && typeof row.userId === "string"
    && typeof row.name === "string"
    && typeof row.email === "string"
    && typeof row.role === "string"
    && workspaceRoles.includes(row.role as (typeof workspaceRoles)[number]);
}

function validRevision(value: unknown): value is DashboardRevision {
  const row = exactRecord(value, [
    "revision",
    "baseRevision",
    "operation",
    "payload",
    "createdByMemberId",
    "createdAt",
  ]);
  if (!row || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1
    || !Number.isSafeInteger(row.baseRevision) || (row.baseRevision as number) < 0
    || typeof row.operation !== "string"
    || !dashboardOperations.includes(row.operation as (typeof dashboardOperations)[number])
    || typeof row.createdByMemberId !== "string"
    || !validDate(row.createdAt)) {
    return false;
  }
  const payload = exactRecord(row.payload, [
    "connectionId",
    "title",
    "description",
    "sql",
    "visualization",
    "state",
    "ownerMemberId",
    "deleted",
  ]);
  if (!payload) return false;
  return typeof payload.connectionId === "string"
    && typeof payload.title === "string"
    && typeof payload.description === "string"
    && typeof payload.sql === "string"
    && validVisualization(payload.visualization)
    && typeof payload.state === "string"
    && dashboardStates.includes(payload.state as DashboardState)
    && typeof payload.ownerMemberId === "string"
    && typeof payload.deleted === "boolean";
}

export function DashboardManagementPanel({ workspaceId }: { workspaceId: string }) {
  const locale = useWorkspaceLocale();
  const copy = workspaceMessages[locale].sharedDashboards;
  const [dashboards, setDashboards] = useState<SharedDashboard[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [ownerCandidate, setOwnerCandidate] = useState("");
  const [revisions, setRevisions] = useState<DashboardRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");

  const selected = useMemo(
    () => dashboards.find((dashboard) => dashboard.id === selectedId) ?? null,
    [dashboards, selectedId],
  );

  const stateLabel = useCallback((state: DashboardState) => {
    if (state === "published") return copy.statePublished;
    if (state === "archived") return copy.stateArchived;
    return copy.stateDraft;
  }, [copy]);

  const responseError = useCallback(async (response: Response | null, fallback: string) => {
    const body = await response?.json().catch(() => null);
    return typeof body?.error === "string" ? body.error : fallback;
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const [dashboardResponse, memberResponse] = await Promise.all([
      fetch(`/api/v1/workspaces/${workspaceId}/dashboards`, {
        cache: "no-store",
        signal,
      }).catch(() => null),
      fetch(`/api/v1/workspaces/${workspaceId}/dashboards/owners`, {
        cache: "no-store",
        signal,
      }).catch(() => null),
    ]);
    if (signal?.aborted) return;
    if (!dashboardResponse?.ok || !memberResponse?.ok) {
      setError(await responseError(
        !dashboardResponse?.ok ? dashboardResponse : memberResponse,
        copy.loadError,
      ));
      setLoading(false);
      return;
    }
    const [dashboardBody, memberBody] = await Promise.all([
      dashboardResponse.json().catch(() => null),
      memberResponse.json().catch(() => null),
    ]);
    if (
      !Array.isArray(dashboardBody?.dashboards)
      || !dashboardBody.dashboards.every(validDashboard)
      || !Array.isArray(memberBody?.owners)
      || !memberBody.owners.every(validMember)
    ) {
      setError(copy.shapeError);
      setLoading(false);
      return;
    }
    const nextDashboards = dashboardBody.dashboards as SharedDashboard[];
    setDashboards(nextDashboards);
    setMembers(memberBody.owners as WorkspaceMember[]);
    setSelectedId((current) => (
      nextDashboards.some((dashboard) => dashboard.id === current)
        ? current
        : nextDashboards[0]?.id ?? ""
    ));
    setError("");
    setLoading(false);
  }, [copy.loadError, copy.shapeError, responseError, workspaceId]);

  const loadRevisions = useCallback(async (
    dashboardId: string,
    signal?: AbortSignal,
  ) => {
    if (!dashboardId) {
      setRevisions([]);
      return;
    }
    const response = await fetch(
      `/api/v1/workspaces/${workspaceId}/dashboards/${dashboardId}/revisions`,
      { cache: "no-store", signal },
    ).catch(() => null);
    if (signal?.aborted) return;
    if (!response?.ok) {
      setError(await responseError(response, copy.historyError));
      return;
    }
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.revisions) || !body.revisions.every(validRevision)) {
      setError(copy.historyError);
      return;
    }
    setRevisions(body.revisions as DashboardRevision[]);
  }, [copy.historyError, responseError, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    setOwnerCandidate(selected?.ownerMemberId ?? "");
    const controller = new AbortController();
    void loadRevisions(selectedId, controller.signal);
    return () => controller.abort();
  }, [loadRevisions, selected?.ownerMemberId, selectedId]);

  async function mutate(body: Record<string, unknown>) {
    if (!selected || mutating) return;
    setMutating(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/dashboards/${selected.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "if-match": `"${selected.revision}"`,
          },
          body: JSON.stringify(body),
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(response, copy.mutationError));
        return;
      }
      await load();
      await loadRevisions(selected.id);
    } finally {
      setMutating(false);
    }
  }

  return (
    <section className="tw:grid tw:gap-4 tw:px-5 tw:py-5">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-ui tw:text-foreground">{copy.title}</strong>
          <small className="tw:max-w-[72ch] tw:text-xs tw:leading-body tw:text-muted-foreground">
            {copy.description}
          </small>
        </div>
        <span className="tw:shrink-0 tw:rounded-full tw:border tw:border-success/35 tw:px-2 tw:py-1 tw:font-mono tw:text-2xs tw:text-success">
          {copy.proof}
        </span>
      </header>

      {loading ? (
        <p className="tw:m-0 tw:py-8 tw:text-center tw:text-xs tw:text-muted-foreground">
          {copy.loading}
        </p>
      ) : dashboards.length === 0 ? (
        <div className="tw:grid tw:place-items-center tw:gap-2 tw:border-y tw:border-border tw:py-12 tw:text-center">
          <strong className="tw:text-sm tw:text-foreground">{copy.emptyTitle}</strong>
          <small className="tw:max-w-[56ch] tw:text-xs tw:leading-body tw:text-muted-foreground">
            {copy.emptyDescription}
          </small>
        </div>
      ) : (
        <div className="tw:grid tw:grid-cols-[minmax(220px,0.38fr)_minmax(0,1fr)] tw:items-start tw:gap-4 tw:max-[820px]:grid-cols-1">
          <nav className="tw:grid tw:overflow-hidden tw:rounded-surface tw:border tw:border-border" aria-label={copy.title}>
            {dashboards.map((dashboard) => (
              <button
                className="tw:grid tw:min-w-0 tw:cursor-pointer tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:border-0 tw:border-b tw:border-border tw:bg-surface tw:px-3 tw:py-3 tw:text-left tw:last:border-b-0 tw:hover:bg-surface-raised tw:data-[active=true]:bg-selection tw:focus-visible:outline-2 tw:focus-visible:outline-offset-[-3px] tw:focus-visible:outline-ring"
                data-active={dashboard.id === selectedId}
                key={dashboard.id}
                onClick={() => setSelectedId(dashboard.id)}
                type="button"
              >
                <span className="tw:grid tw:min-w-0 tw:gap-1">
                  <strong className="tw:truncate tw:text-xs tw:text-foreground">{dashboard.title}</strong>
                  <small className="tw:font-mono tw:text-2xs tw:text-muted-foreground">
                    r{dashboard.revision} · {dashboard.visualization.kind}
                  </small>
                </span>
                <span
                  className="tw:rounded-full tw:border tw:border-warning/50 tw:px-2 tw:py-1 tw:font-mono tw:text-2xs tw:text-warning tw:data-[state=archived]:border-border tw:data-[state=archived]:text-muted-foreground tw:data-[state=published]:border-success/40 tw:data-[state=published]:text-success"
                  data-state={dashboard.state}
                >
                  {stateLabel(dashboard.state)}
                </span>
              </button>
            ))}
          </nav>

          {selected ? (
            <article className="tw:grid tw:min-w-0 tw:gap-5 tw:rounded-surface tw:border tw:border-border tw:bg-surface-inset/55 tw:p-4">
              <header className="tw:flex tw:min-w-0 tw:items-start tw:justify-between tw:gap-3 tw:max-[600px]:flex-col">
                <div className="tw:grid tw:min-w-0 tw:gap-1">
                  <h4 className="tw:m-0 tw:truncate tw:text-base tw:font-medium tw:text-foreground">{selected.title}</h4>
                  {selected.description ? (
                    <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">{selected.description}</p>
                  ) : null}
                </div>
                <div className="tw:flex tw:flex-wrap tw:gap-2">
                  {selected.state === "draft" ? (
                    <ControlButton disabled={mutating} onClick={() => void mutate({ action: "publish" })} tone="primary">
                      {copy.publish}
                    </ControlButton>
                  ) : null}
                  {selected.state === "archived" ? (
                    <ControlButton
                      disabled={mutating}
                      onClick={() => void mutate({ action: "restore", revision: selected.revision })}
                      tone="primary"
                    >
                      {copy.restore}
                    </ControlButton>
                  ) : null}
                  {selected.state !== "archived" ? (
                    <ControlButton disabled={mutating} onClick={() => void mutate({ action: "archive" })}>
                      {copy.archive}
                    </ControlButton>
                  ) : null}
                </div>
              </header>

              <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-3 tw:max-[640px]:grid-cols-1">
                <ControlField label={copy.owner}>
                  <ControlSelect
                    disabled={mutating}
                    onChange={(event) => setOwnerCandidate(event.target.value)}
                    value={ownerCandidate}
                  >
                    {members.filter((member) => (
                      member.role === "editor"
                      || member.role === "admin"
                      || member.role === "owner"
                    )).map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name} · {member.email} · {member.role}
                      </option>
                    ))}
                  </ControlSelect>
                </ControlField>
                <ControlButton
                  disabled={mutating || !ownerCandidate || ownerCandidate === selected.ownerMemberId}
                  onClick={() => void mutate({ action: "transfer", ownerMemberId: ownerCandidate })}
                >
                  {copy.transfer}
                </ControlButton>
              </div>

              <section className="tw:grid tw:gap-2">
                <strong className="tw:font-mono tw:text-2xs tw:tracking-[0.06em] tw:uppercase tw:text-muted-foreground">{copy.definition}</strong>
                <div className="tw:flex tw:flex-wrap tw:gap-2 tw:text-2xs tw:text-muted-foreground">
                  <span className="tw:rounded-full tw:border tw:border-border tw:px-2 tw:py-1">
                    {copy.visualization}: {selected.visualization.kind}
                  </span>
                  <span className="tw:rounded-full tw:border tw:border-border tw:px-2 tw:py-1">
                    {copy.revision} {selected.revision}
                  </span>
                </div>
                <details className="tw:overflow-hidden tw:rounded-control tw:border tw:border-border tw:bg-surface">
                  <summary className="tw:cursor-pointer tw:px-3 tw:py-2 tw:text-xs tw:text-foreground">{copy.savedSql}</summary>
                  <pre className="tw:m-0 tw:max-h-64 tw:overflow-auto tw:border-t tw:border-border tw:p-3 tw:font-mono tw:text-2xs tw:leading-body tw:whitespace-pre-wrap tw:break-words tw:text-muted-foreground">{selected.sql}</pre>
                </details>
              </section>

              <section className="tw:grid tw:gap-2">
                <strong className="tw:font-mono tw:text-2xs tw:tracking-[0.06em] tw:uppercase tw:text-muted-foreground">{copy.history}</strong>
                <div className="tw:grid tw:divide-y tw:divide-border tw:border-y tw:border-border">
                  {revisions.map((revision) => (
                    <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:py-2" key={revision.revision}>
                      <span className="tw:grid tw:min-w-0 tw:gap-0.5">
                        <strong className="tw:text-xs tw:text-foreground">
                          {copy.revision} {revision.revision} · {revision.operation}
                        </strong>
                        <small className="tw:truncate tw:text-2xs tw:text-muted-foreground">
                          {new Date(revision.createdAt).toLocaleString(locale)}
                          {revision.payload.deleted ? ` · ${copy.deletedRevision}` : ""}
                        </small>
                      </span>
                      {revision.revision === selected.revision ? (
                        <span className="tw:font-mono tw:text-2xs tw:text-primary">{copy.current}</span>
                      ) : !revision.payload.deleted ? (
                        <ControlButton
                          disabled={mutating}
                          onClick={() => void mutate({ action: "restore", revision: revision.revision })}
                        >
                          {copy.restore}
                        </ControlButton>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
              {mutating ? (
                <small className="tw:text-xs tw:text-primary" role="status">{copy.updating}</small>
              ) : null}
            </article>
          ) : (
            <p className="tw:m-0 tw:py-12 tw:text-center tw:text-xs tw:text-muted-foreground">{copy.selectDashboard}</p>
          )}
        </div>
      )}
      {error ? <small className="tw:text-xs tw:text-danger" role="alert">{error}</small> : null}
    </section>
  );
}
