import { useEffect, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toast";
import { useI18n, type I18nKey } from "../../lib/i18n";
import SkillSetupTerminal from "./SkillSetupTerminal";
import type {
  SkillSetupAction,
  SkillSetupPlan,
} from "./setupPolicy";
import "./skillSetup.css";

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
    <section className="skill-setup-panel" aria-labelledby="skill-setup-title">
      <header className="skill-setup-panel-head">
        <div>
          <span className="skill-setup-kicker">
            {t("agentTools.setupKicker")}
          </span>
          <h3 id="skill-setup-title">{t(actionTitle[plan.action])}</h3>
        </div>
        <button
          type="button"
          className="btn small icon-only icon-xs"
          aria-label={t("agentTools.setupClose")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <p className="muted skill-setup-summary">
        {t("agentTools.setupSummary", {
          targets: plan.targets.map((target) => target.displayName).join(", "),
        })}
      </p>
      <div className="skill-setup-command">
        <code>{plan.command}</code>
        <button
          type="button"
          className="btn small icon-only"
          aria-label={t("agentTools.setupCopyCommand")}
          onClick={() => void copyCommand()}
        >
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </div>
      <p className="skill-setup-safety">
        <Icon name="info" />
        <span>{t("agentTools.setupSafety")}</span>
      </p>
      <SkillSetupTerminal command={plan.command} />
    </section>
  );
}
