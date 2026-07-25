// Session switcher and profile launcher for Shell, Codex, and Claude PTY sessions.
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
  profileMenuOpen: boolean;
  onActivate: (id: string) => void;
  onToggleProfileMenu: () => void;
  onCreate: (profile: TerminalProfile) => void;
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
  profileMenuOpen,
  onActivate,
  onToggleProfileMenu,
  onCreate,
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
    <div className="terminal-tabs-row">
      <div
        className="terminal-session-tabs ds-control-row"
        role="tablist"
        aria-label={t("terminal.sessions")}
      >
        {sessions.map((session, index) => (
          <button
            key={session.id}
            id={`terminal-tab-${session.id}`}
            type="button"
            className="terminal-session-tab"
            role="tab"
            aria-selected={session.id === activeId}
            aria-controls={
              session.id === activeId
                ? `terminal-panel-${session.id}`
                : undefined
            }
            tabIndex={session.id === activeId ? 0 : -1}
            onClick={() => onActivate(session.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                activateTab((index - 1 + sessions.length) % sessions.length);
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
        ))}
      </div>
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
    </div>
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
