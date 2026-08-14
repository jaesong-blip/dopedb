// Current-account session inventory with explicit remote revocation. Session tokens
// are endpoint inputs only and never become DOM content.
"use client";

import { useCallback, useEffect, useState } from "react";
import { ControlButton } from "../components/Controls";
import { authClient } from "../../lib/auth-client";
import { localizedWorkspacePath } from "../../lib/workspace-locale";
import { workspaceMessages } from "../../lib/workspace-messages";
import { localizedProviderMessage } from "../../lib/workspace-provider-copy";
import { useWorkspaceLocale } from "../components/WorkspaceLocale";

interface SessionItem {
  id: string;
  token: string;
  updatedAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export function ActiveSessions({ currentSessionId }: { currentSessionId: string }) {
  const locale = useWorkspaceLocale();
  const copy = workspaceMessages[locale].account;
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [needsReauthentication, setNeedsReauthentication] = useState(false);

  const refresh = useCallback(async () => {
    const result = await authClient.listSessions();
    if (result.error) {
      const sessionNotFresh =
        result.error.code === "SESSION_NOT_FRESH"
        || result.error.message === "Session is not fresh";
      setNeedsReauthentication(sessionNotFresh);
      setError(sessionNotFresh
        ? copy.reauthRequired
        : result.error.message
          ? localizedProviderMessage(result.error.message, locale, copy.loadError)
          : copy.loadError);
      return;
    }
    setNeedsReauthentication(false);
    setError("");
    setSessions(result.data ?? []);
  }, [copy, locale]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function revoke(item: SessionItem) {
    if (pending) return;
    setPending(item.id);
    setError("");
    const result = await authClient.revokeSession({ token: item.token });
    if (result.error) {
      setError(result.error.message
        ? localizedProviderMessage(result.error.message, locale, copy.revokeError)
        : copy.revokeError);
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
      setError(result.error.message
        ? localizedProviderMessage(result.error.message, locale, copy.signOutError)
        : copy.signOutError);
      return;
    }
    location.assign(localizedWorkspacePath(
      `/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
      locale,
    ));
  }

  return (
    <div className="tw:grid tw:border-t tw:border-border">
      {sessions.map((item) => {
        const current = item.id === currentSessionId;
        return (
          <div
            className="tw:grid tw:grid-cols-[38px_minmax(0,1fr)_auto] tw:items-center tw:border-b tw:border-border tw:px-1 tw:py-4"
            key={item.id}
          >
            <span className="tw:text-primary">
              {item.userAgent?.includes("Mozilla") ? "◎" : "▣"}
            </span>
            <div className="tw:flex tw:flex-col tw:gap-1">
              <strong className="tw:text-ui tw:text-foreground">
                {item.userAgent?.includes("Mozilla")
                  ? copy.browser
                  : copy.desktop}
              </strong>
              <small className="tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground">
                {item.ipAddress ?? copy.protectedSession}
              </small>
            </div>
            {current ? (
              <time className="tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground">
                {copy.currentSession}
              </time>
            ) : (
              <ControlButton
                onClick={() => void revoke(item)}
                disabled={pending === item.id}
              >
                {pending === item.id ? copy.revoking : copy.revoke}
              </ControlButton>
            )}
          </div>
        );
      })}
      {sessions.length === 0 && !error ? (
        <p className="tw:m-0 tw:px-1 tw:py-5 tw:text-xs tw:text-muted-foreground">
          {copy.checking}
        </p>
      ) : null}
      {error ? (
        <div className="tw:flex tw:min-h-control-field tw:items-center tw:justify-between tw:gap-3 tw:px-1 tw:py-4" role="alert">
          <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-danger">{error}</p>
          {needsReauthentication ? (
            <ControlButton
              onClick={() => void reauthenticate()}
              disabled={pending !== null}
            >
              {pending === "reauthenticate" ? copy.signingOut : copy.reauthenticate}
            </ControlButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
