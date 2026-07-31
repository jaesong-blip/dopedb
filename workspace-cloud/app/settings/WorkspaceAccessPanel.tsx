"use client";

// Workspace membership administration. Mutations are confirmed by the server and
// the rendered list is then reloaded from Better Auth's organization state.
import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  ControlButton,
  ControlInput,
  ControlSelect,
} from "../components/Controls";

type WorkspaceMember = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
};
type PendingInvitation = {
  id: string;
  email: string;
  role: string | null;
  inviteUrl: string;
  expiresAt: string;
};

const roleLabel: Record<string, string> = {
  analyst: "읽기 전용",
  editor: "읽기 / 쓰기",
  admin: "관리자",
  owner: "소유자",
  viewer: "보기 전용",
};

export function WorkspaceAccessPanel({ workspaceId }: { workspaceId: string }) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("analyst");
  const [pending, setPending] = useState(false);
  const [mutatingId, setMutatingId] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/v1/workspaces/${workspaceId}/members`, {
      cache: "no-store",
      signal,
    }).catch(() => null);
    if (signal?.aborted) return;
    if (!response?.ok) {
      const body = await response?.json().catch(() => null);
      setError(body?.error ?? "멤버와 초대 목록을 불러오지 못했습니다.");
      return;
    }
    const body = await response.json().catch(() => null);
    if (!body || !Array.isArray(body.members) || !Array.isArray(body.invitations)) {
      setError("멤버와 초대 목록 응답을 확인하지 못했습니다.");
      return;
    }
    setError("");
    setMembers(body.members);
    setInvitations(body.invitations);
  }, [workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (pending || mutatingId) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role }),
      }).catch(() => null);
      if (!response?.ok) {
        const body = await response?.json().catch(() => null);
        setError(body?.error ?? "초대를 만들지 못했습니다.");
        return;
      }
      setEmail("");
      await load();
    } finally {
      setPending(false);
    }
  }

  async function updateRole(memberId: string, nextRole: string) {
    if (mutatingId) return;
    setMutatingId(memberId);
    setError("");
    try {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId, role: nextRole }),
      }).catch(() => null);
      if (!response?.ok) {
        const body = await response?.json().catch(() => null);
        setError(body?.error ?? "권한을 변경하지 못했습니다.");
        return;
      }
      await load();
    } finally {
      setMutatingId("");
    }
  }

  async function remove(kind: "member" | "invitation", id: string) {
    if (mutatingId) return;
    setMutatingId(id);
    setError("");
    try {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/members`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "member" ? { memberId: id } : { invitationId: id }),
      }).catch(() => null);
      if (!response?.ok) {
        const body = await response?.json().catch(() => null);
        setError(body?.error ?? "요청을 처리하지 못했습니다.");
        return;
      }
      await load();
    } finally {
      setMutatingId("");
    }
  }

  async function resend(item: PendingInvitation) {
    if (mutatingId) return;
    setMutatingId(item.id);
    setError("");
    try {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: item.email, role: item.role ?? "analyst" }),
      }).catch(() => null);
      if (!response?.ok) {
        const body = await response?.json().catch(() => null);
        setError(body?.error ?? "초대를 다시 만들지 못했습니다.");
        return;
      }
      await load();
    } finally {
      setMutatingId("");
    }
  }

  async function copyInvitation(item: PendingInvitation) {
    setError("");
    try {
      await navigator.clipboard.writeText(item.inviteUrl);
      setCopiedId(item.id);
      window.setTimeout(
        () => setCopiedId((current) => current === item.id ? "" : current),
        1800,
      );
    } catch {
      setError("초대 링크를 클립보드에 복사하지 못했습니다.");
    }
  }

  return (
    <section className="tw:grid tw:gap-3 tw:p-5">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3">
        <strong className="tw:text-sm tw:text-foreground">
          워크스페이스 멤버
        </strong>
        <small className="tw:text-right tw:text-2xs tw:leading-body tw:text-muted-foreground">
          권한은 모든 API 요청에서 서버가 다시 확인합니다.
        </small>
      </header>
      <div className="tw:grid tw:border-t tw:border-border">
        {members.map((item) => (
          <div
            className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:py-2.5"
            key={item.id}
          >
            <div className="tw:grid tw:gap-1">
              <strong className="tw:text-sm tw:text-foreground">
                {item.name}
              </strong>
              <small className="tw:text-2xs tw:text-muted-foreground">
                {item.email}
              </small>
            </div>
            {item.role === "owner" ? (
              <span className="tw:text-xs tw:text-muted-foreground">
                {roleLabel.owner}
              </span>
            ) : (
              <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                <ControlSelect
                  value={item.role}
                  onChange={(event) =>
                    void updateRole(item.id, event.target.value)
                  }
                  disabled={mutatingId !== ""}
                >
                  <option value="viewer">보기 전용 (실행 불가)</option>
                  <option value="analyst">읽기 전용</option>
                  <option value="editor">읽기 / 쓰기</option>
                  <option value="admin">관리자</option>
                </ControlSelect>
                <ControlButton
                  tone="danger"
                  onClick={() => void remove("member", item.id)}
                  disabled={mutatingId !== ""}
                >
                  제거
                </ControlButton>
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="tw:grid tw:grid-cols-1 tw:gap-2 tw:md:grid-cols-[minmax(0,1fr)_auto_auto]"
        onSubmit={invite}
      >
        <ControlInput
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="member@company.com"
          required
        />
        <ControlSelect
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="viewer">보기 전용 (실행 불가)</option>
          <option value="analyst">읽기 전용</option>
          <option value="editor">읽기 / 쓰기</option>
          <option value="admin">관리자</option>
        </ControlSelect>
        <ControlButton
          type="submit"
          tone="primary"
          size="field"
          disabled={pending || mutatingId !== ""}
        >
          {pending ? "생성 중" : "초대 링크 만들기"}
        </ControlButton>
      </form>
      {invitations.length > 0 ? (
        <div className="tw:grid tw:border-t tw:border-border">
          {invitations.map((item) => (
            <div
              className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:py-2.5"
              key={item.id}
            >
              <div className="tw:grid tw:gap-1">
                <strong className="tw:text-sm tw:text-foreground">
                  {item.email}
                </strong>
                <small className="tw:text-2xs tw:text-muted-foreground">
                  {roleLabel[item.role ?? ""] ?? item.role} ·{" "}
                  {new Date(item.expiresAt).toLocaleDateString("ko-KR")} 만료
                </small>
              </div>
              <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                <ControlButton onClick={() => void copyInvitation(item)}>
                  {copiedId === item.id ? "복사됨" : "링크 복사"}
                </ControlButton>
                <ControlButton
                  onClick={() => void resend(item)}
                  disabled={mutatingId !== ""}
                >
                  다시 만들기
                </ControlButton>
                <ControlButton
                  tone="danger"
                  onClick={() => void remove("invitation", item.id)}
                  disabled={mutatingId !== ""}
                >
                  취소
                </ControlButton>
              </div>
            </div>
          ))}
          <p className="tw:mt-2 tw:mb-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
            초대 링크는 해당 이메일로 Google 로그인한 사용자만 수락할 수
            있습니다.
          </p>
        </div>
      ) : null}
      {error ? (
        <small className="tw:text-2xs tw:text-danger" role="alert">
          {error}
        </small>
      ) : null}
    </section>
  );
}
