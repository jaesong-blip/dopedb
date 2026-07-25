// Workspace-scoped Terminal tab strip. Session close and panel close are deliberately
// separate actions so hiding the dock never leaves an unmanageable PTY behind.
import type { RefObject } from "react";
import type {
  TerminalProfile,
  TerminalSessionSummary,
} from "../../ipc/types";
import { Icon } from "../Icon";
import { useI18n } from "../../lib/i18n";

interface TerminalTabsProps {
  sessions: TerminalSessionSummary[];
  activeId: string | null;
  creatingProfile: TerminalProfile | null;
  closingId: string | null;
  profileMenuOpen: boolean;
  maximized: boolean;
  archiveButtonRef: RefObject<HTMLButtonElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onActivate: (id: string) => void;
  onClose: (session: TerminalSessionSummary) => void;
  onToggleProfileMenu: () => void;
  onCreate: (profile: TerminalProfile) => void;
  onOpenArchive: () => void;
  onToggleMaximize: () => void;
  onPanelClose: () => void;
}

interface TerminalProfileOption {
  id: TerminalProfile;
  label: string;
  hint: string;
}

export function terminalProfileIcon(profile: TerminalProfile) {
  return profile === "shell" ? "terminal" : "user";
}

export default function TerminalTabs({
  sessions,
  activeId,
  creatingProfile,
  closingId,
  profileMenuOpen,
  maximized,
  archiveButtonRef,
  closeButtonRef,
  onActivate,
  onClose,
  onToggleProfileMenu,
  onCreate,
  onOpenArchive,
  onToggleMaximize,
  onPanelClose,
}: TerminalTabsProps) {
  const { t } = useI18n();
  const profiles: TerminalProfileOption[] = [
    {
      id: "shell",
      label: t("terminal.shell"),
      hint: t("terminal.shellHint"),
    },
    {
      id: "codex",
      label: t("terminal.codex"),
      hint: t("terminal.codexHint"),
    },
    {
      id: "claude",
      label: t("terminal.claude"),
      hint: t("terminal.claudeHint"),
    },
  ];
  function activateTab(index: number) {
    const session = sessions[index];
    if (!session) return;
    onActivate(session.id);
    window.requestAnimationFrame(() =>
      document.getElementById(`terminal-tab-${session.id}`)?.focus(),
    );
  }

  return (
    <header className="terminal-tabs-row">
      <div
        className="terminal-session-tabs ds-control-row"
        role="tablist"
        aria-label={t("terminal.sessions")}
      >
        {sessions.length === 0 && (
          <div className="terminal-tabs-empty-label">
            <Icon name="terminal" />
            <strong>{t("terminal.title")}</strong>
          </div>
        )}
        {sessions.map((session, index) => (
          <div
            key={session.id}
            className={`terminal-session-tab${
              session.id === activeId ? " active" : ""
            }`}
            aria-busy={closingId === session.id}
          >
            <button
              id={`terminal-tab-${session.id}`}
              type="button"
              className="terminal-session-select"
              role="tab"
              aria-selected={session.id === activeId}
              aria-controls={
                session.id === activeId
                  ? `terminal-panel-${session.id}`
                  : undefined
              }
              tabIndex={session.id === activeId ? 0 : -1}
              onClick={() => onActivate(session.id)}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                onClose(session);
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  activateTab(
                    (index - 1 + sessions.length) % sessions.length,
                  );
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  activateTab((index + 1) % sessions.length);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  activateTab(0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  activateTab(sessions.length - 1);
                }
              }}
              title={`${session.name} · ${session.connection.connectionName}`}
            >
              <span
                className={`terminal-status-dot ${session.lifecycle}`}
                aria-hidden="true"
              />
              <span>{session.name}</span>
            </button>
            <button
              type="button"
              className="terminal-session-close"
              disabled={closingId === session.id}
              onClick={() => onClose(session)}
              title={t("terminal.closeSession")}
              aria-label={`${t("terminal.closeSession")}: ${session.name}`}
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
      <div className="terminal-window-actions ds-control-row">
        <div className="terminal-profile-menu-wrap">
          <button
            type="button"
            className="btn small icon-only"
            onClick={onToggleProfileMenu}
            title={t("terminal.newSession")}
            aria-label={t("terminal.newSession")}
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen}
          >
            <Icon name="plus" />
          </button>
          {profileMenuOpen && (
            <div className="terminal-profile-menu" role="menu">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  role="menuitem"
                  disabled={creatingProfile !== null}
                  onClick={() => onCreate(profile.id)}
                >
                  <Icon name={terminalProfileIcon(profile.id)} />
                  <span>
                    <strong>{profile.label}</strong>
                    <small>{profile.hint}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          ref={archiveButtonRef}
          type="button"
          className="btn small icon-only terminal-secondary-action"
          onClick={onOpenArchive}
          title={t("terminal.openArchive")}
          aria-label={t("terminal.openArchive")}
        >
          <Icon name="history" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          onClick={onToggleMaximize}
          title={maximized ? t("terminal.restore") : t("terminal.maximize")}
          aria-label={
            maximized ? t("terminal.restore") : t("terminal.maximize")
          }
          aria-pressed={maximized}
        >
          <Icon name={maximized ? "minimize" : "maximize"} />
        </button>
        <button
          ref={closeButtonRef}
          type="button"
          className="btn small icon-only"
          onClick={onPanelClose}
          title={t("terminal.closePanel")}
          aria-label={t("terminal.closePanel")}
        >
          <Icon name="close" />
        </button>
      </div>
    </header>
  );
}

export function TerminalEmptyActions({
  creatingProfile,
  onCreate,
}: {
  creatingProfile: TerminalProfile | null;
  onCreate: (profile: TerminalProfile) => void;
}) {
  const { t } = useI18n();
  const profiles: Array<{ id: TerminalProfile; label: string }> = [
    { id: "shell", label: t("terminal.shell") },
    { id: "codex", label: t("terminal.codex") },
    { id: "claude", label: t("terminal.claude") },
  ];

  return (
    <div className="terminal-empty-actions ds-control-row">
      {profiles.map((profile) => (
        <button
          key={profile.id}
          type="button"
          className="btn"
          disabled={creatingProfile !== null}
          onClick={() => onCreate(profile.id)}
        >
          <Icon name={terminalProfileIcon(profile.id)} />
          {creatingProfile === profile.id
            ? t("terminal.creating")
            : profile.label}
        </button>
      ))}
    </div>
  );
}
