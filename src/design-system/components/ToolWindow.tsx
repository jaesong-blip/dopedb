// Canonical dense tool-window primitives shared by explorer, assistant, and
// provider surfaces. Consumers provide content and actions, while this module
// owns the repeated DopeDB-style spacing and interaction contract.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function ToolWindowHeader({
  title,
  actions,
}: {
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="tw:flex tw:min-h-control-lg tw:shrink-0 tw:items-center tw:justify-between tw:gap-2 tw:border-b tw:border-border-subtle tw:bg-card tw:px-2 tw:text-sm">
      <strong className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
        {title}
      </strong>
      {actions ? (
        <div className="tw:flex tw:items-center tw:gap-[2px]">{actions}</div>
      ) : null}
    </header>
  );
}

export function ToolWindowSection({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="tw:grid tw:gap-[2px]">
      <h3 className="tw:mt-0 tw:mb-1 tw:px-2 tw:text-xs tw:font-semibold tw:tracking-[0.03em] tw:text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ToolWindowAction({
  leading,
  trailing,
  selected = false,
  children,
  ...buttonProps
}: {
  leading: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      className="tw:grid tw:min-h-control-md tw:w-full tw:cursor-pointer tw:grid-cols-[20px_minmax(0,1fr)_16px] tw:items-center tw:gap-2 tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-2 tw:font-sans tw:text-left tw:text-sm tw:text-foreground tw:aria-pressed:bg-selection tw:aria-pressed:text-selection-foreground tw:disabled:cursor-progress tw:disabled:opacity-50 tw:hover:bg-muted"
      aria-pressed={selected}
      {...buttonProps}
    >
      {leading}
      <span className="tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
        {children}
      </span>
      <span className="tw:text-xs tw:text-muted-foreground">{trailing}</span>
    </button>
  );
}
