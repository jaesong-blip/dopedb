// DopeDB-style Welcome document. Creation actions stay in Database Explorer,
// and Agent actions stay in AI Chat, so the center does not duplicate tool windows.
import { useI18n } from "../../lib/i18n";
import { Icon, type IconName } from "../../components/Icon";

export default function Onboarding({
  embedded = false,
  connectionName,
}: {
  embedded?: boolean;
  connectionName?: string;
}) {
  const { t } = useI18n();
  const connected = Boolean(connectionName);
  const guides: ReadonlyArray<{
    icon: IconName;
    title: string;
    body: string;
  }> = [
    {
      icon: "database",
      title: t("onboarding.explorerTitle"),
      body: t(
        connected
          ? "onboarding.connectedExplorerBody"
          : "onboarding.explorerBody",
      ),
    },
    {
      icon: "search",
      title: t("onboarding.searchTitle"),
      body: t("onboarding.searchBody"),
    },
    {
      icon: "check",
      title: t("onboarding.safetyTitle"),
      body: t("onboarding.safetyBody"),
    },
  ];

  return (
    <div className="tw:flex tw:h-full tw:min-h-0 tw:flex-col tw:overflow-hidden tw:bg-editor">
      {!embedded && (
        <header className="tw:flex tw:min-h-9 tw:shrink-0 tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:bg-card tw:px-3 tw:text-sm">
          <span className="tw:grid tw:size-5 tw:place-items-center tw:rounded-xs tw:bg-secondary tw:font-mono tw:text-xs tw:font-bold">
            D
          </span>
          <span>{t("ide.noDataSource")}</span>
        </header>
      )}
      <div className="tw:grid tw:min-h-0 tw:flex-1 tw:place-items-center tw:overflow-auto tw:p-[clamp(var(--ds-space-5),5vw,64px)]">
        <main className="tw:w-full tw:max-w-[560px]">
          <div className="tw:mb-7 tw:text-center">
            <div
              className="tw:mx-auto tw:mb-3 tw:grid tw:size-9 tw:place-items-center tw:rounded-sm tw:border tw:border-border-strong tw:bg-secondary tw:font-mono tw:text-title tw:font-bold"
              aria-hidden="true"
            >
              D
            </div>
            <h1 className="tw:mt-0 tw:mb-2 tw:text-heading tw:tracking-[-0.02em]">
              {t("onboarding.title")}
            </h1>
            <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
              {connected
                ? t("onboarding.connectedLead", {
                    connection: connectionName ?? "",
                  })
                : t("onboarding.lead")}
            </p>
          </div>

          <div className="tw:grid tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle">
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
          <p className="tw:mt-4 tw:mb-0 tw:text-center tw:text-xs tw:text-muted-foreground">
            {t(connected ? "onboarding.connectedFoot" : "onboarding.foot")}
          </p>
        </main>
      </div>
    </div>
  );
}
