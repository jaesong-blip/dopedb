// Current-account session inventory with explicit remote revocation. Session tokens
// are endpoint inputs only and never become DOM content.
"use client";

import { useEffect, useState } from "react";
import { authClient } from "../../lib/auth-client";

interface SessionItem {
  id: string;
  token: string;
  updatedAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export function ActiveSessions({ currentSessionId }: { currentSessionId: string }) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [needsReauthentication, setNeedsReauthentication] = useState(false);

  async function refresh() {
    const result = await authClient.listSessions();
    if (result.error) {
      const sessionNotFresh =
        result.error.code === "SESSION_NOT_FRESH"
        || result.error.message === "Session is not fresh";
      setNeedsReauthentication(sessionNotFresh);
      setError(sessionNotFresh
        ? "보안을 위해 활성 세션 목록은 다시 로그인한 뒤 확인할 수 있습니다. 워크스페이스와 연결 설정 저장에는 영향이 없습니다."
        : result.error.message ?? "세션을 불러오지 못했습니다.");
      return;
    }
    setNeedsReauthentication(false);
    setError("");
    setSessions(result.data ?? []);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function revoke(item: SessionItem) {
    if (pending) return;
    setPending(item.id);
    setError("");
    const result = await authClient.revokeSession({ token: item.token });
    if (result.error) {
      setError(result.error.message ?? "세션을 종료하지 못했습니다.");
      setPending(null);
      return;
    }
    await refresh();
    setPending(null);
  }

  async function reauthenticate() {
    if (pending) return;
    setPending("reauthenticate");
    setError("");
    const returnTo = `${location.pathname}${location.search}`;
    const result = await authClient.signOut();
    if (result.error) {
      setPending(null);
      setError(result.error.message ?? "로그아웃하지 못했습니다.");
      return;
    }
    location.assign(`/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return (
    <div className="device-table">
      {sessions.map((item) => {
        const current = item.id === currentSessionId;
        return (
          <div className="device-row" key={item.id}>
            <span className="device-icon">{item.userAgent?.includes("Mozilla") ? "◎" : "▣"}</span>
            <div>
              <strong>{item.userAgent?.includes("Mozilla") ? "Web browser" : "DopeDB desktop"}</strong>
              <small>{item.ipAddress ?? "protected session"}</small>
            </div>
            {current ? (
              <time>현재 세션</time>
            ) : (
              <button type="button" onClick={() => void revoke(item)} disabled={pending === item.id}>
                {pending === item.id ? "종료 중…" : "세션 종료"}
              </button>
            )}
          </div>
        );
      })}
      {sessions.length === 0 && !error ? <p className="device-empty">활성 세션을 확인하고 있습니다…</p> : null}
      {error ? (
        <div className="tw:flex tw:min-h-control-field tw:items-center tw:justify-between tw:gap-3 tw:px-1 tw:py-4" role="alert">
          <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-danger">{error}</p>
          {needsReauthentication ? (
            <button
              className="tw:h-control-sm tw:flex-none tw:border tw:border-primary tw:bg-transparent tw:px-3 tw:text-2xs tw:font-bold tw:text-foreground tw:hover:bg-surface-raised tw:disabled:cursor-wait tw:disabled:opacity-[var(--ds-disabled-opacity)]"
              type="button"
              onClick={() => void reauthenticate()}
              disabled={pending !== null}
            >
              {pending === "reauthenticate" ? "로그아웃 중…" : "로그아웃 후 다시 로그인"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
