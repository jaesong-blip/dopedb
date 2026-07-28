// Dense tabs for settings and database-property panels. The active state is
// expressed with ARIA so one canonical class contract serves every consumer.
import type { ReactNode } from "react";

export type PanelTab<T extends string> = {
  id: T;
  label: ReactNode;
  disabled?: boolean;
};

export function PanelTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly PanelTab<T>[];
  active: T;
  onChange: (tab: T) => void;
  label: string;
}) {
  return (
    <div
      className="tw:flex tw:min-w-0 tw:shrink-0 tw:items-end tw:gap-1 tw:overflow-x-auto tw:border-b tw:border-border-subtle tw:bg-card tw:px-3"
      role="tablist"
      aria-label={label}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          disabled={tab.disabled}
          className="tw:relative tw:h-control-lg tw:shrink-0 tw:cursor-pointer tw:border-0 tw:bg-transparent tw:px-3 tw:font-sans tw:text-sm tw:text-muted-foreground tw:after:absolute tw:after:right-2 tw:after:bottom-0 tw:after:left-2 tw:after:h-0.5 tw:after:bg-transparent tw:aria-selected:text-foreground tw:aria-selected:after:bg-primary tw:disabled:cursor-default tw:disabled:opacity-40 tw:hover:text-foreground"
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
