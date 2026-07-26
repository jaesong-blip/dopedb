// Displays immutable session scope and lifecycle controls above the PTY surface.
// The parent already scopes tabs to the selected connection, so this bar never retargets.
import type { SkillInstallState } from "../../ipc/types";
import type { TerminalSessionSummary } from "../../features/terminals/domain";
import { terminalSessionIsRunning } from "../../features/terminals/state";
import { Icon } from "../Icon";
import { useI18n } from "../../lib/i18n";

interface TerminalContextBarProps {
  active: TerminalSessionSummary;
  skillState: SkillInstallState | null;
  replayTruncated: boolean;
  onRename: () => void;
  onStop: () => void;
  onRestart: () => void;
}

export default function TerminalContextBar({
  active,
  skillState,
  replayTruncated,
  onRename,
  onStop,
  onRestart,
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

      {replayTruncated && (
        <div className="terminal-notice warning">
          <Icon name="info" />
          <span>{t("terminal.outputReplayTruncated")}</span>
        </div>
      )}
    </>
  );
}
