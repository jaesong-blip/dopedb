import { useEffect, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toast";
import { useI18n, type I18nKey } from "../../lib/i18n";
import SkillSetupTerminal from "./SkillSetupTerminal";
import type {
  SkillSetupAction,
  SkillSetupPlan,
} from "./setupPolicy";
import { skillSetupStyles } from "./styles";

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
      className={skillSetupStyles.panel}
      aria-labelledby="skill-setup-title"
      data-ui-boundary
    >
      <header className={skillSetupStyles.panelHead}>
        <div className={skillSetupStyles.panelHeadContent}>
          <span className={skillSetupStyles.kicker}>
            {t("agentTools.setupKicker")}
          </span>
          <h3 className={skillSetupStyles.title} id="skill-setup-title">
            {t(actionTitle[plan.action])}
          </h3>
        </div>
        <button
          type="button"
          className={`btn small icon-only icon-xs ${skillSetupStyles.fixedControl}`}
          aria-label={t("agentTools.setupClose")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <p className={`muted ${skillSetupStyles.summary}`}>
        {t("agentTools.setupSummary", {
          targets: plan.targets.map((target) => target.displayName).join(", "),
        })}
      </p>
      <div className={skillSetupStyles.command}>
        <code className={skillSetupStyles.commandCode}>{plan.command}</code>
        <button
          type="button"
          className={`btn small icon-only ${skillSetupStyles.fixedControl}`}
          aria-label={t("agentTools.setupCopyCommand")}
          onClick={() => void copyCommand()}
        >
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </div>
      <p className={skillSetupStyles.safety}>
        <Icon name="info" className={skillSetupStyles.safetyIcon} />
        <span>{t("agentTools.setupSafety")}</span>
      </p>
      <SkillSetupTerminal command={plan.command} />
    </section>
  );
}
