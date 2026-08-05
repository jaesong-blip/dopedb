"use client";

// Connection grants are intentionally separate from workspace roles: membership
// makes a template visible only when a manager grants view, use, or manage.
import { useCallback, useEffect, useState } from "react";
import { useWorkspaceLocale } from "../components/WorkspaceLocale";
import type { WorkspaceLocale } from "../../lib/workspace-locale";
import { workspaceMessages } from "../../lib/workspace-messages";
import { localizedProviderMessage } from "../../lib/workspace-provider-copy";

type ConnectionCapability = "view" | "use" | "manage";
type SharedConnection = {
  id: string;
  name: string;
  engine: string;
  provider: string;
  driverId: string | null;
  host: string;
  port: number;
  database: string;
  sslmode: string;
  readonlyDefault: true;
  allowWrites: boolean;
  writeAvailable: boolean;
  env: string | null;
  schemaGroup: string | null;
  revision: number;
  accessMode: "view" | "read" | "write" | "manage";
  credentialMode: "managed" | "member_local";
};
type MemberGrant = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  capability: ConnectionCapability | null;
};

async function responseError(
  response: Response | null,
  fallback: string,
  locale: WorkspaceLocale,
) {
  const body = await response?.json().catch(() => null);
  return typeof body?.error === "string"
    ? localizedProviderMessage(body.error, locale, fallback)
    : fallback;
}

export function ConnectionAccessPanel({ workspaceId }: { workspaceId: string }) {
  const locale = useWorkspaceLocale();
  const copy = workspaceMessages[locale].connectionAccess;
  const common = workspaceMessages[locale].common;
  const [connections, setConnections] = useState<SharedConnection[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [grants, setGrants] = useState<MemberGrant[]>([]);
  const [actorMemberId, setActorMemberId] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutatingId, setMutatingId] = useState("");
  const [error, setError] = useState("");

  const loadConnections = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const response = await fetch(
      `/api/v1/workspaces/${workspaceId}/connections`,
      { cache: "no-store", signal },
    ).catch(() => null);
    if (signal?.aborted) return;
    if (!response?.ok) {
      setError(await responseError(response, copy.loadConnectionsError, locale));
      setLoading(false);
      return;
    }
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.connections)) {
      setError(copy.connectionsShapeError);
      setLoading(false);
      return;
    }
    const next = body.connections as SharedConnection[];
    setConnections(next);
    setSelectedId((current) => (
      next.some((item) => item.id === current)
        ? current
        : next[0]?.id ?? ""
    ));
    setError("");
    setLoading(false);
  }, [copy, locale, workspaceId]);

  const loadGrants = useCallback(async (
    connectionId: string,
    signal?: AbortSignal,
  ) => {
    if (!connectionId) {
      setGrants([]);
      setActorMemberId("");
      return;
    }
    const response = await fetch(
      `/api/v1/workspaces/${workspaceId}/connections/${connectionId}/grants`,
      { cache: "no-store", signal },
    ).catch(() => null);
    if (signal?.aborted) return;
    if (!response?.ok) {
      setError(await responseError(response, copy.loadGrantsError, locale));
      return;
    }
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.grants) || typeof body?.actorMemberId !== "string") {
      setError(copy.grantsShapeError);
      return;
    }
    setGrants(body.grants);
    setActorMemberId(body.actorMemberId);
    setError("");
  }, [copy, locale, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadConnections(controller.signal);
    return () => controller.abort();
  }, [loadConnections]);

  useEffect(() => {
    const controller = new AbortController();
    void loadGrants(selectedId, controller.signal);
    return () => controller.abort();
  }, [loadGrants, selectedId]);

  async function changeGrant(
    memberId: string,
    capability: ConnectionCapability | "",
  ) {
    if (!selectedId || mutatingId) return;
    setMutatingId(memberId);
    setError("");
    try {
      const endpoint =
        `/api/v1/workspaces/${workspaceId}/connections/${selectedId}/grants`;
      const response = await fetch(
        capability ? endpoint : `${endpoint}?memberId=${encodeURIComponent(memberId)}`,
        capability
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ memberId, capability }),
            }
          : { method: "DELETE" },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(response, copy.changeGrantError, locale));
        return;
      }
      await loadGrants(selectedId);
    } finally {
      setMutatingId("");
    }
  }

  const selected = connections.find((item) => item.id === selectedId) ?? null;
  const canManageWritePolicy = selected?.accessMode === "manage";

  async function changeWritePolicy(allowWrites: boolean) {
    if (
      !selected
      || !canManageWritePolicy
      || mutatingId
      || selected.credentialMode !== "managed"
    ) return;
    setMutatingId("write-policy");
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/connections/${selected.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "if-match": `"${selected.revision}"`,
          },
          body: JSON.stringify({
            name: selected.name,
            engine: selected.engine,
            provider: selected.provider,
            driverId: selected.driverId,
            host: selected.host,
            port: selected.port,
            database: selected.database,
            sslmode: selected.sslmode,
            readonlyDefault: true,
            allowWrites,
            env: selected.env,
            schemaGroup: selected.schemaGroup,
          }),
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(response, copy.changeWriteError, locale));
        return;
      }
      await loadConnections();
    } finally {
      setMutatingId("");
    }
  }

  return (
    <section className="tw:grid tw:gap-3 tw:px-5 tw:py-5">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-ui tw:text-foreground">
            {copy.title}
          </strong>
          <small className="tw:text-xs tw:leading-body tw:text-muted-foreground">
            {copy.description}
          </small>
        </div>
        <span className="tw:shrink-0 tw:rounded-full tw:border tw:border-border tw:px-2 tw:py-1 tw:font-mono tw:text-2xs tw:text-muted-foreground">
          {copy.proof}
        </span>
      </header>

      <label className="tw:grid tw:gap-1">
        <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground tw:uppercase">
          {copy.sharedConnection}
        </span>
        <select
          className="tw:h-control-field tw:w-full tw:border tw:border-border tw:bg-surface-inset tw:px-3 tw:text-ui tw:text-foreground tw:outline-none tw:focus:border-primary"
          value={selectedId}
          disabled={loading || connections.length === 0}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {connections.length === 0 ? (
            <option value="">{copy.noConnections}</option>
          ) : null}
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name} · {connection.engine}
            </option>
          ))}
        </select>
      </label>

      {selected ? (
        <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">
          {selected.credentialMode === "managed"
            ? copy.managedDescription
            : copy.localDescription}
        </p>
      ) : null}

      {selected?.credentialMode === "managed" ? (
        <label className="tw:grid tw:grid-cols-[16px_minmax(0,1fr)] tw:items-start tw:gap-2 tw:border-y tw:border-border tw:bg-surface-inset tw:px-3 tw:py-3">
          <input
            className="tw:mt-0.5 tw:size-4 tw:accent-primary"
            type="checkbox"
            checked={selected.allowWrites}
            disabled={
              mutatingId !== ""
              || !selected.writeAvailable
              || !canManageWritePolicy
            }
            onChange={(event) => void changeWritePolicy(event.target.checked)}
          />
          <span className="tw:grid tw:gap-1 tw:text-xs tw:text-foreground">
            {copy.allowWrites}
            <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
              {!selected.writeAvailable
                ? copy.noWriteAccount
                : canManageWritePolicy
                  ? copy.writePolicyManager
                  : copy.writePolicyViewer}
            </small>
          </span>
        </label>
      ) : null}

      <div className="tw:grid tw:divide-y tw:divide-border tw:border-y tw:border-border">
        {grants.map((grant) => {
          const isActor = grant.memberId === actorMemberId;
          return (
            <div
              className="tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(170px,0.48fr)] tw:items-center tw:gap-3 tw:py-2 tw:max-[720px]:grid-cols-1"
              key={grant.memberId}
            >
              <div className="tw:grid tw:min-w-0 tw:gap-0.5">
                <strong className="tw:overflow-hidden tw:text-ui tw:text-ellipsis tw:whitespace-nowrap tw:text-foreground">
                  {grant.name}
                  {isActor ? ` · ${common.me}` : ""}
                </strong>
                <small className="tw:overflow-hidden tw:text-xs tw:text-ellipsis tw:whitespace-nowrap tw:text-muted-foreground">
                  {grant.email} · {grant.role}
                </small>
              </div>
              <select
                className="tw:h-control-sm tw:w-full tw:border tw:border-border tw:bg-surface-inset tw:px-2 tw:text-xs tw:text-foreground tw:outline-none tw:focus:border-primary tw:disabled:cursor-not-allowed tw:disabled:opacity-[var(--ds-disabled-opacity)]"
                aria-label={`${grant.name} ${copy.permissionLabel}`}
                value={grant.capability ?? ""}
                disabled={mutatingId !== "" || isActor}
                onChange={(event) => void changeGrant(
                  grant.memberId,
                  event.target.value as ConnectionCapability | "",
                )}
              >
                <option value="">{copy.noAccess}</option>
                <option value="view">{copy.view}</option>
                <option value="use">
                  {selected?.credentialMode === "managed"
                    ? copy.useManaged
                    : copy.useLocal}
                </option>
                <option value="manage">{copy.manage}</option>
              </select>
            </div>
          );
        })}
      </div>
      {error ? (
        <small className="tw:text-xs tw:text-danger" role="alert">
          {error}
        </small>
      ) : null}
    </section>
  );
}
