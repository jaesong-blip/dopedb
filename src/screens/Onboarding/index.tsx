// Welcome document. Only commands with a real application owner
// appear here; provider setup and Agent actions stay in their tool windows.
import { useI18n } from "../../lib/i18n";
import { Button } from "../../design-system/components/Button";
import { ProductAnalyticsConsentPrompt } from "../../features/productAnalytics/ConsentPrompt";

export default function Onboarding({
  connectionName,
  creatingDemo = false,
  guidedDemoAvailable = false,
  guidedDemo,
  onCreateDemoDatabase,
  onNewConnection,
  onNewQuery,
  onActionSearch,
}: {
  connectionName?: string;
  creatingDemo?: boolean;
  guidedDemoAvailable?: boolean;
  guidedDemo?: {
    writeEnabled: boolean;
    onBrowseOrders: () => void;
    onAnalyzeRevenue: () => void;
    onPracticeApproval: () => void;
    onOpenSafety: () => void;
  };
  onCreateDemoDatabase?: () => void;
  onNewConnection: () => void;
  onNewQuery?: () => void;
  onActionSearch: (returnFocus?: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  const connected = Boolean(connectionName);
  const commands = [
    ...(guidedDemo
      ? [
          {
            id: "demo-browse-orders",
            label: t("onboarding.demoBrowseOrders"),
            onClick: guidedDemo.onBrowseOrders,
          },
          {
            id: "demo-analyze-revenue",
            label: t("onboarding.demoAnalyzeRevenue"),
            onClick: guidedDemo.onAnalyzeRevenue,
          },
          {
            id: "demo-practice-approval",
            label: guidedDemo.writeEnabled
              ? t("onboarding.demoPracticeApproval")
              : t("onboarding.demoEnableWrites"),
            onClick: guidedDemo.writeEnabled
              ? guidedDemo.onPracticeApproval
              : guidedDemo.onOpenSafety,
          },
        ]
      : []),
    ...(connected && onNewQuery
      ? [
          {
            id: "new-query",
            label: t("ide.action.newQuery"),
            onClick: onNewQuery,
          },
        ]
      : []),
    {
      id: "new-data-source",
      label: t("connections.new"),
      onClick: onNewConnection,
    },
    ...(!connected && onCreateDemoDatabase
      ? [
          {
            id: "create-demo-sqlite",
            label: creatingDemo
              ? t(
                  guidedDemoAvailable
                    ? "onboarding.demoStarting"
                    : "connections.demoCreating",
                )
              : t(
                  guidedDemoAvailable
                    ? "onboarding.demoStart"
                    : "connections.demoSqlite",
                ),
            disabled: creatingDemo,
            onClick: onCreateDemoDatabase,
          },
        ]
      : []),
    {
      id: "search-everywhere",
      label: t("ide.action.actionSearch"),
      shortcut: "Shift ×2",
      onClick: onActionSearch,
    },
  ] as const;

  return (
    <div className="tw:flex tw:h-full tw:min-h-0 tw:flex-col tw:overflow-hidden tw:bg-editor">
      <div className="tw:grid tw:min-h-0 tw:flex-1 tw:place-items-center tw:overflow-auto tw:p-5">
        <main className="tw:w-full tw:max-w-[320px]">
          <h1 className="tw:sr-only">{t("onboarding.title")}</h1>
          <ProductAnalyticsConsentPrompt />
          {!connected || guidedDemo ? (
            <p className="tw:mt-0 tw:mb-3 tw:text-center tw:text-sm tw:leading-body tw:text-muted-foreground">
              {t(
                guidedDemo
                  ? "onboarding.demoLead"
                  : "onboarding.firstRunLead",
              )}
            </p>
          ) : null}
          <div className="tw:grid tw:gap-1" aria-label={t("onboarding.title")}>
            {commands.map((command) => (
              <Button
                key={command.id}
                presentation="menuItem"
                size="compact"
                variant="ghost"
                disabled={"disabled" in command && command.disabled}
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  command.onClick(event.currentTarget);
                }}
              >
                <span className="tw:flex tw:w-full tw:min-w-0 tw:items-center tw:justify-between tw:gap-4">
                  <span className="tw:truncate">{command.label}</span>
                  {"shortcut" in command ? (
                    <span className="tw:shrink-0 tw:font-mono tw:text-xs tw:font-normal tw:text-muted-foreground">
                      {command.shortcut}
                    </span>
                  ) : null}
                </span>
              </Button>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
