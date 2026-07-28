// Dense tree controls shared by Database Explorer-style tool windows. These
// primitives own keyboard toggling and search chrome so feature trees only
// provide domain labels and results.
import type { ReactNode } from "react";

import { Icon, type IconName } from "../../components/Icon";

export function TreeSectionButton({
  expanded,
  icon,
  children,
  onToggle,
  danger = false,
}: {
  expanded: boolean;
  icon: IconName;
  children: ReactNode;
  onToggle: () => void;
  danger?: boolean;
}) {
  return (
    <div
      className={
        danger
          ? "tw:flex tw:min-h-control-sm tw:cursor-pointer tw:select-none tw:items-center tw:gap-1 tw:px-1 tw:py-px tw:text-sm tw:font-medium tw:text-danger"
          : "tw:flex tw:min-h-control-sm tw:cursor-pointer tw:select-none tw:items-center tw:gap-1 tw:px-1 tw:py-px tw:text-sm tw:font-normal tw:text-foreground tw:hover:bg-muted"
      }
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="tw:grid tw:w-[var(--ds-icon-sm)] tw:shrink-0 tw:place-items-center tw:text-2xs">
        <Icon name={expanded ? "chevronDown" : "chevronRight"} />
      </span>
      <Icon
        name={icon}
        className="tw:shrink-0 tw:text-[length:var(--ds-icon-sm)]"
      />
      <span>{children}</span>
    </div>
  );
}

export function TreeSearch({
  value,
  placeholder,
  clearLabel,
  onChange,
}: {
  value: string;
  placeholder: string;
  clearLabel: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="tw:relative tw:block tw:min-w-0">
      <Icon
        name="search"
        className="tw:pointer-events-none tw:absolute tw:top-1/2 tw:left-2 tw:-translate-y-1/2 tw:text-xs tw:text-muted-foreground"
      />
      <input
        className="ide-explorer-search tw:h-control-sm tw:w-full tw:rounded-xs tw:border tw:border-input tw:bg-background tw:pr-7 tw:pl-7 tw:font-sans tw:text-sm tw:text-foreground tw:outline-none tw:placeholder:text-muted-foreground tw:focus:border-ring"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="tw:absolute tw:top-1/2 tw:right-1 tw:grid tw:size-6 tw:-translate-y-1/2 tw:cursor-pointer tw:place-items-center tw:rounded-xs tw:border-0 tw:bg-transparent tw:text-xs tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground"
          onClick={() => onChange("")}
          title={clearLabel}
          aria-label={clearLabel}
        >
          <Icon name="close" />
        </button>
      ) : null}
    </label>
  );
}
