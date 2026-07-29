import type { ReactNode } from "react";

import { Icon } from "../../components/Icon";
import { useI18n, type I18nKey } from "../../lib/i18n";

export type AppArea = "workspace" | "dashboard";

export default function WorkbenchRail({
  area,
  dashboardAvailable,
  settingsOpen,
  sidebarExpanded,
  account,
  onArea,
  onSettings,
}: {
  area: AppArea | null;
  dashboardAvailable: boolean;
  settingsOpen: boolean;
  sidebarExpanded: boolean;
  account: ReactNode;
  onArea: (area: AppArea) => void;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  const items: Array<{
    id: AppArea;
    icon: "database" | "dashboard";
    label: I18nKey;
  }> = [
    { id: "workspace", icon: "database", label: "workspace.label" },
    { id: "dashboard", icon: "dashboard", label: "tabs.dashboard" },
  ];

  return (
    <nav
      className="workbench-rail tw:hidden tw:min-w-0 tw:items-center tw:text-muted-foreground tw:max-[561px]:fixed tw:max-[561px]:right-0 tw:max-[561px]:bottom-0 tw:max-[561px]:left-0 tw:max-[561px]:z-[var(--ds-z-modal)] tw:max-[561px]:flex tw:max-[561px]:h-12 tw:max-[561px]:w-full tw:max-[561px]:flex-row tw:max-[561px]:justify-between tw:max-[561px]:border-t tw:max-[561px]:border-sidebar-border tw:max-[561px]:bg-card tw:max-[561px]:px-2 tw:max-[561px]:py-1"
      aria-label={t("app.workbenchNavigation")}
      onKeyDown={(event) => {
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
          return;
        }
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ".workbench-rail-button:not(:disabled), [data-rail-control]:not(:disabled)",
          ),
        ];
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        if (current < 0) return;
        event.preventDefault();
        const direction =
          event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
        buttons[(current + direction + buttons.length) % buttons.length]?.focus();
      }}
    >
      <div
        className="tw:hidden"
        data-window-controls-safe-zone
        data-tauri-drag-region="deep"
        aria-hidden="true"
      />
      <div className="tw:hidden">d</div>
      <div className="tw:grid tw:justify-items-center tw:gap-2 tw:max-[561px]:min-w-0 tw:max-[561px]:flex tw:max-[561px]:items-center tw:max-[561px]:gap-1 tw:max-[561px]:overflow-x-auto">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-active={area === item.id}
            className="workbench-rail-button tw:relative tw:grid tw:size-control-lg tw:cursor-pointer tw:place-items-center tw:rounded-xs tw:border-0 tw:bg-transparent tw:p-0 tw:text-[length:var(--ds-icon-md)] tw:text-inherit tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:disabled:cursor-not-allowed tw:disabled:opacity-40 tw:hover:bg-primary/10 tw:hover:text-primary tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
            onClick={() => onArea(item.id)}
            title={t(item.label)}
            aria-label={t(item.label)}
            aria-current={area === item.id ? "page" : undefined}
            aria-controls="workbench-sidebar"
            aria-expanded={area === item.id ? sidebarExpanded : undefined}
            disabled={item.id === "dashboard" && !dashboardAvailable}
          >
            <Icon name={item.icon} />
          </button>
        ))}
      </div>
      <div className="tw:mt-auto tw:grid tw:justify-items-center tw:gap-2 tw:max-[561px]:ml-1 tw:max-[561px]:mt-0 tw:max-[561px]:flex tw:max-[561px]:shrink-0 tw:max-[561px]:items-center tw:max-[561px]:gap-1">
        {account}
        <button
          type="button"
          data-active={settingsOpen}
          className="workbench-rail-button tw:relative tw:grid tw:size-control-lg tw:cursor-pointer tw:place-items-center tw:rounded-xs tw:border-0 tw:bg-transparent tw:p-0 tw:text-[length:var(--ds-icon-md)] tw:text-inherit tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:disabled:cursor-not-allowed tw:disabled:opacity-40 tw:hover:bg-primary/10 tw:hover:text-primary tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
          onClick={onSettings}
          title={t("common.settings")}
          aria-label={t("common.settings")}
          aria-current={settingsOpen ? "page" : undefined}
        >
          <Icon name="gear" />
        </button>
      </div>
    </nav>
  );
}
