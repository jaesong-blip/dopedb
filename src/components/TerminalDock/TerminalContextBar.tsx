// Displays immutable session scope and lifecycle controls above the PTY surface.
// Scope mismatch is explicit so a connection switch can never silently retarget a session.
import type {
  SkillInstallState,
  TerminalProfile,
  TerminalSessionSummary,
} from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import { Icon } from "../Icon";
import { useI18n } from "../../lib/i18n";
import { terminalSessionIsRunning } from "./terminalState";

interface TerminalContextBarProps {
  active: TerminalSessionSummary;
  connection: ConnectionProfile;
  skillState: SkillInstallState | null;
  mismatch: boolean;
  replayTruncated: boolean;
  creatingProfile: TerminalProfile | null;
  onRename: () => void;
  onStop: () => void;
  onRestart: () => void;
  onCreateForCurrent: () => void;
}

export default function TerminalContextBar({
  active,
  connection,
  skillState,
  mismatch,
  replayTruncated,
  creatingProfile,
  onRename,
  onStop,
  onRestart,
  onCreateForCurrent,
}: TerminalContextBarProps) {
  const { t } = useI18n();
  const lifecycleLabel = (() => {
    switch (active.lifecycle) {
      case "starting":
        return t("terminal.creating");
      case "running":
        return t("terminal.running");
      case "stopping":
        return t("terminal.stopping");
      case "failed":
        return t("terminal.failed");
      case "exited":
        return t("terminal.exitCode", {
          code: active.exit?.code ?? "—",
        });
    }
  })();
  const skillBadge = (() => {
    if (skillState === "managed_current") {
      return {
        className: "status-ok",
        icon: "check" as const,
        label: t("terminal.skillReady"),
      };
    }
    if (skillState === null) {
      return {
        className: "status-warning",
        icon: "alert" as const,
        label: t("terminal.skillChecking"),
      };
    }
    if (skillState === "missing") {
      return {
        className: "status-warning",
        icon: "alert" as const,
        label: t("terminal.skillMissing"),
      };
    }
    return {
      className: "status-warning",
      icon: "alert" as const,
      label: t("terminal.skillAttention"),
    };
  })();

  return (
    <>
      <div className="terminal-context-strip">
        <span
          className={`terminal-lifecycle ${active.lifecycle}`}
          title={lifecycleLabel}
        >
          <span
            className={`terminal-status-dot ${active.lifecycle}`}
            aria-hidden="true"
          />
          {lifecycleLabel}
        </span>
        <span className="badge">
          <Icon name="database" />
          {t("terminal.pinned", {
            name: active.connection.connectionName,
          })}
        </span>
        {active.connection.environment && (
          <span className="badge">{active.connection.environment}</span>
        )}
        <span
          className={`badge ${
            active.connection.policy === "readOnly"
              ? "status-ok"
              : "status-warning"
          }`}
        >
          {active.connection.policy === "readOnly"
            ? t("terminal.readOnly")
            : t("terminal.approvalRequired")}
        </span>
        {active.profile !== "shell" && (
          <span className={`badge ${skillBadge.className}`}>
            <Icon name={skillBadge.icon} />
            {skillBadge.label}
          </span>
        )}
        <span className="terminal-context-spacer" />
        <button
          type="button"
          className="btn small icon-only"
          onClick={onRename}
          title={t("terminal.rename")}
          aria-label={t("terminal.rename")}
        >
          <Icon name="pencil" />
        </button>
        {terminalSessionIsRunning(active) ? (
          <button type="button" className="btn small" onClick={onStop}>
            {t("terminal.stop")}
          </button>
        ) : (
          <button type="button" className="btn small" onClick={onRestart}>
            <Icon name="refresh" />
            {t("terminal.restart")}
          </button>
        )}
      </div>

      {mismatch && (
        <div className="terminal-notice warning">
          <Icon name="alert" />
          <span>
            <strong>{t("terminal.connectionMismatchTitle")}</strong>
            {t("terminal.connectionMismatchBody", {
              pinned: active.connection.connectionName,
              current: connection.name || t("app.unnamed"),
            })}
          </span>
          <button
            type="button"
            className="btn small"
            disabled={creatingProfile !== null}
            onClick={onCreateForCurrent}
          >
            {t("terminal.newForCurrent", {
              name: connection.name || t("app.unnamed"),
            })}
          </button>
        </div>
      )}

      {replayTruncated && (
        <div className="terminal-notice warning">
          <Icon name="info" />
          <span>{t("terminal.outputReplayTruncated")}</span>
        </div>
      )}
    </>
  );
}
