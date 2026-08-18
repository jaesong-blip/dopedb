// Canonical vertical category navigation for dense desktop dialogs. The rail
// owns icon geometry, selected state, tooltip parity, and roving keyboard focus.
import type { KeyboardEvent, ReactNode } from "react";

import { Button } from "./Button";
import { moveTabFocus } from "../tabKeyboard";

export type IconRailTab<T extends string> = {
  id: T;
  icon: ReactNode;
  label: string;
  disabled?: boolean;
};

function moveRailFocus(
  event: KeyboardEvent<HTMLButtonElement>,
  direction: "end" | "next" | "previous" | "start",
) {
  moveTabFocus(event, direction);
}

export function IconRailTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly IconRailTab<T>[];
  active: T;
  onChange: (tab: T) => void;
  label: string;
}) {
  return (
    <div
      className="tw:flex tw:w-[42px] tw:shrink-0 tw:flex-col tw:items-center tw:gap-1 tw:border-r tw:border-border-subtle tw:bg-card tw:py-1"
      role="tablist"
      aria-label={label}
      aria-orientation="vertical"
    >
      {tabs.map((tab) => {
        const selected = active === tab.id;
        return (
          <Button
            key={tab.id}
            iconOnly
            size="compact"
            variant="ghost"
            active={selected}
            role="tab"
            aria-selected={selected}
            disabled={tab.disabled}
            tabIndex={selected ? 0 : -1}
            title={tab.label}
            aria-label={tab.label}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                moveRailFocus(event, "next");
              } else if (
                event.key === "ArrowUp" ||
                event.key === "ArrowLeft"
              ) {
                moveRailFocus(event, "previous");
              } else if (event.key === "Home") {
                moveRailFocus(event, "start");
              } else if (event.key === "End") {
                moveRailFocus(event, "end");
              }
            }}
          >
            {tab.icon}
          </Button>
        );
      })}
    </div>
  );
}
