// First-run right tool window. It mirrors DopeDB's persistent assistant
// placement while routing configuration into DopeDB's existing local Agent
// tooling and trust controls.
import { Icon } from "../../components/Icon";
import { ToolWindowHeader } from "../../design-system/components/ToolWindow";
import { useI18n } from "../../lib/i18n";

export default function WelcomeAssistantPane({
  onOpenAgentTools,
}: {
  onOpenAgentTools: () => void;
}) {
  const { t } = useI18n();

  return (
    <aside
      className="ide-assistant-welcome tw:m-1 tw:ml-0 tw:flex tw:min-w-0 tw:flex-col tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background"
      aria-label={t("tabs.agent")}
    >
      <ToolWindowHeader
        title={t("tabs.agent")}
        actions={
          <button
            type="button"
            className="btn small icon-only icon-xs"
            onClick={onOpenAgentTools}
            title={t("common.settings")}
            aria-label={t("common.settings")}
          >
            <Icon name="gear" />
          </button>
        }
      />
      <div className="tw:grid tw:min-h-0 tw:flex-1 tw:content-center tw:justify-items-center tw:gap-3 tw:p-5 tw:text-center tw:text-muted-foreground">
        <Icon name="terminal" className="tw:text-[28px] tw:text-info" />
        <strong className="tw:text-title tw:text-foreground">
          {t("ide.agentReadyTitle")}
        </strong>
        <p className="tw:m-0 tw:max-w-[34ch] tw:text-sm tw:leading-body">
          {t("ide.agentReadyBody")}
        </p>
        <ul className="tw:mt-3 tw:mb-0 tw:grid tw:list-none tw:gap-2 tw:p-0 tw:text-left tw:text-xs">
          <li className="tw:before:mr-2 tw:before:text-success tw:before:content-['✓']">
            {t("ide.agentCapabilitySchema")}
          </li>
          <li className="tw:before:mr-2 tw:before:text-success tw:before:content-['✓']">
            {t("ide.agentCapabilityQuery")}
          </li>
          <li className="tw:before:mr-2 tw:before:text-success tw:before:content-['✓']">
            {t("ide.agentCapabilityApproval")}
          </li>
        </ul>
      </div>
      <button
        type="button"
        className="tw:m-2 tw:flex tw:min-h-16 tw:cursor-pointer tw:items-center tw:justify-between tw:gap-2 tw:rounded-md tw:border tw:border-border-strong tw:bg-card tw:px-3 tw:font-sans tw:text-sm tw:text-muted-foreground tw:hover:border-ring tw:hover:text-foreground"
        onClick={onOpenAgentTools}
      >
        <span>{t("ide.agentPrompt")}</span>
        <Icon name="arrowRight" />
      </button>
    </aside>
  );
}
