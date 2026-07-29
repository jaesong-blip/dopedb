// Canonical DopeDB-style application chrome surfaces. Feature code supplies
// commands and state; these primitives own the shared title/status geometry.
import type {
  ButtonHTMLAttributes,
  ReactNode,
  Ref,
} from "react";

export function IdeTitleToolbar({
  macosInset,
  context,
  launchers,
  launchersLabel,
  actions,
}: {
  macosInset: boolean;
  context: ReactNode;
  launchers: ReactNode;
  launchersLabel: string;
  actions: ReactNode;
}) {
  return (
    <header
      className="tw:relative tw:col-[1/-1] tw:row-start-1 tw:z-[var(--ds-z-sticky)] tw:flex tw:h-title-toolbar tw:min-w-0 tw:select-none tw:items-center tw:gap-1 tw:border-b tw:border-border-subtle tw:bg-card tw:bg-[image:var(--ds-title-toolbar-background)] tw:px-2 tw:text-muted-foreground"
      data-tauri-drag-region="deep"
    >
      {macosInset ? (
        <div className="tw:w-[68px] tw:shrink-0" aria-hidden="true" />
      ) : null}
      <div className="tw:min-w-0 tw:max-[561px]:hidden">{context}</div>
      <div
        className="tw:absolute tw:left-1/2 tw:flex tw:-translate-x-1/2 tw:items-center tw:gap-1"
        role="toolbar"
        aria-label={launchersLabel}
      >
        {launchers}
      </div>
      <div className="tw:ml-auto tw:flex tw:shrink-0 tw:items-center tw:gap-1">
        {actions}
      </div>
    </header>
  );
}

export function IdeToolbarLauncher({
  active,
  buttonRef,
  children,
  ...buttonProps
}: {
  active?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-active={active || undefined}
      aria-pressed={active === undefined ? undefined : active}
      className="tw:grid tw:size-control-md tw:shrink-0 tw:cursor-pointer tw:place-items-center tw:rounded-sm tw:border-0 tw:bg-transparent tw:text-base tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground tw:data-[active=true]:bg-muted tw:data-[active=true]:text-foreground tw:disabled:cursor-not-allowed tw:disabled:opacity-40 tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-inset tw:focus-visible:ring-ring"
      {...buttonProps}
    >
      {children}
    </button>
  );
}

export function IdeStatusBarSurface({
  label,
  breadcrumbs,
  children,
}: {
  label: string;
  breadcrumbs: ReactNode;
  children: ReactNode;
}) {
  return (
    <footer
      className="tw:col-[1/-1] tw:row-start-4 tw:z-[var(--ds-z-sticky)] tw:flex tw:h-status-bar tw:min-w-0 tw:items-center tw:overflow-hidden tw:border-t tw:border-border-subtle tw:bg-card tw:text-xs tw:leading-none tw:text-muted-foreground tw:max-[561px]:row-start-3"
      aria-label={label}
    >
      {breadcrumbs}
      <div className="tw:flex-1" />
      {children}
    </footer>
  );
}
