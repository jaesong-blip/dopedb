"use client";

// Connection grants are intentionally separate from workspace roles: membership
// makes a template visible only when a manager grants view, use, or manage.
import { useCallback, useEffect, useState } from "react";

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

async function responseError(response: Response | null, fallback: string) {
  const body = await response?.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

export function ConnectionAccessPanel({ workspaceId }: { workspaceId: string }) {
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
      setError(await responseError(response, "공유 연결을 불러오지 못했습니다."));
      setLoading(false);
      return;
    }
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.connections)) {
      setError("공유 연결 응답 형식을 확인하지 못했습니다.");
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
  }, [workspaceId]);

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
      setError(await responseError(response, "연결 권한을 불러오지 못했습니다."));
      return;
    }
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.grants) || typeof body?.actorMemberId !== "string") {
      setError("연결 권한 응답 형식을 확인하지 못했습니다.");
      return;
    }
    setGrants(body.grants);
    setActorMemberId(body.actorMemberId);
    setError("");
  }, [workspaceId]);

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
        setError(await responseError(response, "연결 권한을 변경하지 못했습니다."));
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
        setError(await responseError(response, "쓰기 정책을 변경하지 못했습니다."));
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
            DB별 접근 권한
          </strong>
          <small className="tw:text-xs tw:leading-body tw:text-muted-foreground">
            워크스페이스 멤버십과 별도로 DB마다 보기·사용·관리 권한을 부여합니다.
          </small>
        </div>
        <span className="tw:shrink-0 tw:rounded-full tw:border tw:border-border tw:px-2 tw:py-1 tw:font-mono tw:text-2xs tw:text-muted-foreground">
          비밀번호 공유 없음
        </span>
      </header>

      <label className="tw:grid tw:gap-1">
        <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground tw:uppercase">
          공유 연결
        </span>
        <select
          className="tw:h-control-field tw:w-full tw:border tw:border-border tw:bg-surface-inset tw:px-3 tw:text-ui tw:text-foreground tw:outline-none tw:focus:border-primary"
          value={selectedId}
          disabled={loading || connections.length === 0}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {connections.length === 0 ? (
            <option value="">관리할 공유 연결이 없습니다</option>
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
            ? "역할과 DB 사용 권한은 관리자가 바꿀 때까지 유지되고, 단기 자격 증명만 앱이 자동 회전합니다."
            : "사용 권한이 있는 멤버는 자신의 기기에서 DB 자격 증명을 한 번 연결해야 합니다."}
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
            역할 기반 쓰기 허용
            <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
              {!selected.writeAvailable
                ? "이 공급자 연결에는 별도 쓰기 계정이 없습니다. 클라우드 계정을 다시 연결해 쓰기 계정을 구성하세요."
                : canManageWritePolicy
                  ? "사용·관리 권한이 있는 에디터, 관리자, 소유자에게 읽기·쓰기 역할을 지속 적용합니다. 운영 여부는 이 정책을 자동으로 끄지 않습니다."
                  : "현재 상태는 관리자가 정한 DB 정책입니다. 쓰기 허용 여부는 관리자 또는 소유자만 변경할 수 있습니다."}
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
                  {isActor ? " · 나" : ""}
                </strong>
                <small className="tw:overflow-hidden tw:text-xs tw:text-ellipsis tw:whitespace-nowrap tw:text-muted-foreground">
                  {grant.email} · {grant.role}
                </small>
              </div>
              <select
                className="tw:h-control-sm tw:w-full tw:border tw:border-border tw:bg-surface-inset tw:px-2 tw:text-xs tw:text-foreground tw:outline-none tw:focus:border-primary tw:disabled:cursor-not-allowed tw:disabled:opacity-[var(--ds-disabled-opacity)]"
                aria-label={`${grant.name} 연결 권한`}
                value={grant.capability ?? ""}
                disabled={mutatingId !== "" || isActor}
                onChange={(event) => void changeGrant(
                  grant.memberId,
                  event.target.value as ConnectionCapability | "",
                )}
              >
                <option value="">접근 없음</option>
                <option value="view">보기 · 연결 정보만</option>
                <option value="use">
                  {selected?.credentialMode === "managed"
                    ? "사용 · 역할 기반 자동 접근"
                    : "사용 · 로컬 자격 증명"}
                </option>
                <option value="manage">관리 · 권한과 설정 변경</option>
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
