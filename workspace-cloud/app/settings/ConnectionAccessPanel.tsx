"use client";

// Connection grants are intentionally separate from workspace roles: membership
// makes a template visible only when a manager grants view, use, or manage.
import { useCallback, useEffect, useState } from "react";

type ConnectionCapability = "view" | "use" | "manage";
type SharedConnection = {
  id: string;
  name: string;
  engine: string;
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
            ? "사용 권한이 있는 멤버는 사용자별 15분 자격 증명을 자동 발급받습니다."
            : "사용 권한이 있는 멤버는 자신의 기기에서 DB 자격 증명을 한 번 연결해야 합니다."}
        </p>
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
                    ? "사용 · 15분 자동 접근"
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
