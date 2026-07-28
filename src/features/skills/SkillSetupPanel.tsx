import { useEffect, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toast";
import { useI18n, type I18nKey } from "../../lib/i18n";
import SkillSetupTerminal from "./SkillSetupTerminal";
import type {
  SkillSetupAction,
  SkillSetupPlan,
} from "./setupPolicy";

const actionTitle: Record<Exclude<SkillSetupAction, "none" | "attention">, I18nKey> = {
  install: "agentTools.setupInstallTitle",
  update: "agentTools.setupUpdateTitle",
  "install-and-update": "agentTools.setupMixedTitle",
};

interface SkillSetupPanelProps {
  plan: SkillSetupPlan;
  onClose: () => void;
}

export default function SkillSetupPanel({
  plan,
  onClose,
}: SkillSetupPanelProps) {
  const { t } = useI18n();
  const toast = useToast();
  const copyTimerRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }

    window.addEventListener("keydown", closeWithEscape, true);
    return () => window.removeEventListener("keydown", closeWithEscape, true);
  }, [onClose]);

  if (
    !plan.command ||
    plan.action === "none" ||
    plan.action === "attention"
  ) {
    return null;
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(plan.command!);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast(t("agentTools.setupCopyFailed"), "error");
    }
  }

  return (
    <section
      className="tw:my-4 tw:min-w-0 tw:border-y tw:border-border-strong tw:py-4"
      aria-labelledby="skill-setup-title"
      data-ui-boundary
    >
      <header className="tw:flex tw:items-center tw:justify-between tw:gap-3">
        <div className="tw:min-w-0">
          <span className="tw:mb-1 tw:block tw:text-xs tw:leading-body tw:font-semibold tw:tracking-[0.06em] tw:text-muted-foreground tw:uppercase">
            {t("agentTools.setupKicker")}
          </span>
          <h3
            className="tw:m-0 tw:text-title tw:leading-ui tw:font-bold tw:tracking-[0.05em] tw:text-foreground tw:uppercase"
            id="skill-setup-title"
          >
            {t(actionTitle[plan.action])}
          </h3>
        </div>
        <button
          type="button"
          className="btn small icon-only icon-xs tw:shrink-0"
          aria-label={t("agentTools.setupClose")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <p className="tw:mt-2 tw:mb-0 tw:text-muted-foreground">
        {t("agentTools.setupSummary", {
          targets: plan.targets.map((target) => target.displayName).join(", "),
        })}
      </p>
      <div className="tw:mt-3 tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-background tw:py-2 tw:pr-2 tw:pl-3 tw:@max-[520px]:items-stretch">
        <code className="tw:min-w-0 tw:flex-1 tw:overflow-x-auto tw:font-mono tw:text-ui tw:text-foreground tw:whitespace-nowrap tw:[scrollbar-width:thin]">
          {plan.command}
        </code>
        <button
          type="button"
          className="btn small icon-only tw:shrink-0"
          aria-label={t("agentTools.setupCopyCommand")}
          onClick={() => void copyCommand()}
        >
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </div>
      <p className="tw:mt-2 tw:mb-0 tw:flex tw:items-center tw:gap-2 tw:text-xs tw:leading-body tw:text-muted-foreground">
        <Icon name="info" className="tw:size-[var(--ds-icon-sm)] tw:shrink-0" />
        <span>{t("agentTools.setupSafety")}</span>
      </p>
      <SkillSetupTerminal command={plan.command} />
    </section>
  );
}
