// Canonical flat popup-menu surface and items. Menus use rows, not nested
// button boxes, and own the same hover/focus/disabled behavior everywhere.
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

export function PopupMenu({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      role="menu"
      className="tw:absolute tw:top-[calc(100%+var(--ds-popover-offset))] tw:right-0 tw:z-[var(--ds-z-popover)] tw:grid tw:max-h-[min(360px,calc(100dvh-var(--ds-space-6)))] tw:w-[min(220px,calc(100cqw-var(--ds-space-6)))] tw:min-w-[176px] tw:gap-[2px] tw:overflow-y-auto tw:overscroll-contain tw:rounded-sm tw:border tw:border-border-subtle tw:bg-popover tw:p-1 tw:shadow-popover"
    >
      {children}
    </div>
  );
}

export function PopupMenuItem({
  children,
  ...props
}: {
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">) {
  return (
    <button
      type="button"
      role="menuitem"
      className="tw:flex tw:min-h-control-md tw:w-full tw:cursor-pointer tw:items-center tw:gap-2 tw:rounded-sm tw:border-0 tw:bg-transparent tw:px-2 tw:font-sans tw:text-left tw:text-sm tw:leading-body tw:text-foreground tw:data-[tone=danger]:text-danger tw:disabled:cursor-default tw:disabled:opacity-40 tw:hover:bg-muted tw:focus-visible:bg-muted tw:focus-visible:outline-none"
      {...props}
    >
      {children}
    </button>
  );
}

export function PopupMenuCheckbox({
  children,
  ...props
}: {
  children: ReactNode;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "children" | "type"
>) {
  return (
    <label
      role="menuitemcheckbox"
      aria-checked={Boolean(props.checked)}
      className="tw:flex tw:min-h-control-md tw:cursor-pointer tw:items-center tw:gap-2 tw:rounded-sm tw:px-2 tw:text-sm tw:leading-body tw:text-foreground tw:hover:bg-muted"
    >
      <input type="checkbox" className="tw:size-4 tw:accent-primary" {...props} />
      <span>{children}</span>
    </label>
  );
}
