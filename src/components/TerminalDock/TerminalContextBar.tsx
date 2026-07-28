// Displays immutable session scope and lifecycle controls above the PTY surface.
// The parent already scopes tabs to the selected connection, so this bar never retargets.
import type { SkillInstallState } from "../../ipc/types";
import type { TerminalSessionSummary } from "../../features/terminals/domain";
import { terminalSessionIsRunning } from "../../features/terminals/state";
import { EnvironmentBadge } from "../../design-system/components/EnvironmentBadge";
import {
  InlineNotice,
  StatusDot,
} from "../../design-system/components/Status";
import { Icon } from "../Icon";
import { useI18n } from "../../lib/i18n";
import { terminalLifecycleTone } from "./TerminalTabs";

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
        tone: "success",
        icon: "check" as const,
        label: t("terminal.skillReady"),
      };
    }
    if (skillState === null) {
      return {
        tone: "warning",
        icon: "alert" as const,
        label: t("terminal.skillChecking"),
      };
    }
    if (skillState === "missing") {
      return {
        tone: "warning",
        icon: "alert" as const,
        label: t("terminal.skillMissing"),
      };
    }
    return {
      tone: "warning",
      icon: "alert" as const,
      label: t("terminal.skillAttention"),
    };
  })();

  return (
    <>
      <div
        data-terminal-context-bar
        className="terminal-context-strip tw:flex tw:min-w-0 tw:shrink-0 tw:items-center tw:gap-2 tw:overflow-x-auto tw:border-b tw:border-border-subtle tw:bg-background tw:p-2 tw:[scrollbar-width:thin] tw:max-[560px]:px-1"
      >
        <span
          className="tw:flex tw:shrink-0 tw:items-center tw:gap-1 tw:text-xs tw:text-muted-foreground tw:whitespace-nowrap"
          title={lifecycleLabel}
        >
          <StatusDot tone={terminalLifecycleTone(active.lifecycle)} />
          {lifecycleLabel}
        </span>
        <span className="badge tw:shrink-0 tw:max-w-[240px]">
          <Icon name="database" />
          {t("terminal.pinned", {
            name: active.connection.connectionName,
          })}
        </span>
        {active.connection.environment && (
          <EnvironmentBadge environment={active.connection.environment} />
        )}
        <span
          data-policy={active.connection.policy}
          className="badge tw:shrink-0 tw:max-w-[240px] tw:data-[policy=readOnly]:border-success tw:data-[policy=readOnly]:text-success tw:data-[policy=approvalRequired]:border-warning tw:data-[policy=approvalRequired]:text-warning"
        >
          {active.connection.policy === "readOnly"
            ? t("terminal.readOnly")
            : t("terminal.approvalRequired")}
        </span>
        {active.profile !== "shell" && (
          <span
            data-tone={skillBadge.tone}
            className="badge tw:shrink-0 tw:max-w-[240px] tw:data-[tone=success]:border-success tw:data-[tone=success]:text-success tw:data-[tone=warning]:border-warning tw:data-[tone=warning]:text-warning"
          >
            <Icon name={skillBadge.icon} />
            {skillBadge.label}
          </span>
        )}
        <span className="tw:min-w-1 tw:flex-1" />
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
        <InlineNotice tone="warning" icon="info">
          {t("terminal.outputReplayTruncated")}
        </InlineNotice>
      )}
    </>
  );
}
