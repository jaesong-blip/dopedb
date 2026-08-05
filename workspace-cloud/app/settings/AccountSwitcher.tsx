// Unified Better Auth account switcher for the web console. Account-session tokens
// remain closure data and are never rendered, logged, or persisted by this component.
"use client";

import { useEffect, useRef, useState } from "react";
import { authClient } from "../../lib/auth-client";
import { sessionsExceptCurrent } from "../../lib/device-session-policy";
import { useDeviceAccounts } from "../../lib/useDeviceAccounts";
import { localizedWorkspacePath } from "../../lib/workspace-locale";
import { workspaceMessages } from "../../lib/workspace-messages";
import { localizedProviderMessage } from "../../lib/workspace-provider-copy";
import { useWorkspaceLocale } from "../components/WorkspaceLocale";

export function AccountSwitcher({
  currentUser,
  currentSessionId,
}: {
  currentUser: { id: string; name: string; email: string };
  currentSessionId: string;
}) {
  const locale = useWorkspaceLocale();
  const copy = workspaceMessages[locale].accountSwitcher;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { accounts, sessions, error, setError } = useDeviceAccounts();
  const currentUserId = currentUser.id;
  const current = accounts.find((account) => account.user.id === currentUserId);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function activate(sessionToken: string, userId: string) {
    if (userId === currentUserId || pending) return;
    setPending(userId);
    setError("");
    const result = await authClient.multiSession.setActive({ sessionToken });
    if (result.error) {
      setPending(null);
      setError(result.error.message
        ? localizedProviderMessage(result.error.message, locale, copy.switchError)
        : copy.switchError);
      return;
    }
    location.assign(localizedWorkspacePath("/settings", locale));
  }

  async function revokeAccount(userId: string) {
    if (pending) return;
    setPending(userId);
    setError("");
    const target = accounts.find((account) => account.user.id === userId);
    if (!target) {
      setPending(null);
      return;
    }
    if (userId === currentUserId) {
      const fallback = accounts.find((account) => account.user.id !== userId);
      if (fallback) {
        const switched = await authClient.multiSession.setActive({
          sessionToken: fallback.sessions[0].session.token,
        });
        if (switched.error) {
          setPending(null);
          setError(switched.error.message
            ? localizedProviderMessage(
                switched.error.message,
                locale,
                copy.fallbackSwitchError,
              )
            : copy.fallbackSwitchError);
          return;
        }
      }
    }
    for (const item of target.sessions) {
      const result = await authClient.multiSession.revoke({
        sessionToken: item.session.token,
      });
      if (result.error) {
        setPending(null);
        setError(result.error.message
          ? localizedProviderMessage(result.error.message, locale, copy.revokeError)
          : copy.revokeError);
        return;
      }
    }
    location.assign(localizedWorkspacePath(
      accounts.length > 1 ? "/settings" : "/auth/sign-in",
      locale,
    ));
  }

  async function revokeAll() {
    if (pending) return;
    setPending("all");
    setError("");
    const revokeTargets = sessionsExceptCurrent(sessions, currentSessionId);
    for (const item of revokeTargets) {
      const result = await authClient.multiSession.revoke({
        sessionToken: item.session.token,
      });
      if (result.error) {
        setPending(null);
        setError(result.error.message
          ? localizedProviderMessage(
              result.error.message,
              locale,
              copy.revokeAllError,
            )
          : copy.revokeAllError);
        return;
      }
    }
    const result = await authClient.signOut();
    if (result.error) {
      setPending(null);
      setError(result.error.message
        ? localizedProviderMessage(result.error.message, locale, copy.signOutError)
        : copy.signOutError);
      return;
    }
    location.assign(localizedWorkspacePath("/auth/sign-in", locale));
  }

  return (
    <div
      className="tw:relative tw:w-[min(245px,48vw)]"
      ref={rootRef}
    >
      <button
        className="tw:grid tw:min-h-control-md tw:w-full tw:cursor-pointer tw:grid-cols-[var(--ds-control-sm)_minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:rounded-control tw:border tw:border-chrome-border tw:bg-chrome-foreground/5 tw:px-1.5 tw:py-1 tw:text-left tw:text-chrome-foreground tw:transition-colors tw:hover:bg-chrome-foreground/10 tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-signal"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="tw:grid tw:size-control-sm tw:place-items-center tw:rounded-control tw:bg-signal tw:text-xs tw:font-semibold tw:text-chrome">
          {(current?.user.name ?? currentUser.name).slice(0, 1).toUpperCase()}
        </span>
        <strong className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-2xs tw:font-medium tw:text-chrome-muted">
          {current?.user.email ?? currentUser.email}
        </strong>
        <i className="tw:text-chrome-muted tw:not-italic" aria-hidden="true">
          ↓
        </i>
      </button>
      {open ? (
        <div
          className="tw:absolute tw:top-[calc(100%+var(--ds-space-3))] tw:right-0 tw:z-[var(--ds-z-popover)] tw:max-h-[min(var(--ds-popover-height),calc(100vh-80px))] tw:w-[min(var(--ds-popover-width),calc(100vw-40px))] tw:overflow-auto tw:rounded-surface tw:border tw:border-border tw:bg-surface tw:p-1.5 tw:text-foreground tw:shadow-popover"
          role="menu"
        >
          {accounts.map((account) => (
            <div
              className="tw:grid tw:grid-cols-[minmax(0,1fr)_var(--ds-control-sm)]"
              key={account.user.id}
            >
              <button
                className="tw:grid tw:min-h-control-md tw:min-w-0 tw:cursor-pointer tw:grid-cols-[var(--ds-control-sm)_minmax(0,1fr)_var(--ds-icon-xs)] tw:items-center tw:gap-2 tw:border-0 tw:bg-transparent tw:px-2 tw:py-1 tw:text-left tw:text-foreground tw:hover:bg-surface-raised tw:disabled:cursor-wait tw:disabled:opacity-[var(--ds-disabled-opacity)]"
                type="button"
                role="menuitemradio"
                aria-checked={account.user.id === currentUserId}
                onClick={() => void activate(account.sessions[0].session.token, account.user.id)}
                disabled={pending !== null}
              >
                <span className="tw:grid tw:size-control-sm tw:place-items-center tw:rounded-control tw:bg-selection tw:text-xs tw:font-semibold tw:text-primary">
                  {account.user.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="tw:grid tw:min-w-0 tw:gap-0.5">
                  <strong className="tw:overflow-hidden tw:text-sm tw:text-ellipsis tw:whitespace-nowrap">
                    {account.user.name}
                  </strong>
                  <small className="tw:overflow-hidden tw:text-2xs tw:text-ellipsis tw:whitespace-nowrap tw:text-muted-foreground">
                    {account.user.email}
                  </small>
                </div>
                <i className="tw:text-primary tw:not-italic">
                  {account.user.id === currentUserId ? "✓" : ""}
                </i>
              </button>
              <button
                className="tw:min-h-control-md tw:w-control-sm tw:cursor-pointer tw:border-0 tw:bg-transparent tw:p-0 tw:text-muted-foreground tw:hover:bg-surface-raised tw:hover:text-foreground tw:disabled:cursor-wait tw:disabled:opacity-[var(--ds-disabled-opacity)]"
                type="button"
                role="menuitem"
                onClick={() => void revokeAccount(account.user.id)}
                disabled={pending !== null}
                aria-label={`${account.user.email} ${copy.signOutLabel}`}
              >
                ×
              </button>
            </div>
          ))}
          <a
            className="tw:flex tw:min-h-control-md tw:w-full tw:items-center tw:border-t tw:border-border tw:px-2 tw:text-xs tw:text-foreground tw:hover:bg-surface-raised"
            role="menuitem"
            href={localizedWorkspacePath("/settings?section=account", locale)}
          >
            {copy.manage}
          </a>
          <a
            className="tw:flex tw:min-h-control-md tw:w-full tw:items-center tw:px-2 tw:text-xs tw:text-muted-foreground tw:hover:bg-surface-raised tw:hover:text-foreground"
            role="menuitem"
            href={localizedWorkspacePath(
              `/auth/sign-in?returnTo=${encodeURIComponent(localizedWorkspacePath("/settings", locale))}`,
              locale,
            )}
          >
            {copy.add}
          </a>
          {accounts.length > 1 ? (
            <button
              className="tw:flex tw:min-h-control-md tw:w-full tw:cursor-pointer tw:items-center tw:border-0 tw:bg-transparent tw:px-2 tw:text-left tw:text-xs tw:text-danger tw:hover:bg-surface-raised tw:disabled:cursor-wait tw:disabled:opacity-[var(--ds-disabled-opacity)]"
              role="menuitem"
              type="button"
              onClick={() => void revokeAll()}
              disabled={pending !== null}
            >
              {copy.signOutAll}
            </button>
          ) : null}
          {error ? (
            <p
              className="tw:m-2 tw:text-2xs tw:leading-body tw:text-danger"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
