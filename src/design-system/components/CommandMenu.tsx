// Canonical searchable action popup. Feature screens supply real commands and
// grouping; this primitive owns the shared floating surface, search control,
// and dense result-row treatment.
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

export const CommandMenu = forwardRef<
  HTMLDivElement,
  {
    id?: string;
    label: string;
    searchLabel: string;
    searchPlaceholder: string;
    searchValue: string;
    onSearchChange: (value: string) => void;
    children: ReactNode;
  }
>(function CommandMenu(
  {
    id,
    label,
    searchLabel,
    searchPlaceholder,
    searchValue,
    onSearchChange,
    children,
  },
  ref,
) {
  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={label}
      className="tw:absolute tw:top-[calc(100%+var(--ds-popover-offset))] tw:left-0 tw:z-[var(--ds-z-popover)] tw:flex tw:max-h-[min(440px,calc(100dvh-var(--ds-space-6)))] tw:w-[min(320px,calc(100vw-var(--ds-space-6)))] tw:flex-col tw:overflow-hidden tw:rounded-md tw:border tw:border-border-strong tw:bg-popover tw:text-popover-foreground tw:shadow-popover"
    >
      <div className="tw:border-b tw:border-border-subtle tw:p-2">
        <input
          type="search"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label={searchLabel}
          placeholder={searchPlaceholder}
          autoFocus
          className="tw:h-control-lg tw:w-full tw:rounded-sm tw:border tw:border-input tw:bg-background tw:px-3 tw:font-sans tw:text-ui tw:text-foreground tw:shadow-control tw:outline-none tw:placeholder:text-muted-foreground tw:focus:border-ring tw:focus:ring-2 tw:focus:ring-ring/30"
        />
      </div>
      <div className="tw:grid tw:min-h-0 tw:gap-3 tw:overflow-y-auto tw:overscroll-contain tw:p-2">
        {children}
      </div>
    </div>
  );
});

export function CommandMenuGroup({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="tw:grid tw:gap-0.5">
      <h3 className="tw:px-2 tw:py-1 tw:text-xs tw:font-semibold tw:text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function CommandMenuItem({
  leading,
  trailing,
  description,
  children,
  ...props
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "children"
>) {
  return (
    <button
      type="button"
      className="tw:flex tw:min-h-control-lg tw:w-full tw:cursor-pointer tw:items-center tw:gap-2 tw:rounded-sm tw:border-0 tw:bg-transparent tw:px-2 tw:py-1.5 tw:font-sans tw:text-left tw:text-foreground tw:disabled:cursor-default tw:disabled:opacity-40 tw:hover:bg-muted tw:focus-visible:bg-muted tw:focus-visible:outline-none"
      {...props}
    >
      {leading ? (
        <span className="tw:grid tw:size-control-sm tw:shrink-0 tw:place-items-center">
          {leading}
        </span>
      ) : null}
      <span className="tw:grid tw:min-w-0 tw:flex-1 tw:gap-0.5">
        <span className="tw:truncate tw:text-sm">{children}</span>
        {description ? (
          <span className="tw:truncate tw:text-xs tw:text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className="tw:shrink-0 tw:text-xs tw:text-muted-foreground">
          {trailing}
        </span>
      ) : null}
    </button>
  );
}
