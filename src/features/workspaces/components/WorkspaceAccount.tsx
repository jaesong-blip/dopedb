// Account-specific Better Auth device login lifecycle and unified local account menu.
// Session tokens stay behind Rust IPC; this component caches public identity only.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ProviderCredentialDialog } from "../../providers/ProviderCredentialDialog";
import { ProviderCredentialsMenuItem } from "../../providers/ProviderCredentialsMenuItem";
import {
  beginWorkspaceLogin,
  pollWorkspaceLogin,
  refreshWorkspaceAuthState,
  refreshWorkspaceMemberships,
  setActiveWorkspaceAccount,
  signOutAllWorkspaces,
  signOutWorkspace,
} from "../tauriAdapter";
import {
  invalidateWorkspaceContext,
  invalidateWorkspaceState,
  replaceWorkspaceAuth,
  resetWorkspaceScope,
} from "../cache";
import type { AccountId, WorkspaceLoginPoll } from "../domain";
import { workspaceAuthStateQuery } from "../queries";
import { shouldRevalidateWorkspaceAuth } from "../authPolicy";
import { errMessage } from "../../../ipc/types";
import { useI18n } from "../../../lib/i18n";
import { Icon } from "../../../components/Icon";
import { useToast } from "../../../components/Toast";
import "./WorkspaceAccount.css";

export default function WorkspaceAccount({
  onScopeChanged,
  compact = false,
}: {
  onScopeChanged: () => void | Promise<void>;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const auth = useQuery(workspaceAuthStateQuery());
  const [loginPhase, setLoginPhase] = useState<"idle" | "starting" | "waiting">("idle");
  const [loggingOut, setLoggingOut] = useState<AccountId | "all" | null>(null);
  const [switchingAccount, setSwitchingAccount] = useState<AccountId | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [providerCredentialsOpen, setProviderCredentialsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const loginAttempt = useRef(0);
  const pendingLogin = useRef<{ attempt: number; deviceCode: string } | null>(null);
  const pollInFlight = useRef<{
    deviceCode: string;
    request: Promise<WorkspaceLoginPoll>;
  } | null>(null);
  const membershipRefreshInFlight = useRef<Promise<void> | null>(null);
  const browserWasActive = useRef(false);
  const providerCredentialAuthorityVersion = useRef<number | null>(null);
  const focusReturnHandler = useRef<() => void>(() => undefined);
  const membershipRefreshHandler = useRef<() => void>(() => undefined);

  useEffect(() => {
    const onBlur = () => {
      if (pendingLogin.current) browserWasActive.current = true;
    };
    const onFocus = () => {
      if (!pendingLogin.current) {
        membershipRefreshHandler.current();
        return;
      }
      if (!browserWasActive.current) return;
      browserWasActive.current = false;
      focusReturnHandler.current();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      loginAttempt.current += 1;
      pendingLogin.current = null;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!auth.data?.authenticated) return;
    void invalidateWorkspaceContext(queryClient);
  }, [auth.data?.authenticated, queryClient]);

  useEffect(() => {
    if (providerCredentialAuthorityVersion.current !== null
      && providerCredentialAuthorityVersion.current !== auth.dataUpdatedAt) {
      setProviderCredentialsOpen(false);
    }
    providerCredentialAuthorityVersion.current = auth.dataUpdatedAt;
  }, [auth.dataUpdatedAt]);

  useEffect(() => {
    let active = true;
    const request = refreshWorkspaceAuthState()
      .then(async (state) => {
        if (!active) return;
        replaceWorkspaceAuth(queryClient, state);
        await invalidateWorkspaceContext(queryClient);
      })
      .catch(() => undefined)
      .finally(() => {
        if (membershipRefreshInFlight.current === request) {
          membershipRefreshInFlight.current = null;
        }
      });
    membershipRefreshInFlight.current = request;
    return () => {
      active = false;
    };
  }, [queryClient]);

  async function wait(ms: number) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  }

  async function pollOnce(deviceCode: string) {
    if (pollInFlight.current?.deviceCode === deviceCode) {
      return pollInFlight.current.request;
    }
    const request = pollWorkspaceLogin(deviceCode).finally(() => {
      if (pollInFlight.current?.request === request) pollInFlight.current = null;
    });
    pollInFlight.current = { deviceCode, request };
    return request;
  }

  function abortLoginAttempt() {
    loginAttempt.current += 1;
    pendingLogin.current = null;
    browserWasActive.current = false;
    setLoginPhase("idle");
  }

  function cancelLogin() {
    if (!pendingLogin.current) return;
    abortLoginAttempt();
    toast(t("workspace.loginCanceled"));
  }

  async function handlePollResult(result: WorkspaceLoginPoll, attempt: number) {
    if (pendingLogin.current?.attempt !== attempt) return true;
    if (result.status === "signedIn" && result.user) {
      pendingLogin.current = null;
      setLoginPhase("idle");
      await auth.refetch();
      await resetWorkspaceScope(queryClient);
      await onScopeChanged();
      toast(t("workspace.loginComplete", { name: result.user.displayName }), "success");
      return true;
    }
    if (result.status === "denied" || result.status === "expired") {
      pendingLogin.current = null;
      setLoginPhase("idle");
      toast(
        t(result.status === "denied" ? "workspace.loginDenied" : "workspace.loginExpired"),
        "error",
      );
      return true;
    }
    return false;
  }

  async function checkAfterBrowserReturn() {
    const pending = pendingLogin.current;
    if (!pending) return;
    try {
      // Give the approval request a brief moment to commit before treating a returned
      // focus with a still-pending code as a closed/cancelled browser flow.
      await wait(350);
      let result = await pollOnce(pending.deviceCode);
      if (result.status === "slowDown") {
        await wait(5_250);
        if (pendingLogin.current?.attempt !== pending.attempt) return;
        result = await pollOnce(pending.deviceCode);
      }
      if (await handlePollResult(result, pending.attempt)) return;
      cancelLogin();
    } catch {
      // Returning from the browser is an explicit local cancellation boundary even
      // when the network cannot confirm the still-pending server code.
      cancelLogin();
    }
  }

  focusReturnHandler.current = () => void checkAfterBrowserReturn();
  membershipRefreshHandler.current = () => {
    if (!auth.data?.authenticated || membershipRefreshInFlight.current) return;
    const revalidateAuth = shouldRevalidateWorkspaceAuth(
      true,
      auth.dataUpdatedAt,
      auth.isFetching,
    );
    const request = (revalidateAuth
      ? refreshWorkspaceAuthState().then((state) => {
          replaceWorkspaceAuth(queryClient, state);
        })
      : refreshWorkspaceMemberships()
          .then(() => auth.refetch())
          .then(() => undefined)
    )
      .then(() => invalidateWorkspaceContext(queryClient))
      .catch(async () => {
        // A membership 401 also invalidates the hosted session. Confirm that state
        // silently so expired team scopes disappear without turning the button into
        // a foreground loading indicator.
        await auth.refetch().catch(() => undefined);
        await invalidateWorkspaceContext(queryClient);
      })
      .finally(() => {
        if (membershipRefreshInFlight.current === request) {
          membershipRefreshInFlight.current = null;
        }
      });
    membershipRefreshInFlight.current = request;
  };

  async function login() {
    if (loginPhase !== "idle") return;
    const attempt = ++loginAttempt.current;
    setLoginPhase("starting");
    try {
      const authorization = await beginWorkspaceLogin();
      pendingLogin.current = { attempt, deviceCode: authorization.deviceCode };
      browserWasActive.current = false;
      await openUrl(authorization.verificationUriComplete);
      if (loginAttempt.current !== attempt) return;
      setLoginPhase("waiting");
      const expiresAt = Date.now() + authorization.expiresIn * 1000;
      let pollInterval = Math.max(authorization.interval, 1) * 1000;

      while (Date.now() < expiresAt) {
        await wait(pollInterval);
        if (loginAttempt.current !== attempt) return;
        const result = await pollOnce(authorization.deviceCode);
        if (result.status === "pending") continue;
        if (result.status === "slowDown") {
          pollInterval += 5_000;
          continue;
        }
        if (await handlePollResult(result, attempt)) return;
      }
      pendingLogin.current = null;
      toast(t("workspace.loginExpired"), "error");
    } catch (error) {
      pendingLogin.current = null;
      toast(t("workspace.loginFailed", { error: errMessage(error) }), "error");
    } finally {
      if (loginAttempt.current === attempt) setLoginPhase("idle");
    }
  }

  async function logout(userId: AccountId) {
    if (loggingOut) return;
    abortLoginAttempt();
    setProviderCredentialsOpen(false);
    setLoggingOut(userId);
    try {
      const signedOut = await signOutWorkspace(userId);
      replaceWorkspaceAuth(queryClient, signedOut);
      await resetWorkspaceScope(queryClient);
      await onScopeChanged();
      setMenuOpen(false);
      toast(t("workspace.logoutComplete"), "success");
    } catch (error) {
      // The native command may already have removed the credential before a local
      // workspace-index error. Re-read identity so the UI never displays a stale user.
      await auth.refetch().catch(() => undefined);
      await invalidateWorkspaceContext(queryClient);
      toast(t("workspace.logoutFailed", { error: errMessage(error) }), "error");
    } finally {
      setLoggingOut(null);
    }
  }

  async function logoutAll() {
    if (loggingOut) return;
    abortLoginAttempt();
    setProviderCredentialsOpen(false);
    setLoggingOut("all");
    try {
      const signedOut = await signOutAllWorkspaces();
      replaceWorkspaceAuth(queryClient, signedOut);
      await resetWorkspaceScope(queryClient);
      await onScopeChanged();
      setMenuOpen(false);
      toast(t("workspace.logoutAllComplete"), "success");
    } catch (error) {
      await auth.refetch().catch(() => undefined);
      toast(t("workspace.logoutFailed", { error: errMessage(error) }), "error");
    } finally {
      setLoggingOut(null);
    }
  }

  async function switchAccount(userId: AccountId) {
    if (switchingAccount || auth.data?.user?.id === userId) {
      setMenuOpen(false);
      return;
    }
    abortLoginAttempt();
    setProviderCredentialsOpen(false);
    setSwitchingAccount(userId);
    try {
      await setActiveWorkspaceAccount(userId);
      await resetWorkspaceScope(queryClient);
      await auth.refetch();
      await onScopeChanged();
      setMenuOpen(false);
    } catch (error) {
      await auth.refetch();
      await invalidateWorkspaceState(queryClient);
      toast(t("workspace.accountSwitchFailed", { error: errMessage(error) }), "error");
    } finally {
      setSwitchingAccount(null);
    }
  }

  const authKnown = auth.data !== undefined;
  const loginLabel = !authKnown
    ? t("workspace.loginChecking")
    : loginPhase === "starting"
      ? t("workspace.loginStarting")
      : loginPhase === "waiting"
        ? t("workspace.loginCancel")
        : t("workspace.login");

  const user = auth.data?.authenticated ? auth.data.user : null;

  return (
    <div
      className={`workspace-account${compact ? " compact" : ""}`}
      aria-live="polite"
      ref={rootRef}
    >
      {!authKnown ? (
        <div className="workspace-account-skeleton" aria-label={loginLabel} />
      ) : user ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            data-rail-control={compact ? "" : undefined}
            className="workspace-account-identity"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={
              compact ? `${user.displayName || user.email} · ${user.email}` : undefined
            }
            title={`${user.displayName} · ${user.email}`}
          >
            <span className="workspace-account-avatar" aria-hidden="true">
              {(user.displayName || user.email).slice(0, 1).toUpperCase()}
            </span>
            <span className="workspace-account-copy">
              <strong>{user.displayName}</strong>
              <small>{user.email}</small>
            </span>
            <Icon name="chevronDown" />
          </button>
          <button
            type="button"
            className="workspace-account-action"
            onClick={() => void logout(user.id)}
            disabled={loggingOut !== null}
            title={t(loggingOut === user.id ? "workspace.logoutPending" : "workspace.logout")}
            aria-label={t(loggingOut === user.id ? "workspace.logoutPending" : "workspace.logout")}
            aria-busy={loggingOut === user.id}
          >
            <Icon name="logOut" />
          </button>
          {menuOpen ? (
            <div className="workspace-account-menu" role="menu" aria-label={t("workspace.accountMenu")}>
              <p>{t("workspace.accounts")}</p>
              {auth.data?.accounts.map((account) => {
                const active = account.user.id === user.id;
                return (
                  <div className="workspace-account-menu-row" key={account.user.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className="workspace-account-menu-switch"
                      onClick={() => void switchAccount(account.user.id)}
                      disabled={switchingAccount !== null || loggingOut !== null}
                    >
                      <span className="workspace-account-menu-avatar" aria-hidden="true">
                        {(account.user.displayName || account.user.email).slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{account.user.displayName}</strong>
                        <small>{account.user.email}</small>
                      </span>
                      {active ? <Icon name="check" /> : null}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="workspace-account-menu-logout"
                      onClick={() => void logout(account.user.id)}
                      disabled={loggingOut !== null}
                      aria-label={t("workspace.logoutAccount", { email: account.user.email })}
                      title={t("workspace.logoutAccount", { email: account.user.email })}
                    >
                      <Icon name="logOut" />
                    </button>
                  </div>
                );
              })}
              <ProviderCredentialsMenuItem
                onOpen={() => {
                  setMenuOpen(false);
                  setProviderCredentialsOpen(true);
                }}
              />
              <button
                type="button"
                role="menuitem"
                className="workspace-account-menu-command"
                onClick={() => {
                  setMenuOpen(false);
                  if (loginPhase === "waiting") cancelLogin();
                  else void login();
                }}
                disabled={loginPhase === "starting"}
              >
                <Icon name="plus" />
                {loginPhase === "waiting" ? t("workspace.loginCancel") : t("workspace.addAccount")}
              </button>
              {auth.data && auth.data.accounts.length > 1 ? (
                <button
                  type="button"
                  role="menuitem"
                  className="workspace-account-menu-command danger"
                  onClick={() => void logoutAll()}
                  disabled={loggingOut !== null}
                >
                  <Icon name="logOut" />
                  {t("workspace.logoutAll")}
                </button>
              ) : null}
            </div>
          ) : null}
          {providerCredentialsOpen ? (
            <ProviderCredentialDialog
              key={user.id}
              onClose={() => setProviderCredentialsOpen(false)}
              returnFocus={() => triggerRef.current?.focus()}
            />
          ) : null}
        </>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          data-rail-control={compact ? "" : undefined}
          className="workspace-account-login"
          onClick={() => (loginPhase === "waiting" ? cancelLogin() : void login())}
          disabled={loginPhase === "starting"}
          title={loginPhase === "waiting" ? t("workspace.loginPending") : loginLabel}
          aria-label={loginLabel}
        >
          {compact ? <Icon name="user" /> : loginLabel}
        </button>
      )}
    </div>
  );
}
