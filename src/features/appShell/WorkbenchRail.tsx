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
      className="workbench-rail"
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
        className="workbench-window-controls-safe"
        data-window-controls-safe-zone
        data-tauri-drag-region="deep"
        aria-hidden="true"
      />
      <div className="workbench-rail-brand">d</div>
      <div className="workbench-rail-items">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`workbench-rail-button${area === item.id ? " active" : ""}`}
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
      <div className="workbench-rail-bottom">
        {account}
        <button
          type="button"
          className={`workbench-rail-button${settingsOpen ? " active" : ""}`}
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
