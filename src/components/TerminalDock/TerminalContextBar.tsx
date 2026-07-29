// Displays immutable session scope and lifecycle controls above the PTY surface.
// The parent already scopes tabs to the selected connection, so this bar never retargets.
import type { SkillInstallState } from "../../ipc/types";
import type { TerminalSessionSummary } from "../../features/terminals/domain";
import { terminalSessionIsRunning } from "../../features/terminals/state";
import { Button } from "../../design-system/components/Button";
import { EnvironmentBadge } from "../../design-system/components/EnvironmentBadge";
import {
  InlineNotice,
  StatusBadge,
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
        tone: "success" as const,
        icon: "check" as const,
        label: t("terminal.skillReady"),
      };
    }
    if (skillState === null) {
      return {
        tone: "warning" as const,
        icon: "alert" as const,
        label: t("terminal.skillChecking"),
      };
    }
    if (skillState === "missing") {
      return {
        tone: "warning" as const,
        icon: "alert" as const,
        label: t("terminal.skillMissing"),
      };
    }
    return {
      tone: "warning" as const,
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
        <StatusBadge density="compact">
          <Icon name="database" />
          {t("terminal.pinned", {
            name: active.connection.connectionName,
          })}
        </StatusBadge>
        {active.connection.environment && (
          <EnvironmentBadge environment={active.connection.environment} />
        )}
        <StatusBadge
          density="compact"
          tone={
            active.connection.policy === "readOnly"
              ? "success"
              : "warning"
          }
        >
          {active.connection.policy === "readOnly"
            ? t("terminal.readOnly")
            : t("terminal.approvalRequired")}
        </StatusBadge>
        {active.profile !== "shell" && (
          <StatusBadge density="compact" tone={skillBadge.tone}>
            <Icon name={skillBadge.icon} />
            {skillBadge.label}
          </StatusBadge>
        )}
        <span className="tw:min-w-1 tw:flex-1" />
        <Button
          iconOnly
          size="compact"
          variant="ghost"
          onClick={onRename}
          title={t("terminal.rename")}
          aria-label={t("terminal.rename")}
        >
          <Icon name="pencil" />
        </Button>
        {terminalSessionIsRunning(active) ? (
          <Button size="compact" onClick={onStop}>
            {t("terminal.stop")}
          </Button>
        ) : (
          <Button size="compact" onClick={onRestart}>
            <Icon name="refresh" />
            {t("terminal.restart")}
          </Button>
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
