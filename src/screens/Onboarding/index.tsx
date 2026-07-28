// First-run onboarding — shown when no database is connected yet. Instead of a blank
// screen, guide the user to connect a database or install the local Agent tools.
import { useI18n } from "../../lib/i18n";
import { Icon, type IconName } from "../../components/Icon";

export default function Onboarding({
  onNewConnection,
  onOpenAgentTools,
  onCreateDemoDatabase,
  creatingDemo,
}: {
  onNewConnection: () => void;
  onOpenAgentTools: () => void;
  onCreateDemoDatabase: () => void;
  creatingDemo: boolean;
}) {
  const { t } = useI18n();
  const actions: Array<{
    key: string;
    icon: IconName;
    label: string;
    onClick: () => void;
    disabled?: boolean;
  }> = [
    {
      key: "connection",
      icon: "database",
      label: t("onboarding.startWithConnection"),
      onClick: onNewConnection,
    },
    {
      key: "agent",
      icon: "terminal",
      label: t("tabs.agent"),
      onClick: onOpenAgentTools,
    },
    {
      key: "demo",
      icon: "download",
      label: creatingDemo
        ? t("onboarding.demoCreating")
        : t("onboarding.demoAction"),
      onClick: onCreateDemoDatabase,
      disabled: creatingDemo,
    },
  ];
  const guides: Array<{
    icon: IconName;
    title: string;
    body: string;
  }> = [
    {
      icon: "database",
      title: t("onboarding.databaseTitle"),
      body: t("onboarding.databaseBody"),
    },
    {
      icon: "table",
      title: t("onboarding.demoAction"),
      body: t("onboarding.demoBody"),
    },
    {
      icon: "terminal",
      title: t("onboarding.agentTitle"),
      body: t("onboarding.agentBody"),
    },
  ];

  return (
    <div className="tw:grid tw:h-full tw:place-items-center tw:overflow-auto tw:bg-editor tw:p-[clamp(var(--ds-space-5),4vw,52px)] tw:@max-[760px]:place-items-start tw:@max-[760px]:p-5">
      <div className="tw:w-full tw:max-w-[720px] tw:text-center">
        <div
          className="tw:mx-auto tw:mb-3 tw:grid tw:size-[42px] tw:place-items-center tw:rounded-sm tw:border tw:border-border-strong tw:bg-secondary tw:font-mono tw:text-heading tw:font-bold tw:text-foreground"
          aria-hidden="true"
        >
          D
        </div>
        <h1 className="tw:mt-0 tw:mb-2 tw:text-[clamp(24px,2.6vw,32px)] tw:leading-tight tw:tracking-[-0.025em]">
          {t("onboarding.title")}
        </h1>
        <p className="tw:mx-auto tw:mt-0 tw:mb-5 tw:max-w-[58ch] tw:text-ui tw:leading-body tw:text-muted-foreground">
          {t("onboarding.lead")}
        </p>

        <div className="tw:grid tw:grid-cols-3 tw:gap-3 tw:@max-[760px]:grid-cols-1">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="tw:flex tw:min-h-[92px] tw:cursor-pointer tw:flex-col tw:items-center tw:justify-center tw:gap-2 tw:rounded-md tw:border tw:border-border-strong tw:bg-secondary tw:p-3 tw:font-sans tw:text-ui tw:text-foreground tw:transition tw:duration-150 tw:hover:-translate-y-px tw:hover:border-ring tw:hover:bg-selection tw:disabled:cursor-progress tw:disabled:opacity-50 tw:@max-[760px]:min-h-control-xl tw:@max-[760px]:flex-row"
              onClick={action.onClick}
              disabled={action.disabled}
            >
              <Icon name={action.icon} className="tw:text-2xl tw:text-info" />
              <span>{action.label}</span>
            </button>
          ))}
        </div>

        <section className="tw:mt-5 tw:flex tw:items-center tw:justify-between tw:gap-5 tw:rounded-md tw:border tw:border-border-strong tw:bg-card tw:p-4 tw:text-left tw:@max-[760px]:flex-col tw:@max-[760px]:items-start">
          <div className="tw:grid tw:gap-1">
            <span className="tw:font-mono tw:text-xs tw:font-bold tw:text-info">
              01
            </span>
            <h2 className="tw:m-0 tw:text-title">
              {t("onboarding.quickTour")}
            </h2>
            <p className="tw:m-0 tw:max-w-[52ch] tw:text-sm tw:leading-body tw:text-muted-foreground">
              {t("onboarding.quickTourBody")}
            </p>
          </div>
          <button className="btn primary" onClick={onNewConnection}>
            <Icon name="play" />
            {t("onboarding.addConnection")}
          </button>
        </section>

        <div className="tw:mt-4 tw:grid tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle tw:text-left">
          {guides.map((guide) => (
            <div
              key={guide.title}
              className="tw:grid tw:grid-cols-[28px_minmax(0,1fr)] tw:gap-3 tw:px-1 tw:py-3"
            >
              <Icon
                name={guide.icon}
                className="tw:mt-[var(--ds-optical-offset-xs)] tw:text-[length:var(--ds-icon-md)] tw:text-muted-foreground"
              />
              <div>
                <strong className="tw:text-ui">{guide.title}</strong>
                <p className="tw:mt-1 tw:mb-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                  {guide.body}
                </p>
              </div>
            </div>
          ))}
        </div>

        <footer className="tw:mt-3 tw:flex tw:items-center tw:justify-between tw:gap-3 tw:text-left tw:text-xs tw:text-muted-foreground tw:@max-[760px]:flex-col tw:@max-[760px]:items-start">
          <button
            type="button"
            className="tw:inline-flex tw:cursor-pointer tw:items-center tw:gap-1 tw:border-0 tw:bg-transparent tw:p-0 tw:font-sans tw:text-muted-foreground tw:hover:text-foreground"
            onClick={onOpenAgentTools}
          >
            <Icon name="gear" />
            {t("onboarding.setupAgentTools")}
          </button>
          <span>{t("onboarding.foot")}</span>
        </footer>
      </div>
    </div>
  );
}
